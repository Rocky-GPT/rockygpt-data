/** A deliberately narrow local staging command, never a production publisher.
 *
 * Clone an isolated development DB, append a staging copy of its active release,
 * and add ONLY field observations checked against a complete fresh
 * public capture. All other values and capture times remain unchanged. Activation
 * is a separate reviewed operation; this module contains no activation command.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Pool, type PoolClient } from 'pg';
import { checkContactValues, evidenceText, statesValue, roomKey, pageKey, type CapturedPage, type ContactEvidence } from '../src/directory/contact-evidence';
import { buildStructuredDirectoryContacts } from '../src/directory/structured-contacts';
import { validateCampusIdentities } from '../src/data-v2/campus-identities';
import { validateRawDatasetV1 } from '../ingestion/raw-types';
import { sourceHtml, buildRawPageFromHtml } from '../ingestion/raw-collector';

type Row = Record<string, unknown>;
export class DevelopmentCandidateValidationError extends Error {}
const TABLES = ['critical_facts', 'campus_contacts', 'campus_hours', 'dining_hours', 'menu_items',
  'shuttle_routes', 'shuttle_trips', 'academic_dates', 'campus_events', 'clubs', 'programs',
  'documents', 'source_runs'] as const;
const PREFIX = 'rockygpt_profiles_dev_';
const q = (name: string): string => `"${name.replaceAll('"', '""')}"`;
const hash = (value: unknown): string => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Shared contract: UTF-8 JSON, recursively sorted keys, compact, arrays in source order. */
export function observationValueHash(value: unknown): string {
  function sorted(item: unknown): unknown {
    if (Array.isArray(item)) return item.map(sorted);
    if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([key,v])=>[key,sorted(v)]));
    return item;
  }
  return hash(sorted(value));
}

function projections(row: Row): Row {
  return { email:row.email ?? null, phones:{phone:row.phone ?? null,phones:row.phones ?? null},
    offices:{office:row.office ?? null,offices:row.offices ?? null} };
}

/** A tuple must be stated together, not assembled from neighboring directory entries.
 * This narrow refresh accepts only unlabeled full numbers; extensions/types need a
 * separate reviewed proof rather than being made fresh by a number-only match.
 */
function contiguousPhones(phones: unknown, text: string): boolean {
  if (!Array.isArray(phones) || !phones.length) return false;
  const patterns: string[] = [];
  for (const phone of phones) {
    if (!phone || typeof phone !== 'object' || Object.keys(phone).join(',') !== 'number' || typeof phone.number !== 'string') return false;
    const digits=phone.number.replace(/\D/g,'');
    if (!/^\d{10}$/.test(digits)) return false;
    patterns.push(`(?:\\+?1[\\s.\\-–—]*)?\\(?${digits.slice(0,3)}\\)?[\\s.\\-–—]*${digits.slice(3,6)}[\\s.\\-–—]*${digits.slice(6)}`);
  }
  return new RegExp(`(?<!\\d)${patterns.join('\\s*(?:or|/)\\s*')}(?!\\d)`,'i').test(text);
}

