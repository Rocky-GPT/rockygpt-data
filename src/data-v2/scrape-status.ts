import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { SOURCES } from './source-seeds';
import { DATA_ROOT } from '../paths';

export type CollectionMode = 'API' | 'HTML crawl' | 'Browser' | 'Hybrid';
export type ArtifactRole = 'primary' | 'supplemental';
export type TimestampBasis =
  'collector-provenance' | 'embedded-timestamp' | 'file-modified-estimate' | 'missing';
export type FreshnessStatus = 'fresh' | 'stale' | 'unknown' | 'manual';

export interface ScrapeArtifactDefinition {
  label: string;
  file: string;
  role: ArtifactRole;
  provenanceDataset?: string;
  timestampFile?: string;
  recordLabel?: string;
}

export interface ScrapeSourceDefinition {
  id: string;
  title: string;
  category: string;
  sourceKey?: string;
  mode: CollectionMode;
  summary: string;
  capturedData: string[];
  method: string;
  automation: string;
  commands: string[];
  sourceUrls: Array<{ label: string; url: string }>;
  artifacts: ScrapeArtifactDefinition[];
  caveat?: string;
}

export interface ScrapeArtifactStatus extends ScrapeArtifactDefinition {
  exists: boolean;
  fetchedAt: string | null;
  timestampBasis: TimestampBasis;
  timestampDetail: string;
  summary?: string;
}

export interface ScrapeSourceStatus extends Omit<ScrapeSourceDefinition, 'artifacts'> {
  artifacts: ScrapeArtifactStatus[];
  freshnessHours: number | null;
  freshnessStatus: FreshnessStatus;
  ageHours: number | null;
  lastFetchedAt: string | null;
  timestampBasis: TimestampBasis;
}

