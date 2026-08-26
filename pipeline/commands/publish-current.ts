import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import 'dotenv/config';
import { Pool, type PoolClient } from 'pg';
import { buildStructuredDirectoryContacts } from '../../src/directory/structured-contacts';
import { shuttleSchedule, type ShuttleRoute } from '../../src/static/shuttleSchedule';
import type { ShuttleServiceDay } from '../../src/data-v2/schemas';
import { parseEventStart } from '../../src/data-v2/event-time';
import { seasonalPublicationRows } from '../../src/data-v2/dining-seasons';
import { FileRepositoryV2 } from '../../src/data-v2/repositories/file-repository';
import { assertQualityV2, validateCurrentDatasetV2 } from '../quality/validate';
import { CRITICAL_FACT_VALIDITY_V2, CRITICAL_FACT_VALUES_V2 } from './check-quality';
import { readValidityFromNotes } from '../../src/data-v2/validity';
import {
  chunkDocumentSections,
  listMarkdownFiles,
} from '../../src/data-v2/document-text';
import { SOURCES } from '../../src/data-v2/source-seeds';
import {
  evaluateSourceProvenance,
  type SourceProvenanceState,
} from '../quality/provenance';
import {
  archiveSourceRawArtifact,
  type ArchivedRawArtifact,
} from '../raw-artifacts';
import { applyDatabaseSchema } from '../database/migrations';

type JsonRecord = Record<string, unknown>;

interface PreparedChunk {
  index: number;
  content: string;
  contentHash: string;
  metadata: JsonRecord;
}

interface PreparedDocument {
  sourceKey: string;
  title: string;
  content: string;
  metadata: JsonRecord;
  collectedAt: string;
  chunks: PreparedChunk[];
}

interface PreparedArtifact {
  key: string;
  payload: unknown;
  contentHash: string;
}

