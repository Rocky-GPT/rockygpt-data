import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import type {
  CriticalFactRecord,
  DatasetContext,
  EvidenceItem,
  SourceReference,
} from '../types';
import {
  OFFICE_DIRECTORY_CONTACTS,
  OTHER_DIRECTORY_CONTACTS,
} from '../../directory/static-contacts';
import { shuttleSchedule, type ShuttleRoute } from '../../static/shuttleSchedule';
import type {
  AcademicDateRecord,
  ClubRecord,
  ContactRecord,
  DiningVenueRecord,
  EventRecord,
  HoursRecord,
  MenuItemRecord,
  ProgramRecord,
  ShuttleServiceDay,
  ShuttleTripRecord,
} from '../schemas';
import { V2_SOURCES } from '../sources';
import { DATA_ROOT } from '../../paths';
import { parseEventStart } from '../event-time';
import { activeSeasonSchedule } from '../dining-seasons';
import { extractSectionUrl, stripIngestionMetadata } from '../document-text';
import type { RockyRepositoryV2, SearchOptions } from './types';
import {
  defaultProgramKindRank,
  parseProgramSearch,
  programMatchesCriteria,
  programNameScore,
} from './program-search';
import { CURRENT_MENU_VENUE_NAME, diningVenueRecord } from '../dining-venues';
import { readValidityFromNotes } from '../validity';

type JsonRecord = Record<string, unknown>;

function configuredDataRoot(rootDir?: string): string {
  return rootDir || process.env.ROCKY_DATA_ROOT || DATA_ROOT;
}

function readJson<T>(rootDir: string, relativePath: string): T {
  return JSON.parse(
    fs.readFileSync(path.join(/*turbopackIgnore: true*/ rootDir, relativePath), 'utf-8')
  ) as T;
}

function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const SEARCH_STOP_WORDS = new Set([
  'a',
  'about',
  'an',
  'and',
  'any',
  'are',
  'as',
  'at',
  'be',
  'by',
  'campus',
  'can',
  'club',
  'clubs',
  'college',
  'contact',
  'contacts',
  'could',
  'degree',
  'degrees',
  'did',
  'do',
  'does',
  'email',
  'emails',
  'event',
  'events',
  'find',
  'for',
  'from',
  'get',
  'give',
  'groupme',
  'had',
  'has',
  'have',
  'how',
  'i',
  'in',
  'info',
  'information',
  'into',
  'is',
  'it',
  'know',
  'link',
  'links',
  'list',
  'looking',
  'major',
  'majors',
  'me',
  'meeting',
  'meetings',
  'minor',
  'minors',
  'my',
  'number',
  'numbers',
  'of',
  'office',
  'on',
  'or',
  'organization',
  'organizations',
  'org',
  'orgs',
  'our',
  'phone',
  'please',
  'program',
  'programs',
  'ramapo',
  'school',
  'show',
  'student',
  'students',
  'tell',
  'that',
  'the',
  'their',
  'there',
  'they',
  'this',
  'today',
  'tomorrow',
  'tonight',
  'to',
  'upcoming',
  'us',
  'want',
  'was',
  'we',
  'what',
  'when',
  'where',
  'which',
  'who',
  'why',
  'will',
  'website',
  'week',
  'weekend',
  'with',
  'would',
  'you',
  'your',
]);

const CONCEPT_ALIASES: Record<string, string[]> = {
  cs: ['computer', 'science', 'programming', 'coding', 'software'],
  code: ['computer', 'science', 'programming', 'coding', 'software', 'technology'],
  coding: ['computer', 'science', 'programming', 'code', 'software', 'technology'],
  programmer: ['computer', 'science', 'programming', 'coding', 'software'],
  programming: ['computer', 'science', 'coding', 'software', 'technology'],
  software: ['computer', 'science', 'programming', 'coding'],
  ai: ['artificial', 'intelligence', 'data', 'science', 'computer'],
  ping: ['ping', 'pong', 'table', 'tennis'],
  pong: ['ping', 'pong', 'table', 'tennis'],
  tennis: ['tennis', 'table', 'ping', 'pong'],
  esport: ['esports', 'gaming', 'gamers', 'video', 'games'],
  esports: ['esport', 'gaming', 'gamers', 'video', 'games'],
  game: ['gamers', 'gaming', 'esports', 'rhythm', 'trading'],
  gaming: ['gamers', 'game', 'esports', 'video'],
  gym: ['bradley', 'center', 'fitness', 'athletic', 'recreation'],
  workout: ['bradley', 'center', 'fitness', 'athletic', 'recreation'],
  fitness: ['bradley', 'center', 'gym', 'workout', 'athletic'],
  swim: ['pool', 'bradley', 'center', 'aquatics'],
  pool: ['swim', 'bradley', 'center', 'aquatics'],
  psych: ['psychology', 'psychological', 'sshs', 'sssw'],
  psychology: ['psych', 'psychological', 'sshs', 'sssw'],
  bio: ['biology', 'biological', 'bioinformatics', 'tas', 'snh'],
  chem: ['chemistry', 'chemical', 'tas', 'snh'],
  math: ['mathematics', 'math', 'tas'],
};

