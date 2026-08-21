import fs from 'fs';
import path from 'path';
import pLimit from 'p-limit';

interface MapBuilding {
  key: string;
  name: string;
  roomPrefixes: string[];
}

interface MapOffice {
  key: string;
  name: string;
  buildingKey: string;
  buildingName: string;
  category: string;
  mapUrl: string;
  officeUrl: string | null;
  aliases: string[];
  room?: string | null;
}

interface MapDataFile {
  generatedAt?: string;
  source?: string;
  counts?: Record<string, number>;
  buildings: MapBuilding[];
  offices: MapOffice[];
  parking: unknown[];
  layers: unknown[];
}

interface SourceMapOffice {
  name?: string | string[];
  URL?: string;
  Location?: string;
}

interface SourceMapBuilding {
  name?: string;
  offices?: SourceMapOffice[];
}

interface SourceMapPayload {
  mapData?: {
    buildings?: SourceMapBuilding[];
  };
}

interface LocationCandidate {
  value: string;
  score: number;
  reason: string;
}

interface PageExtractResult {
  html: string;
  status: 'ok' | 'error';
}

interface RawDataFile {
  pages?: Array<Record<string, unknown>>;
}

interface RawTextEntry {
  sourceFile: string;
  url: string;
  scopeKey: string;
  text: string;
}

const MAP_DATA_FILE = path.join(process.cwd(), 'data', 'map', 'campus-map-data.json');
const RAW_DATA_DIR = path.join(process.cwd(), 'data', 'raw');
const SOURCE_MAP_DATA_URL = 'https://www.ramapo.edu/map/data/mapData.json';
const REQUEST_TIMEOUT_MS = 15000;
const CONCURRENCY = 8;
const MAX_SUBPAGES_PER_URL = 12;
const MAX_RAW_ENTRIES_PER_SCOPE = 1200;
const USER_AGENT = 'RockyGPT-MapRoomEnricher/1.0 (+https://www.ramapo.edu/map/)';
const ALLOW_EXISTING_ROOMS = process.env.RESET_EXISTING_ROOMS !== '1';
const OFFICE_TOKEN_STOP_WORDS = new Set([
  'academic',
  'area',
  'building',
  'campus',
  'center',
  'department',
  'hall',
  'lounge',
  'office',
  'program',
  'room',
  'school',
  'services',
  'student',
]);

const MANUAL_ROOM_OVERRIDES = new Map<string, string>([
  ['office_student-government-student-center-sc', 'SC-225'],
  ['office_registrar-academic-building-d', 'D-224'],
  ['office_financial-aid-academic-building-e', 'E-210'],
  ['office_h-wing-auditorium-academic-building-h', 'H-Wing Auditorium'],
  ['office_conference-center-trustees-pavilion', 'Conference Center'],
  ['office_library-computer-lab-peter-p-mercer-learning-commons', 'Library Computer Lab'],
  ['office_aft-office-anisfield-school-of-business-asb', 'AFT Office'],
  ['office_school-of-theoretical-and-applied-science-tas-academic-building-g', 'School of Theoretical and Applied Science (TAS)'],
  ['office_instructional-design-center-peter-p-mercer-learning-commons', 'Instructional Design Center'],
  ['office_center-for-reading-and-writing-peter-p-mercer-learning-commons', 'Center for Reading and Writing'],
  ['office_international-and-intercultural-education-academic-building-c', 'C-Wing, Suite 213'],
  ['office_study-abroad-academic-building-c', 'C-Wing, Suite 213'],
  ['office_roukema-center-for-international-education-academic-building-c', 'C-Wing, Suite 213'],
  ['office_bookstore-student-center-sc', 'Second Floor, Student Center'],
  ['office_bischoff-student-lounges-pamela-m-bischoff-hall', 'Floor Lounges'],
  ['office_laurel-hall-screening-room-laurel-hall-south-building', 'First Floor Screening Room'],
  ['office_laurel-hall-student-lounges-laurel-hall-south-building', 'First and Second Floor Lounges'],
  ['office_mackin-student-lounges-nancy-mackin-hall', 'Common Lounge (Each Floor)'],
  ['office_the-overlook-student-lounges-the-overlook', 'Common Lounge (Each Floor)'],
  ['office_academic-affairs-birch-mansion', 'First Floor, Birch Mansion'],
  ['office_alumni-relations-birch-mansion', 'Birch Mansion'],
  ['office_friends-of-ramapo-office-birch-mansion', 'Birch Mansion'],
  ['office_institutional-advancement-birch-mansion', 'Birch Mansion'],
  ['office_provost-s-office-birch-mansion', 'First Floor, Birch Mansion'],
  ['office_ramapo-college-foundation-birch-mansion', 'Birch Mansion'],
]);