const SCRAPE_SOURCES: ScrapeSourceDefinition[] = [
  {
    id: 'dining-menu',
    title: 'Dining menu',
    category: 'Dining',
    sourceKey: 'dining',
    mode: 'API',
    summary: 'Birch Tree Inn menu snapshots for today and the next six days.',
    capturedData: [
      'Meal periods and stations',
      'Item names and descriptions',
      'Calories, allergens, and dietary flags',
    ],
    method:
      'The shared HTTP collector calls the Sodexo menu API once per Eastern-calendar day with retries, timeouts, response-size limits, and JSON content-type checks. It writes today’s raw payload plus a seven-day snapshot, validates each menu section, and generates JSON and retrieval context.',
    automation:
      'The daily publication job checks the 24-hour source SLA and refreshes this collector when stale or close to expiry.',
    commands: ['npm run fetch:menu', 'npm run refresh:daily'],
    sourceUrls: [
      {
        label: 'Sodexo menu API',
        url: 'https://api-prd.sodexomyway.net/v0.2/data/menu/97508001/15858',
      },
      { label: 'Ramapo Dining', url: 'https://ramapo.sodexomyway.com/' },
    ],
    artifacts: [
      {
        label: 'Current menu raw payload',
        file: 'data/raw/menu.raw.json',
        timestampFile: 'data/raw/menu-week.raw.json',
        provenanceDataset: 'menu',
        recordLabel: 'sections',
        role: 'primary',
      },
      {
        label: 'Seven-day raw snapshot',
        file: 'data/raw/menu-week.raw.json',
        recordLabel: 'days',
        role: 'supplemental',
      },
    ],
  },
  {
    id: 'dining-hours',
    title: 'Dining location hours',
    category: 'Dining',
    sourceKey: 'dining',
    mode: 'HTML crawl',
    summary: 'Standard and seasonal operating hours for Sodexo dining locations.',
    capturedData: ['Location names', 'Standard weekly hours', 'Seasonal date ranges and hours'],
    method:
      'The shared HTTP collector downloads the public dining-hours page with retries, timeouts, and HTML content-type checks. It then extracts and parses the JSON assigned to window.__PRELOADED_STATE__ instead of scraping rendered text.',
    automation:
      'The publication job treats dining menu and dining hours as one 24-hour source and refreshes both together near expiry.',
    commands: ['npm run fetch:dining-hours', 'npm run refresh:weekly'],
    sourceUrls: [
      {
        label: 'Dining hours',
        url: 'https://ramapo.sodexomyway.com/en-us/locations/hours',
      },
    ],
    artifacts: [
      {
        label: 'Dining-hours application state',
        file: 'data/raw/dining-hours.raw.json',
        provenanceDataset: 'dining-hours',
        role: 'primary',
      },
    ],
  },
  {
    id: 'events',
    title: 'Campus events',
    category: 'Campus life',
    sourceKey: 'archway-events',
    mode: 'Hybrid',
    summary: 'Upcoming Archway events and optional detail-page signals.',
    capturedData: [
      'Title, date, time, and location',
      'Organizer, description, image, tags, and ticket status',
      'Free-food and snack signals from event detail pages',
    ],
    method:
      'Without credentials, fetch requests establish a public Archway session and paginate the mobile events endpoint. With credentials, Playwright signs in, scrolls the events page, and scrapes the DOM. Detail pages are fetched concurrently and parsed with Cheerio.',
    automation: 'The daily job forces a live refresh and enforces a 24-hour publication SLA.',
    commands: ['npm run fetch:events:live', 'npm run refresh:daily'],
    sourceUrls: [
      { label: 'Archway events', url: 'https://archway.ramapo.edu/events' },
      { label: 'Public event listing', url: 'https://archway.ramapo.edu/home/events/' },
    ],
    artifacts: [
      {
        label: 'Event listing',
        file: 'data/raw/events.raw.json',
        provenanceDataset: 'events',
        recordLabel: 'events',
        role: 'primary',
      },
      {
        label: 'Event detail pages',
        file: 'data/raw/events-detail.raw.json',
        recordLabel: 'pages',
        role: 'supplemental',
      },
      {
        label: 'Extracted event signals',
        file: 'data/raw/events-signals.raw.json',
        recordLabel: 'signals',
        role: 'supplemental',
      },
    ],
    caveat:
      'The public fallback refreshes event listings but can reuse older cached detail signals when authenticated detail access is unavailable.',
  },
  {
    id: 'campus-hours',
    title: 'Campus and facility hours',
    category: 'Campus services',
    sourceKey: 'campus-hours',
    mode: 'Hybrid',
    summary:
      'Hours for campus offices, library spaces, recreation facilities, CSI, and the bookstore.',
    capturedData: ['Weekly schedules', 'Closures', 'Seasonal and operational notes'],
    method:
      'Playwright loads the Ramapo Athletics hours page and parses visible text into facility schedules. The collector then combines those scraped athletics hours with manually structured schedules for several other campus locations.',
    automation:
      'Checked daily by the publication workflow against a 180-day SLA; the direct semester refresh command also runs it.',
    commands: ['npm run fetch:hours', 'npm run refresh:semesterly'],
    sourceUrls: [
      {
        label: 'Bradley Center hours',
        url: 'https://ramapoathletics.com/sports/2008/1/21/bradleycenterhours.aspx',
      },
      {
        label: 'Campus hours reference',
        url: 'https://www.ramapo.edu/about/campus-hours/',
      },
    ],
    artifacts: [
      {
        label: 'Compiled location hours',
        file: 'data/raw/hours.raw.json',
        provenanceDataset: 'hours',
        recordLabel: 'locations',
        role: 'primary',
      },
    ],
    caveat:
      'Only athletics facility hours are live-scraped by this collector. Administrative, library, CSI, J. Lee’s, Game Lab, and bookstore schedules are currently hard-coded in the script.',
  },
  {
    id: 'clubs',
    title: 'Student organizations and club contacts',
    category: 'Campus life',
    sourceKey: 'archway-clubs',
    mode: 'Hybrid',
    summary:
      'Archway organization listings enriched with public club pages and optional authenticated contact sources.',
    capturedData: [
      'Organization name, category, bucket, and logo',
      'Archway and external websites',
      'Email, social profiles, and GroupMe join links',
    ],
    method:
      'The primary collector uses logged-out fetch requests and Cheerio to parse the Archway organization list, then crawls public pages within each club scope concurrently. Optional Playwright scripts collect authenticated About-page contacts and GroupMe directory links; persisted GroupMe data is sanitized to public names and join URLs.',
    automation:
      'The primary public collector is checked daily against a 180-day SLA. Authenticated About and GroupMe enrichment is manual.',
    commands: [
      'npm run fetch:clubs',
      'npm run fetch:groupme-directory',
      'python3 core/scripts/fetch/archway-clubs-about.py',
    ],
    sourceUrls: [
      {
        label: 'Archway organizations',
        url: 'https://archway.ramapo.edu/club_signup?view=all&',
      },
      { label: 'GroupMe web app', url: 'https://web.groupme.com/' },
    ],
    artifacts: [
      {
        label: 'Organization listing',
        file: 'data/raw/clubs.raw.json',
        provenanceDataset: 'clubs',
        recordLabel: 'organizations',
        role: 'primary',
      },
      {
        label: 'Public club-page crawl',
        file: 'data/raw/clubs-detail.raw.json',
        recordLabel: 'pages',
        role: 'supplemental',
      },
      {
        label: 'Authenticated About pages',
        file: 'data/raw/clubs-about.raw.json',
        recordLabel: 'organizations',
        role: 'supplemental',
      },
      {
        label: 'GroupMe directory',
        file: 'data/raw/groupme-directory.raw.json',
        recordLabel: 'groups',
        role: 'supplemental',
      },
    ],
  },
  {
    id: 'academic-calendar',
    title: 'Academic and housing dates',
    category: 'Academics',
    sourceKey: 'academic-calendar',
    mode: 'Browser',
    summary:
      'Current and future semester dates, with optional Residence Life dates merged into the output.',
    capturedData: [
      'Semester names',
      'Event dates and titles',
      'Descriptions and housing deadlines',
    ],
    method:
      'Playwright renders the current and future academic-calendar pages and extracts event DOM nodes. A separate manual Playwright collector reads the Residence Life dates page as visible text and converts its semester/date blocks before the main calendar generator merges them.',
    automation:
      'The academic calendar is checked daily against a seven-day SLA. The Residence Life supplement is not part of the scheduled publication refresh.',
    commands: [
      'npm run fetch:calendar',
      'npx tsx core/scripts/fetch/reslife-calendar.ts',
      'npm run refresh:semesterly',
    ],
    sourceUrls: [
      { label: 'Academic calendars', url: 'https://www.ramapo.edu/academic-calendars/' },
      {
        label: 'Future calendars',
        url: 'https://www.ramapo.edu/academic-calendars/future-calendars/',
      },
      {
        label: 'Housing dates',
        url: 'https://www.ramapo.edu/reslife/critical-housing-dates-deadlines-calendar/',
      },
    ],
    artifacts: [
      {
        label: 'Academic calendar',
        file: 'data/raw/calendar.raw.json',
        provenanceDataset: 'calendar',
        recordLabel: 'semesters',
        role: 'primary',
      },
      {
        label: 'Residence Life calendar',
        file: 'data/normalized/reslife.json',
        recordLabel: 'semesters',
        role: 'supplemental',
      },
    ],
  },
  {
    id: 'faculty',
    title: 'Faculty and library profiles',
    category: 'Academics',
    sourceKey: 'faculty',
    mode: 'HTML crawl',
    summary: 'Faculty, adjunct, retired faculty, and library staff profiles.',
    capturedData: [
      'Name, title, school, email, phone, and office',
      'Bio, education, courses, teaching and research interests',
      'Publications, profile URLs, and profile images',
    ],
    method:
      'Axios and Cheerio parse school faculty lists, follow individual profile pages with a concurrency limit of five, scrape library staff cards, and download profile images for local serving.',
    automation:
      'Checked daily against a 30-day SLA; also included in the direct semester refresh command.',
    commands: ['npm run fetch:faculty', 'npm run refresh:semesterly'],
    sourceUrls: [
      { label: 'Faculty directory', url: 'https://www.ramapo.edu/academics/faculty/' },
      { label: 'Library staff', url: 'https://www.ramapo.edu/library/staff/' },
    ],
    artifacts: [
      {
        label: 'Faculty profiles',
        file: 'data/raw/faculty.raw.json',
        provenanceDataset: 'faculty',
        recordLabel: 'profiles',
        role: 'primary',
      },
    ],
  },
  {
    id: 'programs',
    title: 'Programs, requirements, and courses',
    category: 'Academics',
    sourceKey: 'academic-programs',
    mode: 'Hybrid',
    summary: 'Catalog program pages plus structured Coursedog program and course records.',
    capturedData: [
      'Majors, minors, certificates, degrees, status, and descriptions',
      'Requirements, credits, concentrations, and learning outcomes',
      'Course descriptions, attributes, Gen Ed categories, and faculty links',
    ],
    method:
      'One collector uses the shared bounded/retrying HTTP client plus Cheerio to discover and crawl public catalog program, department, and course pages and parse embedded Nuxt payloads. A second collector calls the Coursedog REST API directly for structured programs and courses, then enriches the result with existing faculty data.',
    automation:
      'Both primary collectors must be current. The daily publication workflow checks them against a 180-day SLA.',
    commands: [
      'npm run fetch:programs:raw',
      'npm run fetch:programs:catalog',
      'npm run refresh:semesterly',
    ],
    sourceUrls: [
      { label: 'Ramapo catalog', url: 'https://catalog.ramapo.edu/programs' },
      {
        label: 'Coursedog API',
        url: 'https://app.coursedog.com/api/v1/cm/ramapo_banner_ethos',
      },
    ],
    artifacts: [
      {
        label: 'Catalog page crawl',
        file: 'data/raw/programs.raw.json',
        provenanceDataset: 'programs',
        recordLabel: 'pages',
        role: 'primary',
      },
      {
        label: 'Coursedog API programs',
        file: 'data/raw/catalog-programs-api.raw.json',
        provenanceDataset: 'catalog-programs',
        recordLabel: 'programs',
        role: 'primary',
      },
      {
        label: 'Embedded catalog payloads',
        file: 'data/raw/programs-payload.raw.json',
        recordLabel: 'entries',
        role: 'supplemental',
      },
      {
        label: 'Legacy catalog program scrape',
        file: 'data/raw/catalog-programs.raw.json',
        recordLabel: 'programs',
        role: 'supplemental',
      },
    ],
  },
  {
    id: 'directory',
    title: 'Campus directory',
    category: 'Campus services',
    sourceKey: 'campus-directory',
    mode: 'HTML crawl',
    summary: 'Campus office and contact information from Ramapo directory pages.',
    capturedData: [
      'Names and offices',
      'Email addresses and phone numbers',
      'Tables, lists, and linked documents',
    ],
    method:
      'The shared raw collector fetches two seed pages, follows matching directory URLs on ramapo.edu, and uses a bounded HTTP policy for retries, timeouts, per-host concurrency, content-type checks, and response-size limits. Cheerio extracts headings, sections, lists, tables, contacts, documents, and links.',
    automation: 'Checked daily against a seven-day SLA.',
    commands: ['npm run fetch:directory:raw', 'npm run refresh:raw:core6'],
    sourceUrls: [
      { label: 'Campus directory', url: 'https://www.ramapo.edu/campus-directory/' },
      { label: 'Phone directory', url: 'https://www.ramapo.edu/about/phone/' },
    ],
    artifacts: [
      {
        label: 'Directory page crawl',
        file: 'data/raw/directory.raw.json',
        provenanceDataset: 'directory',
        recordLabel: 'pages',
        role: 'primary',
      },
    ],
    caveat:
      'The runtime directory also adds a small checked-in list of curated office contacts when automated pages are incomplete.',
  },
  {
    id: 'transportation',
    title: 'Transportation service information',
    category: 'Transportation',
    sourceKey: 'transportation',
    mode: 'HTML crawl',
    summary: 'Commuter, transportation, and shuttle service pages and documents.',
    capturedData: [
      'Service descriptions',
      'Contacts',
      'Schedules and document links exposed on official pages',
    ],
    method:
      'The shared fetch/Cheerio crawler starts from commuter and transportation seed pages and follows only matching Ramapo transportation, shuttle, and commuter URLs, up to 120 detail pages.',
    automation: 'Checked daily against a seven-day SLA.',
    commands: ['npm run fetch:transportation:raw', 'npm run refresh:raw:core6'],
    sourceUrls: [
      {
        label: 'Transportation services',
        url: 'https://www.ramapo.edu/about/transportation/',
      },
      { label: 'Shuttle bus', url: 'https://www.ramapo.edu/about/shuttlebus/' },
      {
        label: 'Commuter affairs',
        url: 'https://www.ramapo.edu/csi/commuter-affairs/',
      },
    ],
    artifacts: [
      {
        label: 'Transportation page crawl',
        file: 'data/raw/transportation.raw.json',
        provenanceDataset: 'transportation',
        recordLabel: 'pages',
        role: 'primary',
      },
    ],
    caveat:
      'The exact Roadrunner Express and Shortline times used by the shuttle modal are currently checked-in static TypeScript data, not generated from this scrape.',
  },
  {
    id: 'housing',
    title: 'Residence Life and housing',
    category: 'Student support',
    sourceKey: 'housing',
    mode: 'HTML crawl',
    summary: 'Residence Life pages, policies, contacts, documents, and housing information.',
    capturedData: ['Page sections', 'Lists and tables', 'Contacts and linked documents'],
    method:
      'The shared collector fetches the Residence Life seed and follows ramapo.edu/reslife detail pages, extracting structured HTML with Cheerio and retaining source URLs for retrieval.',
    automation: 'Checked daily against a seven-day SLA.',
    commands: ['npm run fetch:housing:raw', 'npm run refresh:raw:core6'],
    sourceUrls: [{ label: 'Residence Life', url: 'https://www.ramapo.edu/reslife/' }],
    artifacts: [
      {
        label: 'Housing page crawl',
        file: 'data/raw/housing.raw.json',
        provenanceDataset: 'housing',
        recordLabel: 'pages',
        role: 'primary',
      },
    ],
  },
  {
    id: 'health',
    title: 'Health Services',
    category: 'Student support',
    sourceKey: 'health',
    mode: 'HTML crawl',
    summary: 'Health Services information, contacts, forms, and linked resources.',
    capturedData: ['Services and instructions', 'Contacts', 'Lists, tables, and documents'],
    method:
      'The shared fetch/Cheerio collector crawls the Health Services section and normalizes headings, body sections, lists, tables, contacts, and document URLs.',
    automation: 'Checked daily against a seven-day SLA.',
    commands: ['npm run fetch:health:raw', 'npm run refresh:raw:core6'],
    sourceUrls: [{ label: 'Health Services', url: 'https://www.ramapo.edu/health/' }],
    artifacts: [
      {
        label: 'Health Services crawl',
        file: 'data/raw/health.raw.json',
        provenanceDataset: 'health',
        recordLabel: 'pages',
        role: 'primary',
      },
    ],
  },
  {
    id: 'counseling',
    title: 'Counseling Services',
    category: 'Student support',
    sourceKey: 'counseling',
    mode: 'HTML crawl',
    summary: 'Counseling services, crisis guidance, programs, contacts, and forms.',
    capturedData: [
      'Service descriptions',
      'Contact information',
      'Lists, tables, and linked documents',
    ],
    method:
      'The shared fetch/Cheerio collector crawls matching counseling pages and extracts structured page content, contacts, links, and documents.',
    automation: 'Checked daily against a seven-day SLA.',
    commands: ['npm run fetch:counseling:raw', 'npm run refresh:raw:core6'],
    sourceUrls: [{ label: 'Counseling Services', url: 'https://www.ramapo.edu/counseling/' }],
    artifacts: [
      {
        label: 'Counseling Services crawl',
        file: 'data/raw/counseling.raw.json',
        provenanceDataset: 'counseling',
        recordLabel: 'pages',
        role: 'primary',
      },
    ],
  },
  {
    id: 'safety',
    title: 'Public Safety',
    category: 'Safety',
    sourceKey: 'public-safety',
    mode: 'HTML crawl',
    summary: 'Public Safety services, policies, parking information, contacts, and documents.',
    capturedData: [
      'Safety services and procedures',
      'Phone/email contacts',
      'Parking and policy documents',
    ],
    method:
      'The shared collector starts at Public Safety, follows matching safety, emergency, parking, ID-card, and related Ramapo pages, and extracts structured HTML and documents with Cheerio.',
    automation: 'Checked daily against a seven-day SLA.',
    commands: ['npm run fetch:safety:raw', 'npm run refresh:raw:core6'],
    sourceUrls: [
      { label: 'Public Safety', url: 'https://www.ramapo.edu/publicsafety/' },
      {
        label: 'Parking permits',
        url: 'https://www.ramapo.edu/publicsafety/parking-permits/',
      },
    ],
    artifacts: [
      {
        label: 'Public Safety crawl',
        file: 'data/raw/safety.raw.json',
        provenanceDataset: 'safety',
        recordLabel: 'pages',
        role: 'primary',
      },
    ],
    caveat:
      'Emergency and other critical contact values are also duplicated as human-verified static facts so safety answers can fail closed.',
  },
  {
    id: 'campus-map',
    title: 'Campus map, offices, rooms, and print locations',
    category: 'Campus navigation',
    mode: 'Hybrid',
    summary:
      'Buildings, offices, parking, map layers, and office-room enrichment used by map and printer UIs.',
    capturedData: [
      'Buildings and offices',
      'Parking and map layers',
      'Office room/location candidates',
    ],
    method:
      'A direct fetch loads the official mapData.json payload. The enrichment script then fetches unique office URLs, follows a limited set of scoped links, mines existing raw datasets for location text, applies heuristics and manual overrides, and writes a verified local map dataset.',
    automation: 'Manual/lifetime refresh only; it is not part of the daily publication workflow.',
    commands: ['npm run fetch:map:rooms', 'npm run refresh:lifetime'],
    sourceUrls: [
      { label: 'Campus map', url: 'https://www.ramapo.edu/map/' },
      { label: 'Map data JSON', url: 'https://www.ramapo.edu/map/data/mapData.json' },
    ],
    artifacts: [
      {
        label: 'Campus map dataset',
        file: 'data/map/campus-map-data.json',
        role: 'primary',
      },
      {
        label: 'Room verification report',
        file: 'data/map/office-room-verification.json',
        role: 'supplemental',
      },
    ],
  },
];