export function verifiedContactObservations(row: Row, rebuilt: Row, evidence: readonly ContactEvidence[],
  pages: ReadonlyMap<string,CapturedPage>, htmlHashes: ReadonlyMap<string,string>, now: Date): {
    fields:Row; withheld:{field:string;reason:string}[];
  } {
  const actual=projections(row), expected=projections(rebuilt);
  if (observationValueHash(actual)!==observationValueHash(expected)) throw new DevelopmentCandidateValidationError('Published contact projections differ from the freshly rebuilt structured contact.');
  if (!checkedCaptureTime(evidence,pages,now)) return {fields:{},withheld:[]};
  function pageEvidence(entry: ContactEvidence): Row {
    const htmlHash=htmlHashes.get(pageKey(entry.url));
    if (!htmlHash || !/^[a-f0-9]{64}$/.test(htmlHash)) throw new DevelopmentCandidateValidationError('Missing retained HTML hash for a field observation.');
    return {url:entry.url,section:entry.section,...(entry.near?{near:entry.near}:{}),
      fetched_at:pages.get(pageKey(entry.url))!.fetchedAt,html_sha256:htmlHash};
  }
  const result: Row={};
  const withheld:{field:string;reason:string}[]=[];
  for (const [scalar,field] of [['phone','phones'],['email','email'],['office','offices']] as const) {
    const value=row[scalar];
    if (!value) continue;
    if (typeof value!=='string') throw new DevelopmentCandidateValidationError('Contact observation must have a scalar published value.');
    const supporting=evidence.filter(entry=>{
      if (!entry.fields.includes(scalar)) return false;
      const found=evidenceText(entry,pages);
      if ('reason' in found) return false;
      if (scalar==='office' && entry.near && !roomKey(value)) {
        // Named locations have no recognizable room-code boundary. Require the
        // value directly after this entry's anchor, never a later neighbor's place.
        const following=found.text.slice(entry.near.length).replace(/^[\s:–—-]*(?:(?:location|office)\s*:\s*)?/i,'');
        const key=(text:string)=>text.toLowerCase().replace(/[^a-z0-9]/g,'');
        if (!key(following).startsWith(key(value))) return false;
      }
      return 'text' in found && statesValue(scalar,value,found.text,false)
        && (!entry.near || statesValue(scalar,value,found.text,true))
        && (scalar!=='phone' || contiguousPhones(row.phones,found.text));
    });
    if (!supporting.length) {
      withheld.push({field,reason:'The complete published value is not stated together in its scoped fresh evidence.'});
      continue;
    }
    result[field]={captured_at:checkedCaptureTime(supporting,pages,now),value_sha256:observationValueHash(actual[field]),pages:supporting.map(pageEvidence)};
  }
  return {fields:result,withheld};
}

export function assertLocalCandidate(sourceUrl: string, candidate: string): URL {
  const url = new URL(sourceUrl);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)
      || url.search || url.hash || !url.pathname.slice(1).startsWith(PREFIX)
      || !new RegExp(`^${PREFIX}[a-z0-9_]+$`).test(candidate)
      || candidate === url.pathname.slice(1)) {
    throw new DevelopmentCandidateValidationError('Only a distinct, explicitly named loopback development candidate is allowed.');
  }
  return url;
}

/** Canonical entity IDs are not row IDs. Only the publisher's explicit record pins change. */
export function remapRecordPins(value: unknown, mapping: ReadonlyMap<string, string>, key = ''): unknown {
  if (key === 'source_record_id' && typeof value === 'string') return mapping.get(value) ?? value;
  if (key === 'source_record_ids' && Array.isArray(value)) return value.map(id => typeof id === 'string' ? mapping.get(id) ?? id : id);
  if (Array.isArray(value)) return value.map(item => remapRecordPins(item, mapping));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, remapRecordPins(item, mapping, name)]));
  return value;
}

export function checkedCaptureTime(evidence: readonly ContactEvidence[], pages: ReadonlyMap<string, CapturedPage>, now: Date): string | null {
  if (!evidence.length) return null; // No observation must not become a newly verified fact.
  const times = evidence.map(entry => {
    const page = pages.get(pageKey(entry.url));
    const time = page ? Date.parse(page.fetchedAt) : NaN;
    if (!Number.isFinite(time) || time > now.getTime() || now.getTime() - time > 24 * 60 * 60 * 1000) {
      throw new DevelopmentCandidateValidationError('Every cited contact page must have an authentic capture within the last day.');
    }
    return time;
  });
  return new Date(Math.min(...times)).toISOString();
}

interface ReviewEntry { name: string; phone?: string; email?: string; office?: string; evidence: ContactEvidence[] }
interface Options { sourceUrl: string; candidate: string; version: string; captureDirectory: string; reportPath: string }