function readJsonFile<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
}

function writeJsonFile(filePath: string, data: unknown): void {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

function decodeEntities(input: string): string {
  return input
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;|&#8217;|&rsquo;/gi, "'")
    .replace(/&#8211;|&#8212;|&ndash;|&mdash;/gi, '-')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_, dec: string) => String.fromCodePoint(parseInt(dec, 10)));
}

function normalizeSpace(input: string): string {
  return decodeEntities(input).replace(/\s+/g, ' ').trim();
}

function normalizeName(input: string): string {
  return normalizeSpace(input)
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function normalizeUrl(input: string): string {
  const value = normalizeSpace(input);
  if (!value) return '';

  try {
    const url = new URL(value);
    url.hash = '';
    url.search = '';
    const normalized = url.toString();
    return normalized.endsWith('/') ? normalized.slice(0, -1).toLowerCase() : normalized.toLowerCase();
  } catch {
    return value.toLowerCase().replace(/\/+$/, '');
  }
}

function getFirstPathSegment(pathname: string): string {
  const segment = pathname
    .split('/')
    .map((part) => part.trim())
    .filter(Boolean)[0];
  return (segment ?? '').toLowerCase();
}

function getUrlScopeKey(input: string): string {
  try {
    const url = new URL(input);
    return `${url.host.toLowerCase()}|${getFirstPathSegment(url.pathname)}`;
  } catch {
    return '';
  }
}

function isLikelyHtmlPath(pathname: string): boolean {
  return !/\.(?:pdf|docx?|xlsx?|pptx?|zip|png|jpe?g|gif|svg|webp|mp4|mov|mp3)$/i.test(pathname);
}

function isScopedSubpage(baseUrl: string, candidateUrl: string): boolean {
  try {
    const base = new URL(baseUrl);
    const candidate = new URL(candidateUrl);
    if (base.host.toLowerCase() !== candidate.host.toLowerCase()) return false;

    if (!isLikelyHtmlPath(candidate.pathname)) return false;
    if (/\/(?:wp-admin|wp-content|wp-login|xmlrpc)\//i.test(candidate.pathname)) return false;
    if (/\/(?:feed|tag|author|category)\//i.test(candidate.pathname)) return false;

    const baseScope = getFirstPathSegment(base.pathname);
    const candidateScope = getFirstPathSegment(candidate.pathname);
    if (baseScope && candidateScope && baseScope !== candidateScope) return false;

    return true;
  } catch {
    return false;
  }
}

function extractScopedLinksFromHtml(html: string, baseUrl: string, maxLinks: number): string[] {
  const links = new Set<string>();
  const hrefRegex = /href\s*=\s*["']([^"']+)["']/gi;
  let match = hrefRegex.exec(html);

  while (match) {
    const rawHref = match[1];
    if (rawHref && !rawHref.startsWith('mailto:') && !rawHref.startsWith('tel:') && !rawHref.startsWith('javascript:')) {
      try {
        const candidate = new URL(rawHref, baseUrl);
        candidate.hash = '';
        candidate.search = '';
        const normalizedCandidate = normalizeUrl(candidate.toString());
        if (normalizedCandidate && normalizedCandidate !== normalizeUrl(baseUrl) && isScopedSubpage(baseUrl, normalizedCandidate)) {
          links.add(normalizedCandidate);
          if (links.size >= maxLinks) break;
        }
      } catch {
        // ignore malformed URLs
      }
    }

    match = hrefRegex.exec(html);
  }

  return Array.from(links);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function sanitizeLocationValue(rawValue: string, roomPrefixSet: Set<string>): string | null {
  let value = normalizeSpace(rawValue);
  if (!value) return null;

  value = value
    .replace(/^[,;:\-\s]+/, '')
    .replace(/[|•]+/g, ' ')
    .replace(/\\[nr]/gi, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\b(?:phone|email|e-mail|fax)\b.*$/i, '')
    .trim();

  if (!value) return null;

  for (const prefix of roomPrefixSet) {
    const prefixRegex = new RegExp(`\\b(${escapeRegex(prefix)})\\s*[- ]?\\s*(\\d{2,4}[a-z]?)\\b`, 'gi');
    value = value.replace(prefixRegex, (_, p: string, room: string) => `${p.toUpperCase()}-${room.toUpperCase()}`);
  }

  value = value
    .replace(/\s+/g, ' ')
    .replace(/\s*-\s*/g, '-')
    .replace(/[.;,\s]+$/, '')
    .trim();

  if (!value) return null;
  if (value.length > 100) return null;
  if (/^https?:\/\//i.test(value)) return null;
  if (/@/.test(value)) return null;
  if (/^\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}$/.test(value)) return null;

  return value;
}

function htmlToLines(html: string): string[] {
  const withoutScripts = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ');

  const withBreaks = withoutScripts
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr|td|section|article|ul|ol)>/gi, '\n');

  const text = withBreaks.replace(/<[^>]+>/g, ' ');
  return decodeEntities(text)
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

function textToLines(text: string): string[] {
  const hasLineBreaks = /\r|\n/.test(text);
  const withBreaks = hasLineBreaks
    ? decodeEntities(text)
    : decodeEntities(text).replace(/([.;!?])\s+/g, '$1\n');

  return withBreaks
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

function getOfficeTokens(office: MapOffice): string[] {
  const tokenSet = new Set<string>();
  for (const value of [office.name, ...office.aliases]) {
    const normalized = normalizeName(value);
    for (const token of normalized.split(' ')) {
      if (token.length < 4) continue;
      if (OFFICE_TOKEN_STOP_WORDS.has(token)) continue;
      tokenSet.add(token);
    }
  }
  return Array.from(tokenSet);
}

function getOfficePhrases(office: MapOffice): string[] {
  const phrases = new Set<string>();
  for (const value of [office.name, ...office.aliases]) {
    const normalized = normalizeName(value);
    if (normalized.length >= 5) phrases.add(normalized);
  }
  return Array.from(phrases);
}

function textLikelyMentionsOffice(text: string, officeTokens: string[], officePhrases: string[]): boolean {
  const normalizedText = normalizeName(text);
  if (!normalizedText) return false;

  for (const phrase of officePhrases) {
    if (phrase && normalizedText.includes(phrase)) return true;
  }

  if (officeTokens.length === 0) return false;
  let tokenHits = 0;
  for (const token of officeTokens) {
    if (normalizedText.includes(token)) tokenHits += 1;
  }

  return tokenHits >= Math.min(2, officeTokens.length);
}

function deriveFallbackRoomName(office: MapOffice): string {
  const officeName = normalizeSpace(office.name);
  if (officeName) return officeName;

  const buildingName = normalizeSpace(office.buildingName);
  if (buildingName) return `Main Office (${buildingName})`;

  return 'Main Office';
}

function scoreCandidate(
  candidateValue: string,
  label: 'location' | 'office',
  context: string,
  office: MapOffice,
  buildingPrefixes: string[]
): number {
  let score = 0;
  const value = candidateValue.toUpperCase();
  const contextLower = context.toLowerCase();

  if (label === 'location') score += 45;
  if (label === 'office') score += 30;

  if (contextLower.includes('main office')) score += 90;
  if (contextLower.includes('contact information')) score += 20;

  const roomCodeMatch = value.match(/\b([A-Z]{1,4})-(\d{2,4}[A-Z]?)\b/);
  if (roomCodeMatch) {
    score += 65;
    const prefix = roomCodeMatch[1];
    if (buildingPrefixes.length > 0) {
      if (buildingPrefixes.includes(prefix)) {
        score += 60;
      } else {
        score -= 20;
      }
    }
  } else if (/(floor|annex|hall|building|center|pavilion)/i.test(candidateValue)) {
    score += 15;
  }

  if (office.buildingName && candidateValue.toLowerCase().includes(office.buildingName.toLowerCase())) {
    score += 12;
  }

  if (candidateValue.length > 70) score -= 10;
  if (/(mailto|http|@)/i.test(candidateValue)) score -= 80;

  return score;
}

async function fetchText(url: string): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': USER_AGENT,
      },
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    return await response.text();
  } finally {
    clearTimeout(timeout);
  }
}

function extractCandidatesFromLines(
  lines: string[],
  office: MapOffice,
  roomPrefixSet: Set<string>,
  buildingPrefixes: string[],
  sourceTag: string
): LocationCandidate[] {
  const candidates: LocationCandidate[] = [];
  const officeTokens = getOfficeTokens(office);

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const match = line.match(/\b(Location|Office)\s*:\s*(.+)$/i);
    if (!match) continue;

    const label = match[1].toLowerCase() as 'location' | 'office';
    const value = sanitizeLocationValue(match[2], roomPrefixSet);
    if (!value) continue;

    const context = `${lines[i - 1] ?? ''} ${line} ${lines[i + 1] ?? ''}`.trim();
    const score = scoreCandidate(value, label, context, office, buildingPrefixes);
    if (score < 30) continue;

    candidates.push({
      value,
      score,
      reason: `${sourceTag}:${label}`,
    });
  }

  if (buildingPrefixes.length > 0) {
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      const normalizedLine = normalizeSpace(line);
      const lineLower = normalizedLine.toLowerCase();
      if (!normalizedLine) continue;

      for (const prefix of buildingPrefixes) {
        const codeRegex = new RegExp(`\\b${escapeRegex(prefix)}\\s*[- ]?\\s*(\\d{2,4}[A-Z]?)\\b`, 'gi');
        let codeMatch = codeRegex.exec(normalizedLine);
        while (codeMatch) {
          const value = sanitizeLocationValue(`${prefix}-${codeMatch[1]}`, roomPrefixSet);
          if (value) {
            let score = 35;
            if (officeTokens.some((token) => lineLower.includes(token))) score += 35;
            if (/main office|contact information|location|office/i.test(lineLower)) score += 20;

            candidates.push({
              value,
              score,
              reason: `${sourceTag}:room-code`,
            });
          }
          codeMatch = codeRegex.exec(normalizedLine);
        }
      }
    }
  }

  const deduped = new Map<string, LocationCandidate>();
  for (const candidate of candidates) {
    const key = normalizeSpace(candidate.value).toLowerCase();
    const existing = deduped.get(key);
    if (!existing || candidate.score > existing.score) {
      deduped.set(key, candidate);
    }
  }

  return Array.from(deduped.values()).sort((a, b) => b.score - a.score || a.value.length - b.value.length);
}

function extractCandidatesFromPage(
  html: string,
  office: MapOffice,
  roomPrefixSet: Set<string>,
  buildingPrefixes: string[],
  sourceTag = 'officeUrl'
): LocationCandidate[] {
  return extractCandidatesFromLines(htmlToLines(html), office, roomPrefixSet, buildingPrefixes, sourceTag);
}

function extractCandidatesFromText(
  text: string,
  office: MapOffice,
  roomPrefixSet: Set<string>,
  buildingPrefixes: string[],
  sourceTag: string
): LocationCandidate[] {
  return extractCandidatesFromLines(textToLines(text), office, roomPrefixSet, buildingPrefixes, sourceTag);
}

function buildSourceLocationLookup(sourcePayload: SourceMapPayload): Map<string, string> {
  const lookup = new Map<string, string>();
  const buildings = sourcePayload.mapData?.buildings ?? [];

  for (const building of buildings) {
    const buildingName = normalizeSpace(building.name ?? '');
    if (!buildingName) continue;

    for (const office of building.offices ?? []) {
      const location = sanitizeLocationValue(office.Location ?? '', new Set());
      if (!location) continue;

      const officeNamesRaw = Array.isArray(office.name) ? office.name : [office.name ?? ''];
      for (const officeNameRaw of officeNamesRaw) {
        const officeName = normalizeSpace(officeNameRaw);
        if (!officeName) continue;
        lookup.set(`${normalizeName(buildingName)}|${normalizeName(officeName)}`, location);
      }
    }
  }

  return lookup;
}

function collectStrings(value: unknown, out: string[], depth = 0): void {
  if (depth > 5 || value == null) return;

  if (typeof value === 'string') {
    out.push(value);
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectStrings(item, out, depth + 1);
    }
    return;
  }

  if (typeof value === 'object') {
    for (const nested of Object.values(value)) {
      collectStrings(nested, out, depth + 1);
    }
  }
}