export const STATIC_DATA_NOT_SCRAPED = [
  {
    title: 'Critical facts',
    detail:
      'Emergency contacts, password reset URL, printing allowance, tuition, selected calendar dates, and shuttle endpoints are checked-in and human-verified.',
    file: 'core/pipeline/commands/check-quality.ts',
  },
  {
    title: 'Shuttle timetable',
    detail:
      'Roadrunner Express, train-loop, and Shortline times used by the app are maintained as static TypeScript data.',
    file: 'src/data/shuttleSchedule.ts',
  },
  {
    title: 'Curated directory contacts',
    detail:
      'A small list of campus contacts supplements scraped directory results when an office is not reliably available in the automated feed.',
    file: 'core/lib/directory/static-contacts.ts',
  },
] as const;

const SOURCE_FRESHNESS = new Map(SOURCES.map((source) => [source.key, source.freshnessHours]));
const TIMESTAMP_KEYS = [
  'fetchedAt',
  'collectedAt',
  'scrapedAt',
  'generatedAt',
  'updatedAt',
  'timestamp',
] as const;

function parseTimestamp(value: unknown): string | null {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toISOString();
}

function embeddedTimestamp(payload: unknown): { timestamp: string; key: string } | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const record = payload as Record<string, unknown>;
  for (const key of TIMESTAMP_KEYS) {
    const timestamp = parseTimestamp(record[key]);
    if (timestamp) return { timestamp, key };
  }
  return null;
}