function readJson<T>(relativePath: string): T {
  return JSON.parse(fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8')) as T;
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function cleanText(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function sourceKeyForPath(filePath: string): string {
  const relative = filePath.split(path.sep).join('/').toLowerCase();
  if (relative.includes('/dining/')) return 'dining';
  if (relative.includes('calendar')) return 'academic-calendar';
  if (relative.includes('program') || relative.includes('/courses/')) return 'academic-programs';
  if (relative.includes('faculty')) return 'faculty';
  if (relative.includes('club')) return 'archway-clubs';
  if (relative.includes('event')) return 'archway-events';
  if (relative.includes('transport')) return 'transportation';
  if (relative.includes('directory')) return 'campus-directory';
  if (relative.includes('safety')) return 'public-safety';
  if (relative.includes('housing')) return 'housing';
  if (relative.includes('health')) return 'health';
  if (relative.includes('counsel')) return 'counseling';
  return 'campus-hours';
}

async function sourceIds(client: PoolClient): Promise<Map<string, string>> {
  const ids = new Map<string, string>();
  for (const source of SOURCES) {
    const result = await client.query<{ id: string }>(
      `INSERT INTO rockygpt_v2.sources
       (source_key, title, canonical_url, trust_tier, freshness_sla_hours, domain)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (source_key) DO UPDATE SET
         title = EXCLUDED.title,
         canonical_url = EXCLUDED.canonical_url,
         trust_tier = EXCLUDED.trust_tier,
         freshness_sla_hours = EXCLUDED.freshness_sla_hours,
         domain = EXCLUDED.domain
       RETURNING id::text`,
      [source.key, source.title, source.url, source.trustTier, source.freshnessHours, source.domain]
    );
    ids.set(source.key, result.rows[0].id);
  }
  return ids;
}

async function insertCriticalFacts(
  client: PoolClient,
  datasetId: string,
  sources: Map<string, string>,
  collectedAtFor: (sourceKey: string) => string,
  verifiedAtFor: (factKey: string, sourceKey: string) => string
): Promise<number> {
  const sourceByKey: Record<string, string> = {
    safety: 'public-safety',
    password: 'password-reset',
    printing: 'information-technology-services',
    tuition: 'tuition-costs',
    calendar: 'academic-calendar',
    shuttle: 'transportation',
  };
  let count = 0;
  for (const [factKey, factValue] of Object.entries(CRITICAL_FACT_VALUES_V2)) {
    const sourceKey = sourceByKey[factKey.split('.')[0]];
    const validity = CRITICAL_FACT_VALIDITY_V2[factKey] || {};
    await client.query(
      `INSERT INTO rockygpt_v2.critical_facts
       (dataset_version_id, source_id, source_record_key, fact_key, fact_value,
        verified_at, collected_at, valid_from, valid_until, content_hash)
       VALUES ($1,$2,$3,$3,$4,$5,$6,$7,$8,$9)`,
      [datasetId, sources.get(sourceKey), factKey, factValue, verifiedAtFor(factKey, sourceKey),
        collectedAtFor(sourceKey), validity.validFrom || null, validity.validUntil || null,
        sha256(`${factKey}:${factValue}`)]
    );
    count += 1;
  }
  return count;
}

function repositoryStaticVerificationTime(): string {
  if (process.env.CRITICAL_FACTS_VERIFIED_AT) {
    const configured = new Date(process.env.CRITICAL_FACTS_VERIFIED_AT);
    if (!Number.isFinite(configured.getTime())) {
      throw new Error('CRITICAL_FACTS_VERIFIED_AT must be an ISO timestamp.');
    }
    return configured.toISOString();
  }
  try {
    const committed = execFileSync(
      'git',
      ['log', '-1', '--format=%cI', '--', 'pipeline/commands/check-quality.ts'],
      { cwd: process.cwd(), encoding: 'utf8' }
    ).trim();
    const parsed = new Date(committed);
    if (Number.isFinite(parsed.getTime())) return parsed.toISOString();
  } catch {
    // The explicit error below prevents a publication timestamp from silently
    // impersonating a source verification event.
  }
  throw new Error(
    'Cannot establish critical-fact verification time. Set CRITICAL_FACTS_VERIFIED_AT.'
  );
}

async function insertStructured(
  client: PoolClient,
  datasetId: string,
  sources: Map<string, string>,
  collectedAtFor: (sourceKey: string) => string
): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  const menuWeek = fs.existsSync(path.join(process.cwd(), 'data/normalized/menu-week.json'))
    ? readJson<{ dates?: Array<{ date: string; sections?: Array<{ name: string; groups?: Array<{ name: string; items?: JsonRecord[] }> }> }> }>('data/normalized/menu-week.json')
    : { dates: [] };

  const datesToPublish = (menuWeek.dates && menuWeek.dates.length > 0)
    ? menuWeek.dates
    : [{ date: new Date().toISOString().slice(0, 10), sections: readJson<Array<{ name: string; groups?: Array<{ name: string; items?: JsonRecord[] }> }>>('data/normalized/menu.json') }];

  for (const dateEntry of datesToPublish) {
    const dateStr = dateEntry.date;
    for (const meal of dateEntry.sections || []) {
      for (const station of meal.groups || []) {
        for (const item of station.items || []) {
          const name = cleanText(item.formalName);
          if (!name) continue;
          const recordKey = `${dateStr}:${meal.name}:${station.name}:${name}`;
          const allergens = Array.isArray(item.allergens)
            ? item.allergens.flatMap((entry) => cleanText((entry as JsonRecord)?.name) || [])
            : [];
          await client.query(
            `INSERT INTO rockygpt_v2.menu_items
             (dataset_version_id, source_id, source_record_key, meal, station, name, calories,
              vegan, vegetarian, allergens, collected_at, valid_from, valid_until, content_hash)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$12,$13)`,
            [datasetId, sources.get('dining'), recordKey, meal.name, station.name, name,
              cleanText(item.calories) || null, item.isVegan === true, item.isVegetarian === true,
              JSON.stringify(allergens), collectedAtFor('dining'), dateStr, sha256(recordKey)]
          );
          counts.menu_items = (counts.menu_items || 0) + 1;
        }
      }
    }
  }

  // `notes` carries the schedule's applicability ("Spring Semester 2026
  // (Jan 20 - May 12)"). Dropping it here published NULL validity, which the
  // repository reads as "applies on every date" — that is how last semester's
  // library hours answered an August question.
  const campusHours = readJson<
    Array<{ name: string; hours: Record<string, string>; notes?: string }>
  >('data/normalized/hours.json');
  for (const location of campusHours) {
    const { window } = readValidityFromNotes(location.notes);
    for (const [day, schedule] of Object.entries(location.hours || {})) {
      const recordKey = `${location.name}:${day}`;
      await client.query(
        `INSERT INTO rockygpt_v2.campus_hours
         (dataset_version_id, source_id, source_record_key, name, day, schedule, collected_at,
          valid_from, valid_until, content_hash)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [datasetId, sources.get('campus-hours'), recordKey, location.name, day, schedule, collectedAtFor('campus-hours'),
          window?.validFrom || null, window?.validUntil || null,
          sha256(`${recordKey}:${schedule}:${window?.validFrom ?? ''}:${window?.validUntil ?? ''}`)]
      );
      counts.campus_hours = (counts.campus_hours || 0) + 1;
    }
  }

  const fileRepository = new FileRepositoryV2();
  for (const day of ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']) {
    const diningHours = await fileRepository.findDiningHours('', day);
    for (const hours of diningHours) {
      const recordKey = `${hours.name}:${day}`;
      await client.query(
        `INSERT INTO rockygpt_v2.dining_hours
         (dataset_version_id, source_id, source_record_key, name, day, schedule, collected_at, content_hash)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [datasetId, sources.get('dining'), recordKey, hours.name, day, hours.schedule, collectedAtFor('dining'),
          sha256(`${recordKey}:${hours.schedule}`)]
      );
      counts.dining_hours = (counts.dining_hours || 0) + 1;
    }
  }

  // PROB-010: publish each seasonal exception as dated rows so PostgreSQL
  // answers honor closures and altered schedules for their exact interval.
  const diningRaw = readJson<JsonRecord>('data/normalized/dining-hours.json');
  const diningRegions = (((diningRaw.composition as JsonRecord)?.subject as JsonRecord)?.regions || []) as JsonRecord[];
  for (const region of diningRegions) {
    for (const fragment of (region.fragments as JsonRecord[]) || []) {
      const main = (((fragment.content as JsonRecord)?.main || {}) as JsonRecord);
      const name = typeof main.name === 'string' ? main.name : '';
      if (!name) continue;
      for (const row of seasonalPublicationRows((main.openingHours || {}) as JsonRecord)) {
        const recordKey = `${name}:${row.day}:${row.validFrom}:${row.validUntil}`;
        await client.query(
          `INSERT INTO rockygpt_v2.dining_hours
           (dataset_version_id, source_id, source_record_key, name, day, schedule, collected_at,
            valid_from, valid_until, content_hash)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [datasetId, sources.get('dining'), recordKey, name, row.day, row.schedule,
            collectedAtFor('dining'), row.validFrom, row.validUntil, sha256(`${recordKey}:${row.schedule}`)]
        );
        counts.dining_hours = (counts.dining_hours || 0) + 1;
      }
    }
  }

  const terms = readJson<Array<{ name: string; events?: Array<{ date: string; title: string; description?: string }> }>>('data/normalized/calendar.json');
  for (const term of terms) {
    for (const event of term.events || []) {
      const recordKey = `${term.name}:${event.date}:${event.title}`;
      await client.query(
        `INSERT INTO rockygpt_v2.academic_dates
         (dataset_version_id, source_id, source_record_key, term, date_label, title, description, collected_at, content_hash)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [datasetId, sources.get('academic-calendar'), recordKey, term.name, event.date, cleanText(event.title),
          cleanText(event.description) || null, collectedAtFor('academic-calendar'), sha256(recordKey)]
      );
      counts.academic_dates = (counts.academic_dates || 0) + 1;
    }
  }

  const events = readJson<JsonRecord[]>('data/normalized/events.json');
  for (const event of events) {
    const title = cleanText(event.title);
    const date = cleanText(event.date);
    if (!title || !date) continue;
    // PROB-011: a required start that cannot be parsed must fail the
    // candidate (rolling back to the prior active dataset), never publish as
    // a permanently eligible NULL starts_at.
    const startParse = parseEventStart(date, cleanText(event.time) || undefined);
    if (!startParse.ok) {
      throw new Error(
        `Event "${title}" (${date}) cannot publish: ${startParse.reason}. ` +
          'Fix data/normalized/events.json and rerun the quality gate.'
      );
    }
    const recordKey = `${date}:${title}`;
    await client.query(
      `INSERT INTO rockygpt_v2.campus_events
       (dataset_version_id, source_id, source_record_key, title, date_label, starts_at, start_time,
        end_time, organizer, description, event_url, collected_at, content_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [datasetId, sources.get('archway-events'), recordKey, title, date,
        startParse.startsAtIso,
        cleanText(event.time) || null, cleanText(event.endTime) || null, cleanText(event.organizer) || null,
        cleanText(event.description) || null, cleanText(event.url) || null, collectedAtFor('archway-events'), sha256(recordKey)]
    );
    counts.campus_events = (counts.campus_events || 0) + 1;
  }

  const clubs = readJson<JsonRecord[]>('data/normalized/clubs.json');
  for (const club of clubs) {
    const name = cleanText(club.name);
    if (!name) continue;
    await client.query(
      `INSERT INTO rockygpt_v2.clubs
       (dataset_version_id, source_id, source_record_key, name, category, website_url, collected_at, content_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [datasetId, sources.get('archway-clubs'), name, name, cleanText(club.category) || null,
        cleanText(club.websiteUrl) || null, collectedAtFor('archway-clubs'), sha256(name)]
    );
    counts.clubs = (counts.clubs || 0) + 1;
  }

  const programs = readJson<{ schools?: Array<{ school: string; majors?: JsonRecord[] }> }>('public/data/programs.json');
  for (const school of programs.schools || []) {
    for (const program of school.majors || []) {
      const name = cleanText(program.name);
      if (!name) continue;
      const recordKey = `${school.school}:${name}`;
      await client.query(
        `INSERT INTO rockygpt_v2.programs
         (dataset_version_id, source_id, source_record_key, name, degree, program_kind, school, description,
          program_url, collected_at, content_hash)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [datasetId, sources.get('academic-programs'), recordKey, name, cleanText(program.degree) || null,
          cleanText(program.programKind) || null, school.school, cleanText(program.description) || null, cleanText(program.url) || null,
          collectedAtFor('academic-programs'), sha256(recordKey)]
      );
      counts.programs = (counts.programs || 0) + 1;
    }
  }

  const directoryContacts = buildStructuredDirectoryContacts(
    readJson<unknown>('data/normalized/faculty.json')
  );
  for (const contact of directoryContacts) {
    const name = cleanText(contact.name);
    if (!name) continue;
    const department = cleanText(contact.department) || null;
    const phone = cleanText(contact.phone) || null;
    const email = cleanText(contact.email) || null;
    const office = cleanText(contact.office) || null;
    await client.query(
      `INSERT INTO rockygpt_v2.campus_contacts
       (dataset_version_id, source_id, source_record_key, name, department, phone, email, office,
        collected_at, content_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [datasetId, sources.get(contact.publicationSourceKey), contact.sourceRecordKey, name,
        department, phone, email, office, collectedAtFor(contact.publicationSourceKey),
        sha256(JSON.stringify({ name, department, phone, email, office }))]
    );
    counts.campus_contacts = (counts.campus_contacts || 0) + 1;
  }

  // Every published timetable declares its service day; the Ramsey Route 17
  // loop is a weekday-only service. Sunday must publish so weekend questions
  // stop answering from the weekday timetable (PROB-008).
  const routes: Array<[string, ShuttleRoute[], ShuttleServiceDay]> = [
    ['Ramsey Route 17', shuttleSchedule.trainLoop, 'weekday'],
    ['Weekday Roadrunner Express', shuttleSchedule.weekday, 'weekday'],
    ['Saturday Roadrunner Express', shuttleSchedule.saturday, 'saturday'],
    ['Sunday Roadrunner Express', shuttleSchedule.sunday, 'sunday'],
  ];
  for (const [name, trips, serviceDay] of routes) {
    const route = await client.query<{ id: string }>(
      `INSERT INTO rockygpt_v2.shuttle_routes
       (dataset_version_id, source_id, source_record_key, name, service_day, collected_at, content_hash)
       VALUES ($1,$2,$3,$3,$4,$5,$6) RETURNING id::text`,
      [datasetId, sources.get('transportation'), name, serviceDay, collectedAtFor('transportation'), sha256(name)]
    );
    for (const [index, trip] of trips.entries()) {
      const recordKey = `${name}:${index}:${trip.departure}`;
      await client.query(
        `INSERT INTO rockygpt_v2.shuttle_trips
         (dataset_version_id, source_id, route_id, source_record_key, sequence, departure, arrival,
          stops, collected_at, content_hash)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10)`,
        [datasetId, sources.get('transportation'), route.rows[0].id, recordKey, index, trip.departure,
          trip.arrival, JSON.stringify(trip.stops), collectedAtFor('transportation'), sha256(recordKey)]
      );
      counts.shuttle_trips = (counts.shuttle_trips || 0) + 1;
    }
  }

  return counts;
}

function prepareDocuments(
  collectedAtFor: (sourceKey: string) => string
): PreparedDocument[] {
  const root = path.join(process.cwd(), 'data/context');
  const documents: PreparedDocument[] = [];
  for (const filePath of listMarkdownFiles(root)) {
    const content = fs.readFileSync(filePath, 'utf8').trim();
    if (!content) continue;
    const relativePath = path.relative(root, filePath).split(path.sep).join('/');
    const sourceKey = sourceKeyForPath(filePath);
    const title = cleanText(content.match(/^#\s+(.+)$/m)?.[1]) || path.basename(filePath, '.md');
    const metadata = { sourcePath: relativePath };
    const chunks = chunkDocumentSections(content).map((chunk, index) => ({
      index,
      content: chunk.content,
      contentHash: sha256(chunk.content),
      metadata: {
        sourcePath: relativePath,
        domain: SOURCES.find((source) => source.key === sourceKey)?.domain,
        canonicalUrl: chunk.canonicalUrl,
        headingPath: chunk.headingPath,
      },
    }));
    documents.push({
      sourceKey,
      title,
      content,
      metadata,
      collectedAt: collectedAtFor(sourceKey),
      chunks,
    });
  }
  return documents;
}

async function insertDocuments(
  client: PoolClient,
  datasetId: string,
  sources: Map<string, string>,
  documents: PreparedDocument[]
): Promise<{ documents: number; chunks: number }> {
  const stats = { documents: 0, chunks: 0 };
  for (const prepared of documents) {
    const document = await client.query<{ id: string }>(
      `INSERT INTO rockygpt_v2.documents
       (dataset_version_id, source_id, title, content, metadata, collected_at)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6) RETURNING id::text`,
      [datasetId, sources.get(prepared.sourceKey), prepared.title, prepared.content,
        JSON.stringify(prepared.metadata), prepared.collectedAt]
    );
    stats.documents += 1;
    for (const chunk of prepared.chunks) {
      await client.query(
        `INSERT INTO rockygpt_v2.document_chunks
         (document_id, chunk_index, content, content_hash, metadata)
         VALUES ($1,$2,$3,$4,$5::jsonb)`,
        [document.rows[0].id, chunk.index, chunk.content, chunk.contentHash,
          JSON.stringify(chunk.metadata)]
      );
      stats.chunks += 1;
    }
  }
  return stats;
}

const RELEASE_ARTIFACT_FILES: Record<string, string> = {
  calendar: 'public/data/calendar.json',
  clubs: 'public/data/clubs.json',
  courses: 'public/data/courses.json',
  events: 'public/data/events.json',
  hours: 'public/data/hours.json',
  programs: 'public/data/programs.json',
  menu: 'data/normalized/menu.json',
  'menu-week': 'data/normalized/menu-week.json',
  'menu-context': 'data/context/dining/menu.md',
  'dining-hours': 'data/normalized/dining-hours.json',
  faculty: 'data/normalized/faculty.json',
  transportation: 'data/context/campus/transportation.md',
  'dining-hours-context': 'data/context/dining/hours.md',
};

function prepareReleaseArtifacts(): PreparedArtifact[] {
  return Object.entries(RELEASE_ARTIFACT_FILES).map(([key, relativePath]) => {
    const content = fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');
    const payload = relativePath.endsWith('.json')
      ? JSON.parse(content) as unknown
      : { content };
    return { key, payload, contentHash: sha256(content) };
  });
}

async function insertReleaseArtifacts(
  client: PoolClient,
  datasetId: string,
  artifacts: PreparedArtifact[]
): Promise<number> {
  for (const artifact of artifacts) {
    await client.query(
      `INSERT INTO rockygpt_v2.release_artifacts
       (dataset_version_id, artifact_key, payload, content_hash)
       VALUES ($1,$2,$3::jsonb,$4)`,
      [datasetId, artifact.key, JSON.stringify(artifact.payload), artifact.contentHash]
    );
  }
  return artifacts.length;
}

async function verifyStagingDataset(
  client: PoolClient,
  datasetId: string
): Promise<Record<string, number>> {
  const result = await client.query<{
    critical_facts: string;
    campus_contacts: string;
    campus_hours: string;
    dining_hours: string;
    menu_items: string;
    shuttle_trips: string;
    academic_dates: string;
    campus_events: string;
    clubs: string;
    programs: string;
    document_chunks: string;
    release_artifacts: string;
  }>(
    `SELECT
       (SELECT count(*) FROM rockygpt_v2.critical_facts WHERE dataset_version_id = $1::uuid) AS critical_facts,
       (SELECT count(*) FROM rockygpt_v2.campus_contacts WHERE dataset_version_id = $1::uuid) AS campus_contacts,
       (SELECT count(*) FROM rockygpt_v2.campus_hours WHERE dataset_version_id = $1::uuid) AS campus_hours,
       (SELECT count(*) FROM rockygpt_v2.dining_hours WHERE dataset_version_id = $1::uuid) AS dining_hours,
       (SELECT count(*) FROM rockygpt_v2.menu_items WHERE dataset_version_id = $1::uuid) AS menu_items,
       (SELECT count(*) FROM rockygpt_v2.shuttle_trips WHERE dataset_version_id = $1::uuid) AS shuttle_trips,
       (SELECT count(*) FROM rockygpt_v2.academic_dates WHERE dataset_version_id = $1::uuid) AS academic_dates,
       (SELECT count(*) FROM rockygpt_v2.campus_events WHERE dataset_version_id = $1::uuid) AS campus_events,
       (SELECT count(*) FROM rockygpt_v2.clubs WHERE dataset_version_id = $1::uuid) AS clubs,
       (SELECT count(*) FROM rockygpt_v2.programs WHERE dataset_version_id = $1::uuid) AS programs,
       (SELECT count(*) FROM rockygpt_v2.document_chunks c
        JOIN rockygpt_v2.documents d ON d.id = c.document_id
        WHERE d.dataset_version_id = $1::uuid) AS document_chunks,
       (SELECT count(*) FROM rockygpt_v2.release_artifacts
        WHERE dataset_version_id = $1::uuid) AS release_artifacts`,
    [datasetId]
  );
  const counts = Object.fromEntries(
    Object.entries(result.rows[0]).map(([key, value]) => [key, Number(value)])
  );
  const minimums: Record<string, number> = {
    critical_facts: Object.keys(CRITICAL_FACT_VALUES_V2).length,
    campus_contacts: 10,
    campus_hours: 20,
    dining_hours: 7,
    menu_items: 1,
    shuttle_trips: 10,
    academic_dates: 20,
    campus_events: 1,
    clubs: 100,
    programs: 50,
    document_chunks: 100,
    release_artifacts: Object.keys(RELEASE_ARTIFACT_FILES).length,
  };
  for (const [key, minimum] of Object.entries(minimums)) {
    if ((counts[key] || 0) < minimum) {
      throw new Error(`Staging verification failed: ${key}=${counts[key] || 0}, expected >= ${minimum}.`);
    }
  }

  const active = await client.query<{
    campus_contacts: string;
    clubs: string;
    programs: string;
    academic_dates: string;
    document_chunks: string;
  }>(
    `SELECT
       (SELECT count(*) FROM rockygpt_v2.campus_contacts c JOIN rockygpt_v2.dataset_versions v
        ON v.id = c.dataset_version_id WHERE v.status = 'active') AS campus_contacts,
       (SELECT count(*) FROM rockygpt_v2.clubs c JOIN rockygpt_v2.dataset_versions v
        ON v.id = c.dataset_version_id WHERE v.status = 'active') AS clubs,
       (SELECT count(*) FROM rockygpt_v2.programs p JOIN rockygpt_v2.dataset_versions v
        ON v.id = p.dataset_version_id WHERE v.status = 'active') AS programs,
       (SELECT count(*) FROM rockygpt_v2.academic_dates a JOIN rockygpt_v2.dataset_versions v
        ON v.id = a.dataset_version_id WHERE v.status = 'active') AS academic_dates,
       (SELECT count(*) FROM rockygpt_v2.document_chunks c
        JOIN rockygpt_v2.documents d ON d.id = c.document_id
        JOIN rockygpt_v2.dataset_versions v ON v.id = d.dataset_version_id
        WHERE v.status = 'active') AS document_chunks`
  );
  const previous = active.rows[0];
  const floors: Record<string, number> = {
    campus_contacts: 0.7,
    clubs: 0.7,
    programs: 0.8,
    academic_dates: 0.7,
    document_chunks: 0.5,
  };
  for (const [key, ratio] of Object.entries(floors)) {
    const oldCount = Number(previous?.[key as keyof typeof previous] || 0);
    if (oldCount > 0 && counts[key] < oldCount * ratio) {
      throw new Error(
        `Staging verification failed: ${key} dropped from ${oldCount} to ${counts[key]} ` +
        `(minimum allowed ratio ${ratio}).`
      );
    }
  }

  const sourceChunks = await client.query<{
    source_key: string;
    candidate_chunks: string;
    active_chunks: string;
  }>(
    `SELECT
       source.source_key,
       count(chunk.id) FILTER (WHERE document.dataset_version_id = $1::uuid) AS candidate_chunks,
       count(chunk.id) FILTER (WHERE version.status = 'active') AS active_chunks
     FROM rockygpt_v2.sources source
     LEFT JOIN rockygpt_v2.documents document ON document.source_id = source.id
     LEFT JOIN rockygpt_v2.dataset_versions version ON version.id = document.dataset_version_id
     LEFT JOIN rockygpt_v2.document_chunks chunk ON chunk.document_id = document.id
     GROUP BY source.source_key`,
    [datasetId]
  );
  const sourceChunkFloors: Record<string, number> = {
    'archway-events': 0.2,
    dining: 0.3,
    'academic-programs': 0.6,
    faculty: 0.6,
  };
  for (const row of sourceChunks.rows) {
    const previousChunks = Number(row.active_chunks || 0);
    const candidateChunks = Number(row.candidate_chunks || 0);
    if (previousChunks < 3) continue;
    const ratio = sourceChunkFloors[row.source_key] ?? 0.5;
    if (candidateChunks < previousChunks * ratio) {
      throw new Error(
        `Staging verification failed: ${row.source_key} chunks dropped from ${previousChunks} to ${candidateChunks} ` +
          `(minimum allowed ratio ${ratio}).`
      );
    }
  }
  return counts;
}

async function archiveRawArtifacts(
  states: SourceProvenanceState[]
): Promise<Map<string, ArchivedRawArtifact>> {
  const archived = await Promise.all(
    states.map(async (state) => {
      if (state.status === 'static' || !state.fetchedAt) return null;
      return archiveSourceRawArtifact(state.key, state.fetchedAt);
    })
  );
  return new Map(
    archived
      .filter((artifact): artifact is ArchivedRawArtifact => artifact !== null)
      .map((artifact) => [artifact.sourceKey, artifact])
  );
}

async function createReleaseManifest(
  client: PoolClient,
  input: {
    datasetId: string;
    version: string;
    sources: Map<string, string>;
    provenanceStates: SourceProvenanceState[];
    archived: Map<string, ArchivedRawArtifact>;
    publishedAt: string;
  }
): Promise<{ releaseId: string; manifestHash: string }> {
  const previous = await client.query<{ id: string }>(
    `SELECT id::text FROM rockygpt_v2.releases
     WHERE status = 'active' ORDER BY activated_at DESC LIMIT 1`
  );
  const release = await client.query<{ id: string }>(
    `INSERT INTO rockygpt_v2.releases
     (version, dataset_version_id, previous_release_id, status)
     VALUES ($1,$2,$3,'staging') RETURNING id::text`,
    [input.version, input.datasetId, previous.rows[0]?.id || null]
  );
  const releaseId = release.rows[0].id;
  const manifestEntries: Array<{ sourceKey: string; contentHash: string }> = [];

  for (const source of SOURCES) {
    const sourceId = input.sources.get(source.key);
    if (!sourceId) throw new Error(`Missing database source for ${source.key}.`);
    const state = input.provenanceStates.find((entry) => entry.key === source.key);
    if (!state) throw new Error(`Missing provenance state for ${source.key}.`);
    const artifact = input.archived.get(source.key);
    const contentHash = artifact?.rawHash || state.contentHash || sha256(
      `static:${source.key}:${process.env.GITHUB_SHA || process.env.SOURCE_COMMIT_SHA || 'working-tree'}`
    );
    const collectedAt = state.fetchedAt || input.publishedAt;
    const run = await client.query<{ id: string }>(
      `INSERT INTO rockygpt_v2.ingestion_runs
       (source_id, status, started_at, completed_at, raw_uri, raw_hash,
        parser_version, source_commit_sha, record_count, output_hash)
       VALUES ($1,$2,$3,$3,$4,$5,'1',$6,$7,$5) RETURNING id::text`,
      [sourceId, state.status === 'static' ? 'static' : 'success', collectedAt,
        artifact?.rawUri || null, contentHash,
        process.env.GITHUB_SHA || process.env.SOURCE_COMMIT_SHA || null,
        state.recordCount ?? null]
    );
    const snapshot = await client.query<{ id: string }>(
      `INSERT INTO rockygpt_v2.source_snapshots
       (source_id, ingestion_run_id, schema_version, content_hash, collected_at, status)
       VALUES ($1,$2,'1',$3,$4,'valid')
       ON CONFLICT (source_id, content_hash, schema_version)
       DO UPDATE SET status = 'valid'
       RETURNING id::text`,
      [sourceId, run.rows[0].id, contentHash, collectedAt]
    );
    const snapshotId = snapshot.rows[0].id;
    await client.query(
      `INSERT INTO rockygpt_v2.release_sources (release_id, source_id, snapshot_id)
       VALUES ($1,$2,$3)`,
      [releaseId, sourceId, snapshotId]
    );
    manifestEntries.push({ sourceKey: source.key, contentHash });
  }

  const manifestHash = sha256(JSON.stringify(
    manifestEntries.sort((left, right) => left.sourceKey.localeCompare(right.sourceKey))
  ));
  await client.query(
    `UPDATE rockygpt_v2.releases SET manifest_hash = $2 WHERE id = $1::uuid`,
    [releaseId, manifestHash]
  );
  return { releaseId, manifestHash };
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');

  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  await applyDatabaseSchema(pool);

  const version = process.env.DATASET_VERSION || `v2-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}`;
  const created = await pool.query<{ id: string }>(
    `INSERT INTO rockygpt_v2.dataset_versions
       (version, status, source_commit_sha)
     VALUES ($1, 'staging', $2) RETURNING id::text`,
    [
      version,
      process.env.GITHUB_SHA || process.env.SOURCE_COMMIT_SHA || null,
    ]
  );
  const datasetId = created.rows[0].id;
  const client = await pool.connect();
  let quality = validateCurrentDatasetV2(CRITICAL_FACT_VALUES_V2);
  let transactionStarted = false;
  let releaseId: string | null = null;

  try {
    quality = validateCurrentDatasetV2(CRITICAL_FACT_VALUES_V2, {
      enforceFreshness: true,
      enforceProvenance: true,
    });
    assertQualityV2(quality);
    const sources = await sourceIds(client);
    // PROB-002: records carry their source's real collection instant, never
    // the publication instant. Repository-static sources (critical facts,
    // seeded contacts, the checked-in shuttle timetable) use the publication
    // instant because their truth is versioned by this Git revision.
    const publishedAt = new Date().toISOString();
    const provenanceStates: SourceProvenanceState[] = evaluateSourceProvenance(SOURCES);
    const provenanceByKey = new Map(provenanceStates.map((state) => [state.key, state]));
    const collectedAtFor = (sourceKey: string): string =>
      provenanceByKey.get(sourceKey)?.fetchedAt ?? publishedAt;
    const staticVerifiedAt = repositoryStaticVerificationTime();
    const verifiedAtFor = (factKey: string, sourceKey: string): string =>
      factKey.startsWith('safety.') || factKey.startsWith('calendar.')
        ? collectedAtFor(sourceKey)
        : staticVerifiedAt;

    // Network and CPU-heavy work happens before the staging transaction. Raw
    // captures are archived, documents are chunked, and only previously unseen
    const archived = await archiveRawArtifacts(provenanceStates);
    const manifest = await createReleaseManifest(client, {
      datasetId,
      version,
      sources,
      provenanceStates,
      archived,
      publishedAt,
    });
    releaseId = manifest.releaseId;
    const preparedDocuments = prepareDocuments(collectedAtFor);
    const artifacts = prepareReleaseArtifacts();

    // Build the candidate release transactionally, but do not hold this
    // transaction open across object-storage calls.
    await client.query('BEGIN');
    transactionStarted = true;
    await client.query(
      `UPDATE rockygpt_v2.dataset_versions SET status = 'validating' WHERE id = $1::uuid`,
      [datasetId]
    );
    await client.query(
      `UPDATE rockygpt_v2.releases SET status = 'validating' WHERE id = $1::uuid`,
      [releaseId]
    );
    const criticalCount = await insertCriticalFacts(
      client,
      datasetId,
      sources,
      collectedAtFor,
      verifiedAtFor
    );
    const structured = await insertStructured(client, datasetId, sources, collectedAtFor);
    const documents = await insertDocuments(
      client,
      datasetId,
      sources,
      preparedDocuments
    );
    const releaseArtifactCount = await insertReleaseArtifacts(client, datasetId, artifacts);
    if (criticalCount !== Object.keys(CRITICAL_FACT_VALUES_V2).length) throw new Error('Critical fact verification failed.');

    // PROB-002: source runs record each source's authentic collection event,
    // its own record count, and a content-derived hash — never one shared
    // publication timestamp, a repeated aggregate count, or a synthetic hash.
    for (const source of SOURCES) {
      const state = provenanceByKey.get(source.key);
      await client.query(
        `INSERT INTO rockygpt_v2.source_runs
         (dataset_version_id, source_key, status, started_at, completed_at, source_url,
          record_count, content_hash)
         VALUES ($1,$2,$3,$4,$4,$5,$6,$7)`,
        [
          datasetId,
          source.key,
          state?.status === 'static' ? 'static' : 'success',
          state?.fetchedAt ?? publishedAt,
          source.url,
          state?.recordCount ?? null,
          archived.get(source.key)?.rawHash ?? state?.contentHash ??
            sha256(`static:${source.key}:${JSON.stringify(CRITICAL_FACT_VALUES_V2)}`),
        ]
      );
    }
    await client.query('COMMIT');
    transactionStarted = false;

    // Verification reads the committed-but-inactive candidate. Activation is
    // a separate short pointer-swap transaction, so readers never see partial
    // data and a failed gate leaves the previous release untouched.
    const verifiedCounts = await verifyStagingDataset(client, datasetId);
    const summary = {
      ...quality,
      criticalCount,
      structured,
      ...documents,
      releaseArtifactCount,
      rawArtifactsStored: [...archived.values()].filter((artifact) => artifact.stored).length,
      manifestHash: manifest.manifestHash,
      verifiedCounts,
    };

    await client.query('BEGIN');
    transactionStarted = true;
    await client.query(`UPDATE rockygpt_v2.dataset_versions SET status = 'retired' WHERE status = 'active'`);
    await client.query(`UPDATE rockygpt_v2.releases SET status = 'retired' WHERE status = 'active'`);
    await client.query(
      `UPDATE rockygpt_v2.dataset_versions
       SET status = 'active', activated_at = now(), quality_summary = $2::jsonb
       WHERE id = $1::uuid`,
      [datasetId, JSON.stringify(summary)]
    );
    await client.query(
      `UPDATE rockygpt_v2.releases
       SET status = 'active', activated_at = now(), quality_summary = $2::jsonb
       WHERE id = $1::uuid`,
      [releaseId, JSON.stringify(summary)]
    );
    await client.query('COMMIT');
    transactionStarted = false;
    console.log(JSON.stringify({ activated: version, datasetId, releaseId, summary }, null, 2));
  } catch (error) {
    if (transactionStarted) await client.query('ROLLBACK');
    await pool.query(
      `UPDATE rockygpt_v2.dataset_versions
       SET status = 'failed', quality_summary = $2::jsonb
       WHERE id = $1::uuid`,
      [datasetId, JSON.stringify({ ...quality, publishError: error instanceof Error ? error.message : String(error) })]
    );
    await pool.query(
      `UPDATE rockygpt_v2.releases
       SET status = 'failed', quality_summary = $2::jsonb
       WHERE dataset_version_id = $1::uuid`,
      [datasetId, JSON.stringify({ publishError: error instanceof Error ? error.message : String(error) })]
    );
    await pool.query(
      `INSERT INTO rockygpt_v2.source_runs
       (dataset_version_id, source_key, status, started_at, completed_at, source_url, error_message)
       VALUES ($1,'publisher','failed',now(),now(),'https://www.ramapo.edu/',$2)`,
      [datasetId, error instanceof Error ? error.message : String(error)]
    );
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