function pushRawTextEntry(entries: RawTextEntry[], sourceFile: string, url: string, rawText: string): void {
  const normalizedUrl = normalizeUrl(url);
  if (!normalizedUrl) return;

  let text = normalizeSpace(rawText);
  if (!text || text.length < 8) return;
  if (text.length > 2200) {
    text = `${text.slice(0, 1800)} ${text.slice(-320)}`.trim();
  }

  entries.push({
    sourceFile,
    url: normalizedUrl,
    scopeKey: getUrlScopeKey(normalizedUrl),
    text,
  });
}

function collectRawTextEntries(rawDataDir: string): RawTextEntry[] {
  if (!fs.existsSync(rawDataDir)) return [];

  const entries: RawTextEntry[] = [];
  const rawFiles = fs
    .readdirSync(rawDataDir)
    .filter((fileName) => fileName.endsWith('.raw.json'))
    .sort();

  for (const rawFileName of rawFiles) {
    const filePath = path.join(rawDataDir, rawFileName);
    let parsed: RawDataFile | null = null;
    try {
      parsed = readJsonFile<RawDataFile>(filePath);
    } catch {
      parsed = null;
    }
    if (!parsed) continue;

    for (const page of parsed.pages ?? []) {
      const pageUrlValue = page.url;
      const pageUrl = typeof pageUrlValue === 'string' ? pageUrlValue : '';
      if (!pageUrl) continue;

      if (typeof page.title === 'string') {
        pushRawTextEntry(entries, rawFileName, pageUrl, page.title);
      }

      const sections = Array.isArray(page.sections) ? page.sections : [];
      for (const section of sections) {
        if (typeof section === 'object' && section != null) {
          const heading = (section as Record<string, unknown>).heading;
          const text = (section as Record<string, unknown>).text;
          if (typeof heading === 'string') pushRawTextEntry(entries, rawFileName, pageUrl, heading);
          if (typeof text === 'string') pushRawTextEntry(entries, rawFileName, pageUrl, text);
        }
      }

      const extractedStrings: string[] = [];
      collectStrings(page.contacts, extractedStrings);
      collectStrings(page.tables, extractedStrings);
      collectStrings(page.lists, extractedStrings);
      collectStrings(page.documents, extractedStrings);

      for (const text of extractedStrings) {
        pushRawTextEntry(entries, rawFileName, pageUrl, text);
      }
    }
  }

  return entries;
}