function prepareCapture(directory: string): { artifact: Row; pages: Map<string, CapturedPage>; entries: Map<string, ReviewEntry>; htmlHashes:Map<string,string>; rebuilt:Map<string,Row> } {
  const rawPath = path.join(directory, 'office-contact-evidence.raw.json');
  const sourcesPath = path.join(directory, 'office-contact-evidence-sources.raw.json');
  const raw = validateRawDatasetV1(JSON.parse(fs.readFileSync(rawPath, 'utf8')));
  const sources = JSON.parse(fs.readFileSync(sourcesPath, 'utf8'));
  const referenceBytes = fs.readFileSync(path.join(process.cwd(), 'src/reference/directory-contacts.json'));
  const reference = JSON.parse(referenceBytes.toString('utf8'));
  const entries = new Map<string, ReviewEntry>();
  for (const kind of ['office', 'other']) for (const entry of reference[kind] as ReviewEntry[]) {
    const key = `${kind}:${entry.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')}`;
    if (entries.has(key)) throw new DevelopmentCandidateValidationError('Duplicate reviewed directory record key.');
    entries.set(key, entry);
  }
  const expectedUrls = new Set([...entries.values()].flatMap(entry => entry.evidence.map(e => pageKey(e.url))));
  if (!sources.collectionSucceeded || raw.stats.pagesFailed || raw.pages.length !== expectedUrls.size
      || new Set(raw.pages.map(page=>pageKey(page.url))).size !== expectedUrls.size
      || sources.pages.length !== raw.pages.length) throw new DevelopmentCandidateValidationError('The complete contact capture is required.');
  const htmlHashes=new Map<string,string>();
  for (const page of raw.pages) {
    if (page.statusCode !== 200 || !expectedUrls.has(pageKey(page.url))) throw new DevelopmentCandidateValidationError('Unexpected or unsuccessful contact page.');
    const source = sources.pages.find((item: Row) => item.url === page.url && item.fetchedAt === page.fetchedAt);
    if (!source) throw new DevelopmentCandidateValidationError('Missing source HTML.');
    const html = sourceHtml(source);
    if (crypto.createHash('sha256').update(html).digest('hex') !== source.contentHash) throw new DevelopmentCandidateValidationError('Source HTML hash mismatch.');
    const replay = buildRawPageFromHtml({ url: page.url, html, fetchedAt: page.fetchedAt,
      sourceType: page.sourceType, statusCode: page.statusCode, allowedHost: new URL(page.url).host });
    if (hash(replay.sections) !== hash(page.sections)) throw new DevelopmentCandidateValidationError('Parsed contact sections disagree with source HTML.');
    htmlHashes.set(pageKey(page.url),source.contentHash);
  }
  const pages = new Map<string,CapturedPage>(raw.pages.map(page=>[pageKey(page.url),page]));
  for (const entry of entries.values()) {
    checkedCaptureTime(entry.evidence, pages, new Date());
    if (checkContactValues(entry, entry.evidence, pages).withheld.length) throw new DevelopmentCandidateValidationError(`Unsupported reviewed values: ${entry.name}`);
  }
  return { artifact: { scope: 'development-directory-contact-evidence-only', raw, sources,
    reference_sha256: crypto.createHash('sha256').update(referenceBytes).digest('hex') }, pages, entries,htmlHashes,
    rebuilt:new Map(buildStructuredDirectoryContacts([],pages).map(row=>[row.sourceRecordKey,
      {...row,phones:row.phones ?? [],offices:row.offices ?? []}])) };
}

async function columns(client: PoolClient, table: string): Promise<string[]> {
  return (await client.query<{ column_name: string }>(`SELECT column_name FROM information_schema.columns
    WHERE table_schema='rockygpt_v2' AND table_name=$1 AND is_generated='NEVER' ORDER BY ordinal_position`, [table])).rows.map(row => row.column_name);
}