function tokens(value: string): string[] {
  return Array.from(
    new Set(
      normalize(value)
        .split(' ')
        .filter((token) => (token.length >= 3 || token === 'cs' || token === 'ai' || token === 'it') && !SEARCH_STOP_WORDS.has(token))
    )
  );
}

function tokenMatches(queryToken: string, textToken: string): boolean {
  if (queryToken === textToken) return true;

  const aliases = CONCEPT_ALIASES[queryToken];
  if (aliases && aliases.includes(textToken)) return true;

  const reverseAliases = CONCEPT_ALIASES[textToken];
  if (reverseAliases && reverseAliases.includes(queryToken)) return true;

  if (queryToken.length < 4 || textToken.length < 4) return false;
  return queryToken.startsWith(textToken) || textToken.startsWith(queryToken);
}

function textScore(query: string, text: string): number {
  const queryTokens = tokens(query);
  if (queryTokens.length === 0) return 0;
  const textTokens = tokens(text);
  const overlap = queryTokens.filter((queryToken) =>
    textTokens.some((textToken) => tokenMatches(queryToken, textToken))
  ).length;
  return overlap / queryTokens.length;
}

function withCollectedAt(source: SourceReference, collectedAt?: string): SourceReference {
  return { ...source, ...(collectedAt ? { collectedAt } : {}) };
}

function currentVersion(rootDir: string): DatasetContext {
  try {
    const marker = readJson<Record<string, string>>(rootDir, 'data/cache/corpus-version.json');
    const version = createHash('sha1').update(JSON.stringify(marker)).digest('hex').slice(0, 12);
    return {
      id: `file-${version}`,
      version: `file-${version}`,
      activatedAt: marker.updatedAt || new Date(0).toISOString(),
    };
  } catch {
    return {
      id: 'file-development',
      version: 'file-development',
      activatedAt: new Date(0).toISOString(),
    };
  }
}

const CRITICAL_FACTS: Record<string, { value: string; source: SourceReference }> = {
  'safety.emergency_phone': { value: '201-684-6666', source: V2_SOURCES.safety },
  'safety.non_emergency_phone': { value: '201-684-7432', source: V2_SOURCES.safety },
  'safety.id_card_room_phone': { value: '201-684-7789', source: V2_SOURCES.safety },
  'safety.id_card_room_location': { value: 'C-101', source: V2_SOURCES.safety },
  'safety.id_card_room_email': { value: 'publicsafety@ramapo.edu', source: V2_SOURCES.safety },
  'password.reset_url': { value: 'https://password.ramapo.edu/', source: V2_SOURCES.password },
  'printing.free_pages_per_academic_year': { value: '200', source: V2_SOURCES.technology },
  'tuition.nj_12_18_semester': { value: '$8,807.68', source: V2_SOURCES.tuition },
  'calendar.spring2026.add_drop_100_refund.full': {
    value: 'January 26, 2026',
    source: V2_SOURCES.calendar,
  },
  'calendar.spring2026.spring_break.start': {
    value: 'March 15, 2026',
    source: V2_SOURCES.calendar,
  },
  'calendar.spring2026.spring_break.end': { value: 'March 22, 2026', source: V2_SOURCES.calendar },
  'calendar.spring2026.finals.start': { value: 'May 6, 2026', source: V2_SOURCES.calendar },
  'shuttle.ramsey_route17.express.first_departure': {
    value: '7:00 AM',
    source: V2_SOURCES.transportation,
  },
  'shuttle.ramsey_route17.express.last_dropoff': {
    value: '5:40 PM',
    source: V2_SOURCES.transportation,
  },
};