function readJson(filePath: string): unknown | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
  } catch {
    return null;
  }
}

function readArtifactProvenance(
  definition: ScrapeArtifactDefinition,
  rootDir: string
): { fetchedAt: string } | null {
  if (!definition.provenanceDataset) return null;

  const provenancePath = path.join(
    /* turbopackIgnore: true */ rootDir,
    'data',
    'raw',
    `${definition.provenanceDataset}.provenance.json`
  );
  const rawFilePath = path.join(/* turbopackIgnore: true */ rootDir, definition.file);
  const provenancePayload = readJson(provenancePath);
  const rawPayload = readJson(rawFilePath);
  if (
    !provenancePayload ||
    typeof provenancePayload !== 'object' ||
    Array.isArray(provenancePayload) ||
    rawPayload === null
  ) {
    return null;
  }

  const provenance = provenancePayload as Record<string, unknown>;
  const fetchedAt = parseTimestamp(provenance.fetchedAt);
  if (
    provenance.version !== 1 ||
    provenance.dataset !== definition.provenanceDataset ||
    !fetchedAt ||
    typeof provenance.contentHash !== 'string'
  ) {
    return null;
  }

  const actualHash = createHash('sha256').update(JSON.stringify(rawPayload)).digest('hex');
  if (actualHash !== provenance.contentHash) return null;
  return { fetchedAt };
}