export async function stageDevelopmentOfficeCandidate(options: Options): Promise<Row> {
  const sourceUrl = assertLocalCandidate(options.sourceUrl, options.candidate);
  if (!/^dev-offices-[a-z0-9_-]+$/.test(options.version)) throw new DevelopmentCandidateValidationError('An explicit dev-offices release version is required.');
  const capture = prepareCapture(options.captureDirectory);
  const implementationFiles=Object.fromEntries(['pipeline/development-office-candidate.ts','pipeline/commands/capture-development-offices.ts',
    'src/directory/structured-contacts.ts','src/directory/contact-evidence.ts','src/directory/contact-normalizer.ts',
    'src/directory/phone-normalizer.ts'].map(file=>[file,crypto.createHash('sha256').update(fs.readFileSync(path.join(process.cwd(),file))).digest('hex')]));
  // Reserve the output before creating a database; an existing report is never overwritten.
  fs.writeFileSync(options.reportPath,JSON.stringify({candidate:options.candidate,version:options.version,status:'preparing',activated:false}),{flag:'wx',mode:0o600});
  const source = new Pool({ connectionString: sourceUrl.toString(), max: 1, statement_timeout: 10000,
    options: '-c default_transaction_read_only=on', connectionTimeoutMillis: 3000 });
  let base: Row;
  try {
    const rows = (await source.query(`SELECT d.id::text AS dataset_id,d.version,d.source_commit_sha,r.id::text AS release_id,r.manifest_hash
      FROM rockygpt_v2.dataset_versions d JOIN rockygpt_v2.releases r ON r.dataset_version_id=d.id
      WHERE d.status='active' AND r.status='active'`)).rows;
    if (rows.length !== 1) throw new DevelopmentCandidateValidationError('A unique active development release is required.');
    base = rows[0];
    const current = (await source.query(`SELECT c.* FROM rockygpt_v2.campus_contacts c JOIN rockygpt_v2.sources s ON s.id=c.source_id
      WHERE c.dataset_version_id=$1 AND s.source_key='campus-directory'`, [base.dataset_id])).rows;
    if (current.length !== capture.entries.size) throw new DevelopmentCandidateValidationError('The reviewed directory does not exactly cover the source release.');
    for (const row of current) {
      const entry = capture.entries.get(row.source_record_key);
      if (!entry || checkContactValues(row, entry.evidence, capture.pages).withheld.length) throw new DevelopmentCandidateValidationError('Fresh evidence does not support an existing published contact.');
      verifiedContactObservations(row,capture.rebuilt.get(row.source_record_key)!,entry.evidence,capture.pages,capture.htmlHashes,new Date());
    }
  } finally { await source.end(); }

  const adminUrl = new URL(sourceUrl); adminUrl.pathname = '/postgres';
  const admin = new Pool({ connectionString: adminUrl.toString(), max: 1, connectionTimeoutMillis: 3000 });
  try {
    const roles = (await admin.query('SELECT rolcreatedb,rolsuper FROM pg_roles WHERE rolname=current_user')).rows[0];
    if (!roles?.rolcreatedb && !roles?.rolsuper) throw new DevelopmentCandidateValidationError('Local owner must be allowed to create a development database.');
    // Never terminate source sessions or overwrite an existing candidate.
    await admin.query(`CREATE DATABASE ${q(options.candidate)} TEMPLATE ${q(sourceUrl.pathname.slice(1))}`);
  } finally { await admin.end(); }

  const candidateUrl = new URL(sourceUrl); candidateUrl.pathname = `/${options.candidate}`;
  const pool = new Pool({ connectionString: candidateUrl.toString(), max: 1, connectionTimeoutMillis: 3000 });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL statement_timeout='120s'");
    const locked = (await client.query(`SELECT id::text FROM rockygpt_v2.dataset_versions WHERE status='active' FOR UPDATE`)).rows;
    if (locked.length !== 1 || locked[0].id !== base.dataset_id) throw new DevelopmentCandidateValidationError('The base release changed before cloning.');
    const actualTables = (await client.query(`SELECT table_name FROM information_schema.columns
      WHERE table_schema='rockygpt_v2' AND column_name='dataset_version_id' ORDER BY table_name`)).rows.map(row => row.table_name);
    const expectedTables = [...TABLES, 'releases', 'release_artifacts'].sort();
    if (JSON.stringify(actualTables) !== JSON.stringify(expectedTables)) throw new DevelopmentCandidateValidationError('Unexpected dataset schema; review the development copy operation.');
    const datasetId = crypto.randomUUID(), releaseId = crypto.randomUUID();
    await client.query(`INSERT INTO rockygpt_v2.dataset_versions(id,version,status,source_commit_sha)
      SELECT $1,$2,'staging',source_commit_sha FROM rockygpt_v2.dataset_versions WHERE id=$3`, [datasetId,options.version,base.dataset_id]);
    await client.query(`INSERT INTO rockygpt_v2.releases(id,version,dataset_version_id,previous_release_id,status)
      VALUES($1,$2,$3,$4,'staging')`, [releaseId,options.version,datasetId,base.release_id]);
    await client.query('CREATE TEMP TABLE office_refresh_row_map(old_id uuid PRIMARY KEY,new_id uuid NOT NULL,table_name text NOT NULL) ON COMMIT DROP');
    for (const table of TABLES) await client.query(`INSERT INTO office_refresh_row_map SELECT id,gen_random_uuid(),$2 FROM rockygpt_v2.${q(table)} WHERE dataset_version_id=$1`, [base.dataset_id,table]);
    await client.query(`INSERT INTO office_refresh_row_map SELECT c.id,gen_random_uuid(),'document_chunks' FROM rockygpt_v2.document_chunks c
      JOIN rockygpt_v2.documents d ON d.id=c.document_id WHERE d.dataset_version_id=$1`, [base.dataset_id]);
    const rowMap = new Map<string,string>((await client.query('SELECT old_id::text,new_id::text FROM office_refresh_row_map')).rows.map(row => [row.old_id,row.new_id]));
    const counts: Record<string,number> = {};
    for (const table of [...TABLES, 'document_chunks']) {
      const names = await columns(client, table);
      const expressions = names.map(name => name === 'id' ? 'm.new_id' : name === 'dataset_version_id' ? '$1::uuid'
        : (table === 'shuttle_trips' && name === 'route_id') || (table === 'document_chunks' && name === 'document_id')
          ? `(SELECT new_id FROM office_refresh_row_map WHERE old_id=t.${q(name)})` : `t.${q(name)}`);
      const copied = await client.query(`INSERT INTO rockygpt_v2.${q(table)} (${names.map(q).join(',')})
        SELECT ${expressions.join(',')} FROM rockygpt_v2.${q(table)} t JOIN office_refresh_row_map m ON m.old_id=t.id WHERE m.table_name=$2 AND $1::uuid IS NOT NULL`, [datasetId,table]);
      counts[table] = copied.rowCount ?? 0;
    }
    const artifacts = (await client.query('SELECT artifact_key,payload,content_hash,created_at::text AS created_at FROM rockygpt_v2.release_artifacts WHERE dataset_version_id=$1', [base.dataset_id])).rows;
    const changedArtifacts: string[] = [];
    const expectedArtifacts: Row[] = [];
    for (const artifact of artifacts) {
      const payload = remapRecordPins(artifact.payload, rowMap);
      const changed = JSON.stringify(payload) !== JSON.stringify(artifact.payload);
      if (changed) changedArtifacts.push(artifact.artifact_key);
      if (artifact.artifact_key === 'campus-identities') {
        validateCampusIdentities(payload);
        const before = artifact.payload.entities.map((e: Row) => e.id).sort();
        const after = payload.entities.map(e => e.id).sort();
        if (JSON.stringify(before) !== JSON.stringify(after)) throw new DevelopmentCandidateValidationError('Canonical identity changed.');
      }
      await client.query(`INSERT INTO rockygpt_v2.release_artifacts(dataset_version_id,artifact_key,payload,content_hash,created_at)
        VALUES($1,$2,$3,$4,$5)`, [datasetId,artifact.artifact_key,JSON.stringify(payload),changed ? hash(payload) : artifact.content_hash,artifact.created_at]);
      expectedArtifacts.push({artifact_key:artifact.artifact_key,payload,content_hash:changed?hash(payload):artifact.content_hash,created_at:artifact.created_at});
    }
    const evidenceKey = 'development-office-contact-evidence';
    const evidenceHash = hash(capture.artifact);
    await client.query(`INSERT INTO rockygpt_v2.release_artifacts(dataset_version_id,artifact_key,payload,content_hash)
      VALUES($1,$2,$3,$4)`, [datasetId,evidenceKey,capture.artifact,evidenceHash]);
    const contacts = (await client.query(`SELECT c.* FROM rockygpt_v2.campus_contacts c JOIN rockygpt_v2.sources s ON s.id=c.source_id
      WHERE c.dataset_version_id=$1 AND s.source_key='campus-directory'`, [datasetId])).rows;
    let observed = 0;
    const observedFields: Record<string,number>={email:0,phones:0,offices:0};
    const withheldFieldObservations: Row[]=[];
    for (const row of contacts) {
      const entry = capture.entries.get(row.source_record_key)!;
      const {fields,withheld}=verifiedContactObservations(row,capture.rebuilt.get(row.source_record_key)!,entry.evidence,capture.pages,capture.htmlHashes,new Date());
      withheldFieldObservations.push(...withheld.map(value=>({source_record_key:row.source_record_key,...value})));
      if (!Object.keys(fields).length) continue;
      if (row.normalization_metadata?.office_evidence_refresh || row.normalization_metadata?.contact_observations) throw new DevelopmentCandidateValidationError('Existing refresh metadata requires explicit review before replacement.');
      const metadata = { ...row.normalization_metadata, contact_observations: { schema_version:1,
        artifact_key: evidenceKey, artifact_hash: evidenceHash, base_version: base.version,
        fields,
      } };
      await client.query('UPDATE rockygpt_v2.campus_contacts SET normalization_metadata=$2 WHERE id=$1', [row.id,metadata]);
      observed++;
      for (const field of Object.keys(fields)) observedFields[field]++;
    }
    const preservationChecks: Record<string,number> = {};
    for (const table of [...TABLES, 'document_chunks']) {
      const ignored = ['id','dataset_version_id', ...(table === 'shuttle_trips' ? ['route_id'] : []),
        ...(table === 'document_chunks' ? ['document_id'] : []),
        ...(table === 'campus_contacts' ? ['normalization_metadata'] : [])];
      const difference = (await client.query(`SELECT count(*)::int AS count FROM office_refresh_row_map m
        JOIN rockygpt_v2.${q(table)} original ON original.id=m.old_id
        JOIN rockygpt_v2.${q(table)} copied ON copied.id=m.new_id
        WHERE m.table_name=$1 AND (to_jsonb(original)-$2::text[]) IS DISTINCT FROM (to_jsonb(copied)-$2::text[])`, [table,ignored])).rows[0].count;
      if (difference) throw new DevelopmentCandidateValidationError(`Unrelated published values changed in ${table}.`);
      preservationChecks[table] = difference;
    }
    const unrelatedContacts = (await client.query(`SELECT count(*)::int AS count FROM office_refresh_row_map m
      JOIN rockygpt_v2.campus_contacts original ON original.id=m.old_id JOIN rockygpt_v2.campus_contacts copied ON copied.id=m.new_id
      JOIN rockygpt_v2.sources s ON s.id=original.source_id WHERE m.table_name='campus_contacts' AND s.source_key<>'campus-directory'
      AND (original.collected_at IS DISTINCT FROM copied.collected_at OR original.normalization_metadata IS DISTINCT FROM copied.normalization_metadata)`)).rows[0].count;
    if (unrelatedContacts) throw new DevelopmentCandidateValidationError('Unrelated contact provenance changed.');
    const changedOriginalMetadata=(await client.query(`SELECT count(*)::int AS count FROM office_refresh_row_map m
      JOIN rockygpt_v2.campus_contacts original ON original.id=m.old_id JOIN rockygpt_v2.campus_contacts copied ON copied.id=m.new_id
      WHERE m.table_name='campus_contacts' AND original.normalization_metadata IS DISTINCT FROM (copied.normalization_metadata-'contact_observations')`)).rows[0].count;
    if (changedOriginalMetadata) throw new DevelopmentCandidateValidationError('Original contact provenance changed.');
    const preservedArtifacts=(await client.query(`SELECT count(*)::int AS count
      FROM jsonb_to_recordset($2::jsonb) expected(artifact_key text,payload jsonb,content_hash text,created_at timestamptz)
      JOIN rockygpt_v2.release_artifacts a ON a.dataset_version_id=$1 AND a.artifact_key=expected.artifact_key
      AND a.payload=expected.payload AND a.content_hash=expected.content_hash AND a.created_at=expected.created_at`,[datasetId,JSON.stringify(expectedArtifacts)])).rows[0].count;
    if (preservedArtifacts!==artifacts.length) throw new DevelopmentCandidateValidationError('Copied release artifact changed beyond remapped record pins.');
    const unresolvedObservations=(await client.query(`SELECT count(*)::int AS count FROM rockygpt_v2.campus_contacts c
      LEFT JOIN rockygpt_v2.release_artifacts a ON a.dataset_version_id=c.dataset_version_id
        AND a.artifact_key=c.normalization_metadata->'contact_observations'->>'artifact_key'
        AND a.content_hash=c.normalization_metadata->'contact_observations'->>'artifact_hash'
      WHERE c.dataset_version_id=$1 AND c.normalization_metadata ? 'contact_observations' AND a.artifact_key IS NULL`,[datasetId])).rows[0].count;
    if (unresolvedObservations) throw new DevelopmentCandidateValidationError('Field observations do not resolve to their same-release capture.');
    const identity = (await client.query(`SELECT payload,content_hash FROM rockygpt_v2.release_artifacts
      WHERE dataset_version_id=$1 AND artifact_key='campus-identities'`, [datasetId])).rows[0];
    const offices = identity.payload.entities.filter((entity: Row) => entity.kind === 'office');
    const publishedContacts = (await client.query(`SELECT c.*,s.source_key,s.freshness_sla_hours FROM rockygpt_v2.campus_contacts c
      JOIN rockygpt_v2.sources s ON s.id=c.source_id WHERE c.dataset_version_id=$1`, [datasetId])).rows;
    const officeFieldCoverage:Row[]=[];
    let officesWithFreshContactFields=0;
    for (const office of offices) {
      const links = office.links.filter((link: Row) => link.collection === 'contacts');
      if (!links.length) throw new DevelopmentCandidateValidationError('A canonical office has no contact evidence.');
      const officeRows:Row[]=[];
      for (const link of links) {
        const linked = publishedContacts.filter(row => row.source_key === link.source_key && link.source_record_keys.includes(row.source_record_key)
          && (!link.source_record_ids || link.source_record_ids.includes(row.id)));
        if (!linked.length || link.source_record_keys.some((key: string) => !linked.some(row => row.source_record_key === key))
          || (link.source_record_ids && link.source_record_ids.some((id: string) => !linked.some(row => row.id === id)))) throw new DevelopmentCandidateValidationError('A canonical office record pin did not resolve.');
        officeRows.push(...linked);
      }
      const fields=Object.fromEntries([['email','email'],['phones','phone'],['offices','office']].map(([field,scalar])=>{
        const present=officeRows.filter(row=>row[scalar]);
        const current=present.filter(row=>{
          const metadata=row.normalization_metadata as {contact_observations?:{fields?:Record<string,{captured_at:string}>}};
          const captured=Date.parse(metadata.contact_observations?.fields?.[field]?.captured_at ?? '');
          return Number.isFinite(captured) && captured<=Date.now() && Date.now()-captured<=Number(row.freshness_sla_hours)*3600000;
        });
        return [field,{publishedRecords:present.length,freshObservations:current.length,unobservedRecords:present.length-current.length}];
      }));
      if (Object.values(fields).some(value=>value.freshObservations>0)) officesWithFreshContactFields++;
      officeFieldCoverage.push({entity_id:office.id,name:office.name,fields});
    }
    // Existing full-source provenance stays unchanged. This supplementary capture
    // must not claim that old directory documents or unrelated source rows are fresh.
    await client.query(`INSERT INTO rockygpt_v2.release_sources SELECT $1,source_id,snapshot_id FROM rockygpt_v2.release_sources WHERE release_id=$2`, [releaseId,base.release_id]);
    await client.query(`INSERT INTO rockygpt_v2.source_runs(dataset_version_id,source_key,status,started_at,completed_at,source_url,record_count,content_hash)
      VALUES($1,'development-office-contact-evidence','success',$2,$3,'https://www.ramapo.edu/',$4,$5)`,
    [datasetId,new Date(Math.min(...[...capture.pages.values()].map(p=>Date.parse(p.fetchedAt)))),new Date(),observed,evidenceHash]);
    const report = { candidate: options.candidate, status:'staging', baseVersion:base.version,
      version:options.version,datasetId,releaseId,contactsWithFreshFieldObservations:observed,observedFields,withheldFieldObservations,unchangedUnobservedContacts:contacts.length-observed,
      copiedRows:counts,changedArtifactPins:changedArtifacts,evidenceArtifactHash:evidenceHash,
      canonicalIdentityIdsUnchanged:true,canonicalOfficesResolved:offices.length,canonicalOfficesWithFreshContactFields:officesWithFreshContactFields,officeFieldCoverage,originalCollectedAtPreserved:true,
      identityHash:identity.content_hash,unrelatedValueDifferences:preservationChecks,unrelatedContactProvenanceDifferences:unrelatedContacts,
      originalContactMetadataDifferences:changedOriginalMetadata,preservedArtifacts,sameReleaseObservationArtifactFailures:unresolvedObservations,
      baseSourceCommitSha:base.source_commit_sha,refreshImplementationSha256:implementationFiles,
      sourceDatabaseUnchanged:true,activated:false };
    await client.query('UPDATE rockygpt_v2.dataset_versions SET quality_summary=$2 WHERE id=$1',[datasetId,report]);
    await client.query('UPDATE rockygpt_v2.releases SET quality_summary=$2,manifest_hash=$3 WHERE id=$1',[releaseId,report,hash({base:base.manifest_hash,contactEvidence:evidenceHash,implementationFiles})]);
    await client.query('COMMIT');
    fs.writeFileSync(options.reportPath, JSON.stringify(report,null,2), {mode:0o600});
    return report;
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); await pool.end(); }
}