function criticalFactTimestamp(rootDir: string, key: string): string {
  const relativePath = key.startsWith('calendar.')
    ? 'data/normalized/calendar.json'
    : key.startsWith('shuttle.')
      ? 'src/data/shuttleSchedule.ts'
      : key.startsWith('safety.')
        ? 'data/context/campus/safety.md'
        : key.startsWith('tuition.')
          ? 'data/context/academic/programs.md'
          : 'data/README.md';
  try {
    return fs
      .statSync(path.join(/*turbopackIgnore: true*/ rootDir, relativePath))
      .mtime.toISOString();
  } catch {
    return new Date(0).toISOString();
  }
}

function rawDatasetCollectedAt(value: unknown): string | undefined {
  if (value && typeof value === 'object' && 'collectedAt' in value) {
    const collectedAt = (value as { collectedAt?: unknown }).collectedAt;
    return typeof collectedAt === 'string' ? collectedAt : undefined;
  }
  return undefined;
}

export class FileRepositoryV2 implements RockyRepositoryV2 {
  private readonly rootDir: string;

  constructor(rootDir?: string) {
    this.rootDir = configuredDataRoot(rootDir);
  }

  private readJson<T>(relativePath: string): T {
    return readJson<T>(this.rootDir, relativePath);
  }

  withDataset(): RockyRepositoryV2 {
    // File mode serves one deterministic checked-out version; there is no
    // activation race to pin against.
    return this;
  }

  async getDatasetContext(): Promise<DatasetContext> {
    return currentVersion(this.rootDir);
  }

  async getCriticalFact(key: string): Promise<CriticalFactRecord | null> {
    const fact = CRITICAL_FACTS[key];
    if (!fact) return null;
    const verifiedAt = criticalFactTimestamp(this.rootDir, key);
    return {
      key,
      value: fact.value,
      source: withCollectedAt(fact.source, verifiedAt),
      verifiedAt,
    };
  }

  async listDiningVenues(): Promise<DiningVenueRecord[]> {
    const raw = this.readJson<JsonRecord>('data/normalized/dining-hours.json');
    const regions = (((raw.composition as JsonRecord)?.subject as JsonRecord)?.regions ||
      []) as JsonRecord[];
    const names = regions.flatMap((region) =>
      ((region.fragments as JsonRecord[]) || []).flatMap((fragment) => {
        const main = ((fragment.content as JsonRecord)?.main || {}) as JsonRecord;
        return typeof main.name === 'string' && main.name.trim() ? [main.name.trim()] : [];
      })
    );
    return [...new Set([...names, CURRENT_MENU_VENUE_NAME])].map(diningVenueRecord);
  }

  async findMenuItems(query: string, meal?: string): Promise<MenuItemRecord[]> {
    const meals = this.readJson<
      Array<{ name: string; groups?: Array<{ name: string; items?: JsonRecord[] }> }>
    >('data/normalized/menu.json');
    const records: MenuItemRecord[] = [];
    for (const mealGroup of meals) {
      if (meal && normalize(mealGroup.name) !== normalize(meal)) continue;
      for (const station of mealGroup.groups || []) {
        for (const item of station.items || []) {
          const name = typeof item.formalName === 'string' ? item.formalName : '';
          if (!name) continue;
          const searchable = `${mealGroup.name} ${station.name} ${name}`;
          const score = textScore(query, searchable);
          // Only the explicit empty string means "list the dataset." A
          // non-empty query made entirely of stop words must not become a
          // wildcard and silently return unrelated records.
          if (query.trim() && score < 1) continue;
          records.push({
            meal: mealGroup.name,
            station: station.name,
            name,
            calories: typeof item.calories === 'string' ? item.calories : undefined,
            vegan: item.isVegan === true,
            vegetarian: item.isVegetarian === true,
            allergens: Array.isArray(item.allergens)
              ? item.allergens.flatMap((entry) =>
                  entry &&
                  typeof entry === 'object' &&
                  typeof (entry as JsonRecord).name === 'string'
                    ? [(entry as JsonRecord).name as string]
                    : []
                )
              : [],
            source: V2_SOURCES.dining,
          });
        }
      }
    }
    return records.slice(0, 12);
  }