function groupRawEntriesByScope(entries: RawTextEntry[]): Map<string, RawTextEntry[]> {
  const grouped = new Map<string, RawTextEntry[]>();
  for (const entry of entries) {
    if (!entry.scopeKey) continue;
    const bucket = grouped.get(entry.scopeKey) ?? [];
    bucket.push(entry);
    grouped.set(entry.scopeKey, bucket);
  }
  return grouped;
}

async function enrichMapOfficeRooms(): Promise<void> {
  const dataset = readJsonFile<MapDataFile>(MAP_DATA_FILE);
  const roomPrefixSet = new Set(
    dataset.buildings.flatMap((building) => building.roomPrefixes).map((prefix) => prefix.toUpperCase())
  );
  const buildingPrefixesByName = new Map(
    dataset.buildings.map((building) => [building.name, building.roomPrefixes.map((prefix) => prefix.toUpperCase())])
  );

  console.log(`Loaded ${dataset.offices.length} offices from ${MAP_DATA_FILE}`);
  console.log('Fetching official map source for direct Location fields...');

  const sourcePayload = await fetchText(SOURCE_MAP_DATA_URL).then((text) => JSON.parse(text) as SourceMapPayload);
  const sourceLookup = buildSourceLocationLookup(sourcePayload);
  console.log(`Source map provided explicit locations for ${sourceLookup.size} office entries`);

  console.log('Loading local raw datasets for fallback extraction...');
  const rawEntries = collectRawTextEntries(RAW_DATA_DIR);
  const rawEntriesByScope = groupRawEntriesByScope(rawEntries);
  console.log(`Loaded ${rawEntries.length} raw text entries across ${rawEntriesByScope.size} URL scopes`);

  const uniqueUrls = Array.from(
    new Set(dataset.offices.map((office) => normalizeUrl(office.officeUrl ?? '')).filter(Boolean))
  );
  console.log(`Fetching ${uniqueUrls.length} unique office URLs for location extraction...`);

  const pageCache = new Map<string, PageExtractResult>();
  const limit = pLimit(CONCURRENCY);

  await Promise.all(
    uniqueUrls.map((normalizedUrl) =>
      limit(async () => {
        try {
          const html = await fetchText(normalizedUrl);
          pageCache.set(normalizedUrl, { status: 'ok', html });
        } catch {
          pageCache.set(normalizedUrl, { status: 'error', html: '' });
        }
      })
    )
  );

  const subpagesByRootUrl = new Map<string, string[]>();
  const subpageUrls = new Set<string>();
  for (const normalizedUrl of uniqueUrls) {
    const pageResult = pageCache.get(normalizedUrl);
    if (pageResult?.status !== 'ok') {
      subpagesByRootUrl.set(normalizedUrl, []);
      continue;
    }

    const scopedLinks = extractScopedLinksFromHtml(pageResult.html, normalizedUrl, MAX_SUBPAGES_PER_URL);
    subpagesByRootUrl.set(normalizedUrl, scopedLinks);
    for (const link of scopedLinks) {
      if (link !== normalizedUrl) subpageUrls.add(link);
    }
  }

  console.log(`Fetching ${subpageUrls.size} scoped subpages for deeper location extraction...`);
  const subpageCache = new Map<string, PageExtractResult>();
  await Promise.all(
    Array.from(subpageUrls).map((subpageUrl) =>
      limit(async () => {
        try {
          const html = await fetchText(subpageUrl);
          subpageCache.set(subpageUrl, { status: 'ok', html });
        } catch {
          subpageCache.set(subpageUrl, { status: 'error', html: '' });
        }
      })
    )
  );

  let resolvedCount = 0;
  let resolvedFromSourceCount = 0;
  let resolvedFromUrlCount = 0;
  let resolvedFromSubpageCount = 0;
  let resolvedFromRawCount = 0;
  let resolvedFromManualCount = 0;
  let resolvedFromFallbackCount = 0;

  const unresolved: string[] = [];
  const updatedOffices = dataset.offices.map((office) => {
    const buildingPrefixes = buildingPrefixesByName.get(office.buildingName) ?? [];
    const officeTokens = getOfficeTokens(office);
    const officePhrases = getOfficePhrases(office);
    const bestCandidates: LocationCandidate[] = [];

    const existingRoom = sanitizeLocationValue(office.room ?? '', roomPrefixSet);
    if (ALLOW_EXISTING_ROOMS && existingRoom) {
      bestCandidates.push({
        value: existingRoom,
        score: 200,
        reason: 'existing',
      });
    }

    const sourceKey = `${normalizeName(office.buildingName)}|${normalizeName(office.name)}`;
    const sourceLocation = sourceLookup.get(sourceKey);
    if (sourceLocation) {
      bestCandidates.push({
        value: sourceLocation,
        score: 140,
        reason: 'mapData:Location',
      });
    }

    const manualRoom = sanitizeLocationValue(MANUAL_ROOM_OVERRIDES.get(office.key) ?? '', roomPrefixSet);
    if (manualRoom) {
      bestCandidates.push({
        value: manualRoom,
        score: 260,
        reason: 'manualOverride',
      });
    }

    const normalizedOfficeUrl = normalizeUrl(office.officeUrl ?? '');
    if (normalizedOfficeUrl) {
      const pageResult = pageCache.get(normalizedOfficeUrl);
      if (pageResult?.status === 'ok') {
        bestCandidates.push(
          ...extractCandidatesFromPage(pageResult.html, office, roomPrefixSet, buildingPrefixes, 'officeUrl')
        );
      }

      const subpages = subpagesByRootUrl.get(normalizedOfficeUrl) ?? [];
      for (const subpageUrl of subpages) {
        const subpageResult = subpageCache.get(subpageUrl);
        if (subpageResult?.status !== 'ok') continue;

        const plainText = htmlToLines(subpageResult.html).join(' ');
        if (!textLikelyMentionsOffice(plainText, officeTokens, officePhrases)) continue;

        bestCandidates.push(
          ...extractCandidatesFromPage(
            subpageResult.html,
            office,
            roomPrefixSet,
            buildingPrefixes,
            'officeSubpage'
          )
        );
      }

      const scopeKey = getUrlScopeKey(normalizedOfficeUrl);
      const scopedRawEntries = (rawEntriesByScope.get(scopeKey) ?? []).slice(0, MAX_RAW_ENTRIES_PER_SCOPE);
      for (const rawEntry of scopedRawEntries) {
        if (!textLikelyMentionsOffice(rawEntry.text, officeTokens, officePhrases)) continue;
        bestCandidates.push(
          ...extractCandidatesFromText(
            rawEntry.text,
            office,
            roomPrefixSet,
            buildingPrefixes,
            `raw:${rawEntry.sourceFile}`
          )
        );
      }
    }

    bestCandidates.sort((a, b) => b.score - a.score || a.value.length - b.value.length);
    const winner = bestCandidates[0];

    let room = winner?.value ? winner.value : null;
    if (!room) {
      room = sanitizeLocationValue(deriveFallbackRoomName(office), roomPrefixSet);
    }

    if (room) {
      resolvedCount += 1;
      if (winner?.reason === 'mapData:Location') resolvedFromSourceCount += 1;
      if (winner?.reason === 'manualOverride') resolvedFromManualCount += 1;
      if (winner?.reason.startsWith('officeUrl:')) resolvedFromUrlCount += 1;
      if (winner?.reason.startsWith('officeSubpage:')) resolvedFromSubpageCount += 1;
      if (winner?.reason.startsWith('raw:')) resolvedFromRawCount += 1;
      if (!winner) resolvedFromFallbackCount += 1;
    } else {
      unresolved.push(office.name);
    }

    return {
      ...office,
      room,
    };
  });

  const updated = {
    ...dataset,
    offices: updatedOffices,
  };

  writeJsonFile(MAP_DATA_FILE, updated);

  console.log(`Updated ${MAP_DATA_FILE}`);
  console.log(`Resolved rooms for ${resolvedCount}/${dataset.offices.length} offices`);
  console.log(`Resolved from mapData Location: ${resolvedFromSourceCount}`);
  console.log(`Resolved from office pages: ${resolvedFromUrlCount}`);
  console.log(`Resolved from office subpages: ${resolvedFromSubpageCount}`);
  console.log(`Resolved from local raw datasets: ${resolvedFromRawCount}`);
  console.log(`Resolved from manual overrides: ${resolvedFromManualCount}`);
  console.log(`Resolved from fallback room names: ${resolvedFromFallbackCount}`);
  console.log(`Unresolved offices: ${unresolved.length}`);
  if (unresolved.length > 0) {
    console.log(`Sample unresolved: ${unresolved.slice(0, 10).join(', ')}`);
  }
}

enrichMapOfficeRooms().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error('enrich-map-office-rooms failed:', message);
  process.exit(1);
});