function pluralize(count: number, label: string): string {
  if (count === 1 && label.endsWith('s')) return `${count} ${label.slice(0, -1)}`;
  return `${count} ${label}`;
}

function summarizePayload(payload: unknown, recordLabel?: string): string | undefined {
  if (Array.isArray(payload)) {
    return pluralize(payload.length, recordLabel || 'records');
  }
  if (!payload || typeof payload !== 'object') return undefined;

  const record = payload as Record<string, unknown>;
  const stats =
    record.stats && typeof record.stats === 'object'
      ? (record.stats as Record<string, unknown>)
      : null;
  if (Array.isArray(record.pages)) {
    const total = record.pages.length;
    const fetched = typeof stats?.pagesFetched === 'number' ? stats.pagesFetched : null;
    const failed = typeof stats?.pagesFailed === 'number' ? stats.pagesFailed : null;
    if (fetched !== null && failed !== null) {
      return `${pluralize(total, recordLabel || 'pages')} · ${fetched} fetched · ${failed} failed`;
    }
    return pluralize(total, recordLabel || 'pages');
  }
  if (typeof record.count === 'number') {
    return pluralize(record.count, recordLabel || 'records');
  }
  if (Array.isArray(record.programs)) {
    return pluralize(record.programs.length, recordLabel || 'programs');
  }
  if (Array.isArray(record.entries)) {
    return pluralize(record.entries.length, recordLabel || 'entries');
  }
  if (Array.isArray(record.items)) {
    return pluralize(record.items.length, recordLabel || 'items');
  }
  if (Array.isArray(record.dates)) {
    return pluralize(record.dates.length, recordLabel || 'days');
  }
  if (typeof record.signalCount === 'number') {
    return pluralize(record.signalCount, recordLabel || 'signals');
  }

  const directoryGroups =
    record.directoryGroups && typeof record.directoryGroups === 'object'
      ? (record.directoryGroups as Record<string, unknown>)
      : null;
  if (typeof directoryGroups?.groupsFetched === 'number') {
    return pluralize(directoryGroups.groupsFetched, recordLabel || 'groups');
  }

  const counts =
    record.counts && typeof record.counts === 'object'
      ? (record.counts as Record<string, unknown>)
      : null;
  if (counts) {
    const values = Object.entries(counts)
      .filter((entry): entry is [string, number] => typeof entry[1] === 'number')
      .slice(0, 4)
      .map(([label, count]) => `${count} ${label}`);
    if (values.length) return values.join(' · ');
  }

  return undefined;
}