  async findDiningHours(query: string, day: string, at?: Date): Promise<HoursRecord[]> {
    const raw = this.readJson<JsonRecord>('data/normalized/dining-hours.json');
    const regions = (((raw.composition as JsonRecord)?.subject as JsonRecord)?.regions ||
      []) as JsonRecord[];
    const records: HoursRecord[] = [];
    for (const region of regions) {
      for (const fragment of (region.fragments as JsonRecord[]) || []) {
        const main = ((fragment.content as JsonRecord)?.main || {}) as JsonRecord;
        const name = typeof main.name === 'string' ? main.name : '';
        if (!name || (query.trim() && textScore(query, name) < 1)) continue;
        const openingHours = (main.openingHours || {}) as JsonRecord;
        // PROB-010: an active dated exception governs the answer for that
        // instant; standard weekly hours apply only outside every season.
        if (at) {
          const seasonal = activeSeasonSchedule(openingHours, day, at);
          if (seasonal !== null) {
            records.push({ name, day, schedule: seasonal, source: V2_SOURCES.dining });
            continue;
          }
        }
        for (const group of (openingHours.standardHours as JsonRecord[]) || []) {
          const days = ((group.days as JsonRecord[]) || []).flatMap((entry) =>
            typeof entry.value === 'string' ? [entry.value] : []
          );
          if (!days.includes(day)) continue;
          const schedules = ((group.hours as JsonRecord[]) || []).map((range) => {
            const start = range.startTime as JsonRecord | undefined;
            const finish = range.finishTime as JsonRecord | undefined;
            if (!start || !finish) return 'Closed';
            return `${start.hour}:${start.minute} ${start.period} - ${finish.hour}:${finish.minute} ${finish.period}`;
          });
          records.push({
            name,
            day,
            schedule: schedules.join('; ') || 'Closed',
            source: V2_SOURCES.dining,
          });
        }
      }
    }
    return records;
  }

  async listCampusHourVenues(): Promise<string[]> {
    return this.readJson<Array<{ name: string }>>('data/normalized/hours.json')
      .map((location) => location.name)
      .sort();
  }

  async findCampusHoursByVenue(name: string, day: string, at?: Date): Promise<HoursRecord[]> {
    // A broad hours lookup is capped at eight rows. Filtering that truncated
    // result made exact lookup silently fail for venues later in the file (J.
    // Lee's and the bookstore among them). Search by the exact stored name
    // first, then retain the equality guard so this path cannot return a nearby
    // venue.
    return (await this.findCampusHours(name, day, at)).filter((record) => record.name === name);
  }

  async findDiningHoursByVenue(name: string, day: string, at?: Date): Promise<HoursRecord[]> {
    return (await this.findDiningHours('', day, at)).filter((record) => record.name === name);
  }

  async findCampusHours(query: string, day: string, at?: Date): Promise<HoursRecord[]> {
    const locations = this.readJson<
      Array<{ name: string; hours: Record<string, string>; notes?: string }>
    >('data/normalized/hours.json');
    // A schedule whose note bounds it to a past term does not describe today.
    // Postgres enforces this through valid_from/valid_until; the file
    // repository has to read the same window out of the note itself.
    const onDate = at ? at.toISOString().slice(0, 10) : null;
    return locations
      .filter((location) => {
        if (!onDate) return true;
        const { window } = readValidityFromNotes(location.notes);
        if (!window) return true;
        return onDate >= window.validFrom && onDate <= window.validUntil;
      })
      .map((location) => ({ location, score: textScore(query, location.name) }))
      .filter(({ score }) => !query.trim() || score >= 1)
      .sort((a, b) => b.score - a.score)
      .map(({ location }) => ({
        name: location.name,
        day,
        schedule: location.hours[day] || 'Unknown',
        source: V2_SOURCES.hours,
      }))
      .slice(0, 8);
  }

  async findAcademicDates(query: string): Promise<AcademicDateRecord[]> {
    const terms = this.readJson<
      Array<{ name: string; events: Array<{ date: string; title: string; description?: string }> }>
    >('data/normalized/calendar.json');
    const records = terms.flatMap((term) =>
      term.events.map((event) => ({
        term: term.name,
        date: event.date,
        title: event.title,
        description: event.description,
        source: V2_SOURCES.calendar,
      }))
    );
    return records
      .map((record) => ({
        record,
        score: textScore(query, `${record.term} ${record.title} ${record.date}`),
      }))
      .filter(({ score }) => score >= 1)
      .sort((a, b) => b.score - a.score)
      .map(({ record }) => record)
      .slice(0, 5);
  }