function artifactStatus(
  definition: ScrapeArtifactDefinition,
  rootDir: string
): ScrapeArtifactStatus {
  const filePath = path.join(/* turbopackIgnore: true */ rootDir, definition.file);
  const exists = fs.existsSync(filePath);
  const payload = exists ? readJson(filePath) : null;
  const summary = payload === null ? undefined : summarizePayload(payload, definition.recordLabel);

  const provenance = readArtifactProvenance(definition, rootDir);
  if (provenance) {
    return {
      ...definition,
      exists,
      fetchedAt: provenance.fetchedAt,
      timestampBasis: 'collector-provenance',
      timestampDetail: 'collector provenance',
      summary,
    };
  }

  const timestampPath = path.join(
    /* turbopackIgnore: true */ rootDir,
    definition.timestampFile || definition.file
  );
  const timestampPayload = fs.existsSync(timestampPath) ? readJson(timestampPath) : null;
  const embedded = embeddedTimestamp(timestampPayload);
  if (embedded) {
    return {
      ...definition,
      exists,
      fetchedAt: embedded.timestamp,
      timestampBasis: 'embedded-timestamp',
      timestampDetail: `embedded ${embedded.key}`,
      summary,
    };
  }

  if (exists) {
    const modifiedAt = fs.statSync(filePath).mtime.toISOString();
    return {
      ...definition,
      exists,
      fetchedAt: modifiedAt,
      timestampBasis: 'file-modified-estimate',
      timestampDetail: 'file modified time (estimate)',
      summary,
    };
  }

  return {
    ...definition,
    exists: false,
    fetchedAt: null,
    timestampBasis: 'missing',
    timestampDetail: 'artifact missing',
    summary,
  };
}

const BASIS_RANK: Record<TimestampBasis, number> = {
  'collector-provenance': 0,
  'embedded-timestamp': 1,
  'file-modified-estimate': 2,
  missing: 3,
};

function leastReliableBasis(artifacts: ScrapeArtifactStatus[]): TimestampBasis {
  return artifacts.reduce<TimestampBasis>(
    (current, artifact) =>
      BASIS_RANK[artifact.timestampBasis] > BASIS_RANK[current] ? artifact.timestampBasis : current,
    'collector-provenance'
  );
}

export function getScrapeSourceStatuses(
  rootDir = DATA_ROOT,
  now = new Date()
): ScrapeSourceStatus[] {
  return SCRAPE_SOURCES.map((definition) => {
    const artifacts = definition.artifacts.map((artifact) => artifactStatus(artifact, rootDir));
    const primaryArtifacts = artifacts.filter((artifact) => artifact.role === 'primary');
    const primaryTimestamps = primaryArtifacts
      .map((artifact) => artifact.fetchedAt)
      .filter((timestamp): timestamp is string => Boolean(timestamp))
      .sort((a, b) => Date.parse(a) - Date.parse(b));
    const lastFetchedAt = primaryTimestamps[0] || null;
    const freshnessHours = definition.sourceKey
      ? (SOURCE_FRESHNESS.get(definition.sourceKey) ?? null)
      : null;
    const ageHours = lastFetchedAt
      ? Math.max(0, (now.getTime() - Date.parse(lastFetchedAt)) / 3_600_000)
      : null;

    const primaryArtifactMissing = primaryArtifacts.some((artifact) => !artifact.exists);
    let freshnessStatus: FreshnessStatus;
    if (ageHours === null || primaryArtifactMissing) {
      freshnessStatus = 'unknown';
    } else if (freshnessHours === null) {
      freshnessStatus = 'manual';
    } else {
      freshnessStatus = ageHours > freshnessHours ? 'stale' : 'fresh';
    }

    return {
      ...definition,
      artifacts,
      freshnessHours,
      freshnessStatus,
      ageHours,
      lastFetchedAt,
      timestampBasis: leastReliableBasis(primaryArtifacts),
    };
  });
}