  async findEvents(query: string, now: Date): Promise<EventRecord[]> {
    const events = this.readJson<Array<JsonRecord>>('data/normalized/events.json');
    return (
      events
        .flatMap((event): Array<{ record: EventRecord; startsAtMs: number }> => {
          if (typeof event.title !== 'string' || typeof event.date !== 'string') return [];
          const startParse = parseEventStart(
            event.date,
            typeof event.time === 'string' ? event.time : undefined
          );
          const startsAtMs = startParse.ok
            ? Date.parse(startParse.startsAtIso)
            : Date.parse(event.date);
          if (Number.isFinite(startsAtMs) && startsAtMs < now.getTime() - 24 * 60 * 60 * 1000) {
            return [];
          }
          const record: EventRecord = {
            title: event.title,
            date: event.date,
            startTime: typeof event.time === 'string' ? event.time : undefined,
            endTime: typeof event.endTime === 'string' ? event.endTime : undefined,
            organizer: typeof event.organizer === 'string' ? event.organizer : undefined,
            description: typeof event.description === 'string' ? event.description : undefined,
            eventUrl: typeof event.url === 'string' ? event.url : undefined,
            source: V2_SOURCES.events,
          };
          return [
            {
              record,
              startsAtMs: Number.isFinite(startsAtMs) ? startsAtMs : Number.POSITIVE_INFINITY,
            },
          ];
        })
        // Chronological base order; the stable relevance sort below keeps
        // equally scored events nearest-first.
        .sort((a, b) => a.startsAtMs - b.startsAtMs)
        .map(({ record }) => ({
          record,
          score: textScore(
            query,
            `${record.title} ${record.organizer || ''} ${record.description || ''}`
          ),
        }))
        .filter(({ score }) => !query.trim() || score >= 1)
        .sort((a, b) => b.score - a.score)
        .map(({ record }) => record)
        // Event handlers apply relative-date windows (today, weekend, named
        // weekdays) after retrieval. Keep enough chronologically ordered
        // candidates so a later matching day is not hidden behind five nearer
        // events.
        .slice(0, 40)
    );
  }

  async findClubs(query: string): Promise<ClubRecord[]> {
    const clubs = this.readJson<Array<JsonRecord>>('data/normalized/clubs.json');
    return clubs
      .flatMap((club): ClubRecord[] =>
        typeof club.name === 'string'
          ? [
              {
                name: club.name,
                category: typeof club.category === 'string' ? club.category : undefined,
                websiteUrl: typeof club.websiteUrl === 'string' ? club.websiteUrl : undefined,
                source: V2_SOURCES.clubs,
              },
            ]
          : []
      )
      .map((record) => ({
        record,
        score: textScore(query, `${record.name} ${record.category || ''}`),
      }))
      .filter(({ score }) => !query.trim() || score > 0)
      .sort((a, b) => b.score - a.score)
      .map(({ record }) => record)
      .slice(0, 8);
  }

  async findPrograms(query: string): Promise<ProgramRecord[]> {
    const payload = this.readJson<{
      generatedAt?: string;
      schools?: Array<{ school: string; majors?: JsonRecord[] }>;
    }>('public/data/programs.json');
    const source = withCollectedAt(V2_SOURCES.programs, payload.generatedAt);
    const records = (payload.schools || []).flatMap((school) =>
      (school.majors || []).flatMap((major): ProgramRecord[] =>
        typeof major.name === 'string'
          ? [
              {
                name: major.name,
                degree: typeof major.degree === 'string' ? major.degree : undefined,
                programKind:
                  major.programKind === 'major' ||
                  major.programKind === 'minor' ||
                  major.programKind === 'certificate' ||
                  major.programKind === 'undeclared' ||
                  major.programKind === 'other' ||
                  major.programKind === 'special'
                    ? major.programKind
                    : undefined,
                school: school.school,
                description: typeof major.description === 'string' ? major.description : undefined,
                programUrl: typeof major.url === 'string' ? major.url : undefined,
                source,
              },
            ]
          : []
      )
    );
    const criteria = parseProgramSearch(query);
    return records
      .filter((record) => programMatchesCriteria(record, criteria))
      .map((record) => ({ record, score: programNameScore(record, criteria) }))
      .filter(({ score }) => score >= 1)
      .sort(
        (a, b) =>
          b.score - a.score ||
          defaultProgramKindRank(a.record, criteria) - defaultProgramKindRank(b.record, criteria)
      )
      .map(({ record }) => record)
      .slice(0, 6);
  }

  async listContacts(): Promise<Array<{ name: string; department?: string }>> {
    return (await this.findContacts('')).map((record) => ({
      name: record.name,
      department: record.department,
    }));
  }

  async findContactByName(name: string): Promise<ContactRecord[]> {
    return (await this.findContacts('')).filter((record) => record.name === name);
  }

  async findContacts(query: string): Promise<ContactRecord[]> {
    let facultyRecords: Array<ContactRecord & { searchable: string }> = [];
    try {
      const rawFaculty = this.readJson<Array<JsonRecord>>('data/normalized/faculty.json');
      facultyRecords = rawFaculty.flatMap((f) => {
        if (typeof f.name !== 'string') return [];
        const title = typeof f.title === 'string' ? f.title : '';
        const school = typeof f.school === 'string' ? f.school : '';
        const department = title ? `${title} (${school})` : school;
        const phone = typeof f.phone === 'string' && f.phone.trim().length > 0 ? f.phone : undefined;
        const email = typeof f.email === 'string' && f.email.trim().length > 0 ? f.email : undefined;
        const office = typeof f.office === 'string' && f.office.trim().length > 0 ? f.office : undefined;
        const bio = typeof f.bio === 'string' ? f.bio : '';
        const profileUrl = typeof f.profileUrl === 'string' ? f.profileUrl : 'https://www.ramapo.edu/directory/';
        return [{
          name: f.name,
          department: department || undefined,
          phone,
          email,
          office,
          source: {
            sourceId: 'faculty-directory',
            title: `${f.name} - Directory Profile`,
            url: profileUrl,
          },
          searchable: `${f.name} ${title} ${school} ${office || ''} ${email || ''} ${bio}`,
        }];
      });
    } catch {
      // ignore
    }

    const records: Array<ContactRecord & { searchable: string }> = [
      ...OFFICE_DIRECTORY_CONTACTS.map((entry) => ({
        name: entry.name,
        department: entry.department,
        phone: entry.phone,
        email: entry.email,
        office: entry.office,
        source: V2_SOURCES.directory,
        searchable: `${entry.name} ${entry.department || ''} ${entry.office || ''} ${entry.helpsWith ? entry.helpsWith.join(' ') : ''}`,
      })),
      ...OTHER_DIRECTORY_CONTACTS.map((entry) => ({
        name: entry.name,
        department: entry.unit,
        phone: entry.phone,
        email: entry.email,
        source: V2_SOURCES.directory,
        searchable: `${entry.name} ${entry.unit || ''}`,
      })),
      ...facultyRecords,
    ];
    return records
      .map((item) => ({
        record: {
          name: item.name,
          department: item.department,
          phone: item.phone,
          email: item.email,
          office: item.office,
          source: item.source,
        },
        score: textScore(query, item.searchable),
      }))
      .filter(({ score }) => !query.trim() || score > 0)
      .sort((a, b) => b.score - a.score)
      .map(({ record }) => record)
      .slice(0, 6);
  }

  async getShuttleTrips(
    routeHint?: string,
    serviceDay?: ShuttleServiceDay
  ): Promise<ShuttleTripRecord[]> {
    const normalizedHint = normalize(routeHint || '');
    const source = V2_SOURCES.transportation;
    const day = serviceDay ?? 'weekday';
    if (normalizedHint.includes('ramsey') || normalizedHint.includes('route 17')) {
      // The Ramsey Route 17 Express loop runs on weekdays only.
      if (day !== 'weekday') return [];
      return shuttleSchedule.trainLoop.map((trip) => ({
        route: 'Ramsey Route 17 Express',
        ...trip,
        source,
      }));
    }
    const timetables: Record<ShuttleServiceDay, { route: string; trips: ShuttleRoute[] }> = {
      weekday: { route: 'Weekday Roadrunner Express', trips: shuttleSchedule.weekday },
      saturday: { route: 'Saturday Roadrunner Express', trips: shuttleSchedule.saturday },
      sunday: { route: 'Sunday Roadrunner Express', trips: shuttleSchedule.sunday },
    };
    const timetable = timetables[day];
    return timetable.trips.map((trip) => ({ route: timetable.route, ...trip, source }));
  }

  async listShuttleTrips(serviceDay: ShuttleServiceDay): Promise<ShuttleTripRecord[]> {
    const source = V2_SOURCES.transportation;
    const timetables: Record<ShuttleServiceDay, { route: string; trips: ShuttleRoute[] }> = {
      weekday: { route: 'Weekday Roadrunner Express', trips: shuttleSchedule.weekday },
      saturday: { route: 'Saturday Roadrunner Express', trips: shuttleSchedule.saturday },
      sunday: { route: 'Sunday Roadrunner Express', trips: shuttleSchedule.sunday },
    };
    const timetable = timetables[serviceDay];
    const trips = timetable.trips.map((trip) => ({ route: timetable.route, ...trip, source }));
    if (serviceDay !== 'weekday') return trips;
    return [
      ...trips,
      ...shuttleSchedule.trainLoop.map((trip) => ({
        route: 'Ramsey Route 17 Express',
        ...trip,
        source,
      })),
    ];
  }

  async searchDocuments(query: string, options: SearchOptions): Promise<EvidenceItem[]> {
    const root = path.join(/*turbopackIgnore: true*/ this.rootDir, 'data', 'context');
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.md')) files.push(full);
      }
    };
    walk(root);

    // Context filenames identify their dataset; directory names cover the
    // grouped dining files. Aliases map generated names onto source keys so
    // citations identify the real official page, not the homepage.
    const sourceAliases: Record<string, string> = { menu: 'dining', 'live-events': 'events' };

    return files
      .flatMap((file) => {
        const relative = path.relative(root, file).replace(/\\/g, '/');
        const baseName = path.basename(relative, '.md');
        const sourceKey = sourceAliases[baseName] || baseName;
        const topLevel = relative.split('/')[0];
        const domain = topLevel === 'dining'
          ? 'dining'
          : sourceKey === 'faculty'
            ? 'directory'
            : sourceKey;
        const fallbackSource = V2_SOURCES[topLevel === 'dining' ? 'dining' : sourceKey];
        if (options.domains.length > 0 && !options.domains.includes(domain)) return [];
        // Strip only a leading YAML frontmatter block. The previous
        // multiline-anchored pattern matched the first pair of "---" section
        // separators anywhere in the document and silently deleted the whole
        // first content section (including the Health appointment
        // instruction), which is part of PROB-012.
        const content = fs
          .readFileSync(file, 'utf-8')
          .replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '');
        return (
          content
            // H3 sections belong to the current H2 source page. Keeping them
            // together preserves the page URL for Key Details, Contacts, and
            // Documents instead of falling back to the dataset homepage.
            .split(/\n(?=#{1,2}\s)/)
            .flatMap((rawChunk, index) => {
              // Ingestion bookkeeping is never answerable content (PROB-012):
              // the document preamble chunk disappears entirely and section
              // metadata lines leave the retrievable text. The section URL is
              // extracted first so the citation stays page-specific.
              const sectionUrl = extractSectionUrl(rawChunk);
              const chunk = stripIngestionMetadata(rawChunk);
              if (chunk.length <= 40) return [];
              const score = textScore(query, chunk);
              const documentId = `file-document:${createHash('sha256')
                .update(relative)
                .digest('hex')}`;
              const chunkId = `file-chunk:${createHash('sha256')
                .update(`${relative}\0${index}\0${chunk}`)
                .digest('hex')}`;
              return [
                {
                  id: chunkId,
                  documentId,
                  sourceId: fallbackSource?.sourceId || `context:${relative}`,
                  title: chunk.match(/^#{1,3}\s+(.+)$/m)?.[1]?.trim() || relative,
                  url: sectionUrl || fallbackSource?.url || 'https://www.ramapo.edu/',
                  content: chunk,
                  domain,
                  trustTier: 'official_primary' as const,
                  collectedAt: fs.statSync(file).mtime.toISOString(),
                  score,
                },
              ];
            })
        );
      })
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
      .slice(0, options.limit);
  }
}

export function fileDatasetCollectedAt(
  relativePath: string,
  rootDir = configuredDataRoot()
): string | undefined {
  try {
    return rawDatasetCollectedAt(readJson<unknown>(rootDir, relativePath));
  } catch {
    return undefined;
  }
}
