/**
 * scrape-catalog-api.ts
 *
 * Calls the Coursedog API (used by catalog.ramapo.edu) directly to get all program details.
 * No browser needed - just REST calls with the right headers.
 *
 * API base: https://app.coursedog.com/api/v1/cm/ramapo_banner_ethos/
 *
 * Run: npx tsx scripts/fetch/scrape-catalog-api.ts
 */

import fs from 'fs';
import path from 'path';
import { load } from 'cheerio';
import { fetchWithPolicy } from './http-client';
import {
  assertCollectionCount,
  isRawOnlyMode,
  writeJsonFile,
  writeRawFileProvenance,
} from './pipeline-utils';
import { validateProgramsData } from './programs-data';
import { publicPath } from '../src/paths';

const PROGRAMS_JSON = publicPath('data', 'programs.json');
const NORMALIZED_PROGRAMS_JSON = path.join(
  process.cwd(),
  'data',
  'normalized',
  'programs.json'
);
const COURSES_JSON = publicPath('data', 'courses.json');
const FACULTY_JSON = path.join(process.cwd(), 'data', 'normalized', 'faculty.json');
const FACULTY_RAW_JSON = path.join(process.cwd(), 'data', 'raw', 'faculty.raw.json');
const RAW_OUT = path.join(process.cwd(), 'data', 'raw', 'catalog-programs-api.raw.json');

const API_BASE = 'https://app.coursedog.com/api/v1/cm/ramapo_banner_ethos';
const HEADERS = {
  'x-requested-with': 'catalog',
  'referer': 'https://catalog.ramapo.edu/',
  'origin': 'https://catalog.ramapo.edu',
  'accept': 'application/json',
  'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
};

// ─── Types ────────────────────────────────────────────────────────────────

interface CoursedogCourseRef {
  code?: string;
  name?: string;
  credits?: string | number;
  courseId?: string;
}

interface CoursedogRule {
  condition?: string;
  name?: string;
  notes?: string;
  description?: string;
  restriction?: number | string;
  subRules?: CoursedogRule[];
  type?: string;
  value?: string | {
    condition?: string;
    values?: Array<{ value?: string[]; logic?: string; name?: string; credits?: string }>;
    subSelections?: Array<{ value?: string[]; logic?: string }>;
    courses?: CoursedogCourseRef[];
    courseIds?: string[];
  };
  label?: string;
  credits?: number | string;
  count?: number;
  [key: string]: unknown;
}

interface CoursedogRequirementBlock {
  showInCatalog?: boolean;
  id?: string;
  name?: string;
  label?: string;
  description?: string;
  type?: string;
  rules?: CoursedogRule[];
  creditHours?: number | string;
  selectCount?: number;
}

interface CoursedogProgram {
  id: string;
  name?: string;
  code?: string;
  longName?: string;
  catalogFullDescription?: string;
  catalogDescription?: string;
  descriptionHtml?: string;
  college?: string;
  degreeDesignation?: string;
  status?: string;
  totalCredits?: number | string;
  requisites?: {
    requisitesSimple?: CoursedogRequirementBlock[];
    [k: string]: unknown;
  };
  degreeMaps?: Record<string, unknown>[];
  learningOutcomes?: Array<{ outcome?: string; description?: string }>;
  concentrations?: Array<{ name?: string; id?: string }>;
  customFields?: Record<string, unknown>;
  [k: string]: unknown;
}
export interface ReqRule {
  condition: string;
  count?: number;
  credits?: number;
  items?: { codes: { code: string; name: string }[]; logic: string }[];
  subRules?: ReqRule[];
  name?: string;
  note?: string;
  text?: string;
  constraints?: Record<string, unknown>;
}

interface MajorEntry {
  name: string;
  degree: string;
  type: 'undergraduate' | 'graduate';
  url: string;
  description?: string;
  whatYoullLearn?: string;
  sampleCourses?: string[];
  careers?: string;
  programKind?: 'major' | 'minor' | 'certificate' | 'undeclared' | 'other' | 'special';
  status?: string;
  school?: string;
  faculty?: Array<{
    name: string;
    title?: string;
    email?: string;
    office?: string;
    phone?: string;
    profileUrl?: string;
    imageUrl?: string;
  }>;
  convener?: {
    name: string;
    title?: string;
    email?: string;
    office?: string;
    phone?: string;
    profileUrl?: string;
    imageUrl?: string;
  };
  catalogCode?: string;
  catalogUrl?: string;
  totalCredits?: string;
  requirements?: Array<{
    section: string;
    note?: string;
    selectCount?: number;
    courses?: Array<{ code: string; name: string; credits?: string }>;
    rule?: ReqRule;
  }>;
  concentrations?: string[];

  learningOutcomes?: string[];
}

interface SchoolGroup {
  school: string;
  shortName: string;
  majors: MajorEntry[];
}

interface ProgramsData {
  generatedAt: string;
  totalSchools: number;
  totalMajors: number;
  totalPrograms?: number;
  schools: SchoolGroup[];
  source?: string;
}

interface FacultyProfile {
  name?: string;
  title?: string;
  school?: string;
  email?: string;
  phone?: string;
  office?: string;
  bio?: string;
  education?: string[];
  courses?: string[];
  teachingInterests?: string[];
  researchInterests?: string[];
  publishedResearch?: string[];
  profileUrl?: string;
  imageUrl?: string;
}

// ─── API Helpers ──────────────────────────────────────────────────────────

async function apiGet(path: string): Promise<unknown> {
  const res = await fetchWithPolicy(
    `${API_BASE}${path}`,
    { headers: HEADERS },
    { expectedContentTypes: ['application/json'], maxResponseBytes: 32 * 1024 * 1024 }
  );
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${path}`);
  return res.json();
}

async function apiPost(path: string, body: unknown): Promise<unknown> {
  const res = await fetchWithPolicy(
    `${API_BASE}${path}`,
    {
      method: 'POST',
      headers: { ...HEADERS, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
    {
      expectedContentTypes: ['application/json'],
      retryNonIdempotent: true,
      maxResponseBytes: 64 * 1024 * 1024,
    }
  );
  if (!res.ok) {
    const text = res.text();
    throw new Error(`${res.status} ${res.statusText} for POST ${path}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

function stripHtml(html: string): string {
  const $ = load(html);
  $('script,style').remove();
  $('p,li,div,br,h1,h2,h3,h4').before(' ').after(' ');
  return $.root().text().replace(/\s+/g, ' ').trim();
}

// ─── Extract structured requirements from Coursedog requisitesSimple ──────

function formatCode(raw: string): string {
  return raw.replace(/([A-Z]+)(\d)/, '$1 $2').trim();
}

export function parseRule(rule: CoursedogRule, courseMap: Map<string, string>): ReqRule {
  const res: ReqRule = { condition: rule.condition || '' };
  const constraints: Record<string, unknown> = Object.fromEntries(Object.entries(rule).filter(([key]) =>
    !['id', 'condition', 'name', 'description', 'notes', 'restriction', 'credits', 'subRules', 'value'].includes(key)));
  const numeric = (key: 'restriction' | 'credits'): number | undefined => {
    const value = rule[key];
    if (value === undefined || value === '') return undefined;
    const number = typeof value === 'number' ? value : Number(value);
    if (Number.isFinite(number)) return number;
    constraints[key] = value;
    return undefined;
  };
  const count = numeric('restriction'); const credits = numeric('credits');
  if (count !== undefined) res.count = count;
  if (credits !== undefined) res.credits = credits;
  if (rule.name) res.name = stripHtml(rule.name);
  const note = [rule.description, rule.notes].filter((value): value is string => typeof value === 'string' && Boolean(value.trim())).map(stripHtml).join('\n');
  if (note) res.note = note;
  if (Array.isArray(rule.subRules)) res.subRules = rule.subRules.map(sub => parseRule(sub, courseMap));
  if (typeof rule.value === 'string') res.text = stripHtml(rule.value);
  else if (rule.value && typeof rule.value === 'object') {
    const values = rule.value.values?.length ? rule.value.values : rule.value.subSelections;
    if (rule.value.condition === 'courses' && Array.isArray(values)) {
      res.items = [];
      for (const val of values) {
        if (!Array.isArray(val.value) || val.value.some(code => typeof code !== 'string')) {
          constraints.value = rule.value;
          continue;
        }
        const codes = val.value.map(value => {
          const code = formatCode(value.replace(/\s+/g, ''));
          return { code, name: courseMap.get(code.replace(/\s+/g, '')) || '' };
        });
        res.items.push({ codes, logic: typeof val.logic === 'string' ? val.logic : '' });
      }
    } else constraints.value = rule.value;
  }
  if (Object.keys(constraints).length) res.constraints = constraints;
  return res;
}

export function extractRequirements(program: CoursedogProgram, courseMap: Map<string, string>): MajorEntry['requirements'] {
  const blocks = program.requisites?.requisitesSimple;
  if (!blocks?.length) return undefined;

  const result: NonNullable<MajorEntry['requirements']> = [];

  for (const block of blocks) {
    if (block.showInCatalog === false) continue;
    const sectionName = (block.name || block.label || 'Requirements').trim();
    if (block.rules && block.rules.length > 0) {
      const parsed = block.rules.map(rule => parseRule(rule, courseMap));
        result.push({
          section: sectionName,
          note: block.description ? stripHtml(block.description) : undefined,
          // The block publishes a sequence without an explicit combining operator.
          // Keep every sibling without claiming allOf/anyOf on its behalf.
          rule: parsed.length === 1 ? parsed[0] : { condition: 'catalogBlock', subRules: parsed }
        });
    } else if (block.description) {
      result.push({ section: sectionName, note: stripHtml(block.description) });
    }
  }

  return result.length > 0 ? result : undefined;
}

export function extractFreeformRequirements(program: CoursedogProgram): MajorEntry['requirements'] {
  const freeform = program.requisites?.requisitesFreeform;
  if (!freeform) return undefined;

  let showInCatalog = true;
  let html = '';
  if (typeof freeform === 'string') {
    html = freeform;
  } else if (typeof freeform === 'object' && !Array.isArray(freeform)) {
    const freeformValue = freeform as { showInCatalog?: unknown; value?: unknown };
    if (freeformValue.showInCatalog === false) {
      showInCatalog = false;
    }
    if (typeof freeformValue.value === 'string') {
      html = freeformValue.value;
    }
  }

  if (!showInCatalog || !html.trim()) return undefined;

  // Paragraphs around a list can contain restrictions too; retain the whole text.
  const note = stripHtml(html);

  if (!note) return undefined;

  return [{ section: 'Catalog Requirements', note }];
}


export function inferProgramType(prog: CoursedogProgram): 'undergraduate' | 'graduate' | null {
  const code = (prog.code || '').toUpperCase();
  const name = (prog.name || prog.longName || '').toLowerCase();

  if (code.includes('-BS-') || code.includes('-BA-')) return 'undergraduate';
  if (
    code.includes('-MS-') ||
    code.includes('-MA-') ||
    code.includes('-MBA-') ||
    code.includes('-MFA-') ||
    code.includes('-MPP-') ||
    code.includes('-MSN-') ||
    code.includes('-MSW-') ||
    code.includes('-DNP-')
  ) return 'graduate';
  if (/master|m\.s\.|m\.a\.|mba|mfa|mpp|msac|mael|mase|msn|msw|dnp/.test(name)) return 'graduate';
  if (/bachelor|b\.s\.|b\.a\./.test(name)) return 'undergraduate';
  return null;
}

function inferProgramKind(prog: CoursedogProgram): NonNullable<MajorEntry['programKind']> {
  const code = (prog.code || '').toUpperCase();
  const name = `${prog.name || ''} ${prog.longName || ''}`.toLowerCase();

  if (/\b4\+1\b|bs[-\s]*ms|ba[-\s]*ma/i.test(name)) return 'special';
  if (code.includes('-MN-') || /\bminor\b/.test(name)) return 'minor';
  if (code.includes('-GCR-') || /\bcertificate\b/.test(name)) return 'certificate';
  if (code.includes('-UNDC') || /\b(undeclared|undecided|non[-\s]?degree|matric)\b/.test(name)) return 'undeclared';
  if (code.includes('-NMG-')) return 'other';
  return 'major';
}

export function inferDegreeLabel(prog: CoursedogProgram, inferredType: 'undergraduate' | 'graduate'): string {
  const provided = (prog.degreeDesignation || '').trim();
  if (provided) return provided;

  const code = (prog.code || '').toUpperCase();
  const name = `${prog.name || ''} ${prog.longName || ''}`.toLowerCase();

  if (code.includes('-BSN-')) return 'Bachelor of Science in Nursing';
  if (code.includes('-BS-')) return 'Bachelor of Science';
  if (code.includes('-BA-')) return 'Bachelor of Arts';
  if (code.includes('-MS-')) return 'Master of Science';
  if (code.includes('-MSN-') || /\bmsn\b/.test(name)) return 'Master of Science in Nursing';
  if (code.includes('-MSW-') || /\bmsw\b/.test(name)) return 'Master of Social Work';
  if (code.includes('-MA-')) return 'Master of Arts';
  if (code.includes('-MBA-') || /\bmba\b/.test(name)) return 'Master of Business Administration';
  if (code.includes('-MFA-') || /\bmfa\b/.test(name)) return 'Master of Fine Arts';
  if (code.includes('-MPP-') || /\bmpp\b/.test(name)) return 'Master of Public Policy';
  if (code.includes('-DNP-') || /\bdnp\b/.test(name)) return 'Doctor of Nursing Practice';
  if (code.includes('-MN-') || /\bminor\b/.test(name)) return 'Minor';
  if (code.includes('-GCR-') || /\bcertificate\b/.test(name)) return 'Graduate Certificate';
  return inferredType === 'graduate' ? 'Graduate Program' : 'Undergraduate Program';
}

function getProgramDisplayName(prog: CoursedogProgram): string {
  const longName = (prog.longName || '').trim();
  if (longName) return longName;
  return (prog.name || '').trim() || (prog.code || '').trim() || prog.id;
}

export function parseBooleanEnv(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  const normalized = value.trim().toLowerCase();
  if (normalized === '1' || normalized === 'true' || normalized === 'yes') return true;
  if (normalized === '0' || normalized === 'false' || normalized === 'no') return false;
  return fallback;
}

function normalizeCatalogSchool(
  collegeRaw: string | undefined
): { school: string; shortName: string; facultySchool?: string } {
  const college = (collegeRaw || '').trim();
  const lower = college.toLowerCase();

  // Current names must be checked before the older broad college labels.
  const current: Record<string, string> = {
    'arts, humanities and education': 'School of Arts, Humanities, and Education',
    'school of arts, humanities, and education': 'School of Arts, Humanities, and Education',
    'science, nursing and health': 'School of Science, Nursing, and Health',
    'school of science, nursing, and health': 'School of Science, Nursing, and Health',
    'social science and social work': 'School of Social Sciences and Social Work',
    'social sciences and social work': 'School of Social Sciences and Social Work',
    'school of social sciences and social work': 'School of Social Sciences and Social Work',
  };
  if (current[lower]) return { school: current[lower], shortName: current[lower] };

  if (!college || lower.includes('matric undeclared') || lower.includes('undeclared')) {
    return { school: 'Interdisciplinary', shortName: 'Interdisciplinary' };
  }

  if (
    lower.includes('anisfield') ||
    lower.includes('graduate business') ||
    lower === 'business' ||
    lower.includes('business')
  ) {
    return {
      school: 'Anisfield School of Business',
      shortName: 'Business',
      facultySchool: 'Anisfield School of Business',
    };
  }

  if (lower.includes('contemporary arts') || lower.includes('graduate arts')) {
    return {
      school: 'School of Contemporary Arts',
      shortName: 'Contemporary Arts',
      facultySchool: 'School of Contemporary Arts',
    };
  }

  if (
    lower.includes('humanities') ||
    lower.includes('global studies') ||
    lower.includes('graduate human')
  ) {
    return {
      school: 'School of Humanities and Global Studies',
      shortName: 'Humanities',
      facultySchool: 'School of Humanities and Global Studies',
    };
  }

  if (
    lower.includes('social science') ||
    lower.includes('human services') ||
    lower.includes('human srv') ||
    lower.includes('social science graduate') ||
    lower.includes('social sciences and human services')
  ) {
    return {
      school: 'School of Social Science and Human Services',
      shortName: 'Social Science',
      facultySchool: 'School of Social Science and Human Services',
    };
  }

  if (
    lower.includes('theoretical') ||
    lower.includes('applied science') ||
    lower.includes('graduate science') ||
    lower.includes('science')
  ) {
    return {
      school: 'School of Theoretical and Applied Science',
      shortName: 'Science & Tech',
      facultySchool: 'School of Theoretical and Applied Science',
    };
  }

  return {
    school: college,
    shortName: college,
  };
}

function cleanRequirementCourses(reqs: NonNullable<MajorEntry['requirements']>): NonNullable<MajorEntry['requirements']> {
  return reqs.map((req) => {
    const cloned = { ...req };
    if (cloned.courses && cloned.courses.length > 0) {
      const seen = new Set<string>();
      cloned.courses = cloned.courses
        .filter((course) => {
          const key = `${course.code}|${course.name || ''}`.toLowerCase();
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        })
        .sort((a, b) => a.code.localeCompare(b.code));
    }
    return cloned;
  });
}

function cleanDescription(raw: string): string {
  return stripHtml(raw)
    .replace(/\s+/g, ' ')
    .trim();
}

function dedupeStrings(values: Array<string | undefined | null>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  values.forEach((value) => {
    if (!value) return;
    const trimmed = value.trim();
    if (!trimmed) return;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    result.push(trimmed);
  });
  return result;
}

function normalizeProfileUrl(url?: string): string {
  if (!url) return '';
  const raw = url.trim();
  if (!raw) return '';

  try {
    const parsed = new URL(raw);
    parsed.hash = '';
    parsed.search = '';
    const normalizedPath = parsed.pathname.replace(/\/+$/, '').toLowerCase() || '/';
    return `${parsed.origin.toLowerCase()}${normalizedPath}`;
  } catch {
    return raw
      .toLowerCase()
      .replace(/[?#].*$/, '')
      .replace(/\/+$/, '');
  }
}

/** Supported Coursedog response shapes: search arrays/envelopes and GET's ID map. */
export function catalogRecords(value: unknown): Record<string, any>[] {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'object') throw new Error('Invalid catalog response.');
  const record = value as Record<string, unknown>;
  for (const key of ['data', 'programs', 'results']) if (key in record) return catalogRecords(record[key]);
  const rows = Object.values(record);
  if (rows.every(row => row && typeof row === 'object' && typeof (row as Record<string, unknown>).code === 'string')) return rows as Record<string, any>[];
  throw new Error('Unrecognized catalog response; refusing a partial catalog.');
}

export interface CatalogCapture { scrapedAt: string; programs: CoursedogProgram[]; courses: Record<string, any>[] }

/** Catalog fields establish affiliations; exact, unique profile URLs can add contact details. */
function catalogPeople(program: CoursedogProgram, field: 'rJQmj' | 'xiQxl', profiles: FacultyProfile[]): NonNullable<MajorEntry['faculty']> {
  const html = program.customFields?.[field];
  if (typeof html !== 'string' || !html.trim()) return [];
  const $ = load(html); const people: NonNullable<MajorEntry['faculty']> = [];
  $('a[href]').each((_, element) => {
    const name = $(element).text().replace(/\s+/g, ' ').trim();
    let url: URL;
    try { url = new URL($(element).attr('href') || '', 'https://www.ramapo.edu'); } catch { return; }
    if (!name || url.hostname !== 'www.ramapo.edu' || !/^https?:$/.test(url.protocol) || !url.pathname.includes('/faculty/')) return;
    const profileUrl = url.toString();
    const matches = profiles.filter(profile => normalizeProfileUrl(profile.profileUrl) === normalizeProfileUrl(profileUrl));
    const details = matches.length === 1 ? matches[0] : undefined;
    people.push({ name, profileUrl, ...Object.fromEntries(['title', 'email', 'phone', 'office', 'imageUrl'].flatMap(key => {
      const value = details?.[key as keyof FacultyProfile];
      return typeof value === 'string' && value.trim() ? [[key, value.trim()]] : [];
    })) });
  });
  // A plain-text Convener field identifies its named person but supplies no URL to join.
  if (!people.length && field === 'rJQmj' && !$.root().find('a').length) {
    const name = stripHtml(html);
    if (name) people.push({ name });
  }
  return [...new Map(people.map(person => [JSON.stringify([person.name, person.profileUrl]), person])).values()];
}

/** Deterministic rebuild from one captured catalog; never reads/writes files or reuses a prior publication. */
export function normalizeCatalogCapture(capture: CatalogCapture, profiles: FacultyProfile[] = [], includeInactive = false): { programs: ProgramsData; courses: Record<string, Record<string, unknown>> } {
  if (!Number.isFinite(Date.parse(capture.scrapedAt)) || !Array.isArray(capture.programs) || !Array.isArray(capture.courses)) throw new Error('Expected a dated program and course capture.');
  const courses: Record<string, Record<string, unknown>> = {};
  const courseMap = new Map<string, string>();
  for (const source of capture.courses) {
    if (typeof source.code !== 'string' || !source.code.trim()) throw new Error('A catalog course has no code.');
    if (source.status && String(source.status).toLowerCase() !== 'active') continue;
    const code = formatCode(source.code.replace(/\s+/g, ''));
    const name = String(source.longName || source.name || '').trim();
    const value = { code, name, description: stripHtml(source.description || ''), credits: source.credits?.creditHours ?? source.credits ?? '', attributes: source.attributes || [] };
    if (courses[code] && JSON.stringify(courses[code]) !== JSON.stringify(value)) throw new Error(`Conflicting catalog course code ${code}.`);
    courses[code] = value;
    courseMap.set(code.replace(/\s+/g, ''), name);
  }
  const byCode = new Map<string, MajorEntry>();
  for (const source of capture.programs) {
    const status = String(source.status || '').trim().toLowerCase() || 'unknown';
    if (!includeInactive && status !== 'active') continue;
    const code = (source.code || '').trim();
    if (!code) throw new Error('A catalog program has no code.');
    const type = inferProgramType(source) || (inferProgramKind(source) === 'certificate' ? 'graduate' : 'undergraduate');
    const catalogUrl = `https://catalog.ramapo.edu/programs/${code}`;
    const requirements = cleanRequirementCourses([...(extractRequirements(source, courseMap) || []), ...(extractFreeformRequirements(source) || [])]);
    const description = cleanDescription(source.catalogFullDescription || source.catalogDescription || source.descriptionHtml || '');
    const faculty = catalogPeople(source, 'xiQxl', profiles);
    const conveners = catalogPeople(source, 'rJQmj', profiles);
    const concentrations = dedupeStrings((source.concentrations || []).map(item => item.name));
    const learningOutcomes = dedupeStrings((source.learningOutcomes || []).map(item => item.outcome || item.description));
    const entry: MajorEntry = {
      name: getProgramDisplayName(source), degree: inferDegreeLabel(source, type), type,
      url: catalogUrl, catalogUrl, catalogCode: code, status,
      school: normalizeCatalogSchool(source.college).school, programKind: inferProgramKind(source),
      ...(description ? { description } : {}),
      ...(source.totalCredits !== undefined && source.totalCredits !== '' ? { totalCredits: String(source.totalCredits) } : {}),
      ...(requirements.length ? { requirements } : {}),
      ...(faculty.length ? { faculty } : {}),
      ...(conveners.length === 1 ? { convener: conveners[0] } : {}),
      ...(concentrations.length ? { concentrations } : {}),
      ...(learningOutcomes.length ? { learningOutcomes } : {}),
    };
    const previous = byCode.get(code);
    if (previous && JSON.stringify(previous) !== JSON.stringify(entry)) throw new Error(`Conflicting catalog program code ${code}.`);
    byCode.set(code, entry);
  }
  const schoolMap = new Map<string, SchoolGroup>();
  for (const entry of byCode.values()) {
    const school = entry.school!;
    if (!schoolMap.has(school)) schoolMap.set(school, { school, shortName: school, majors: [] });
    schoolMap.get(school)!.majors.push(entry);
  }
  const schools = [...schoolMap.values()].sort((a, b) => a.school.localeCompare(b.school));
  for (const school of schools) school.majors.sort((a, b) => a.name.localeCompare(b.name) || a.catalogCode!.localeCompare(b.catalogCode!));
  return { programs: { generatedAt: capture.scrapedAt, source: `${API_BASE}/programs/search/%24filters`, totalSchools: schools.length, totalMajors: byCode.size, totalPrograms: byCode.size, schools }, courses };
}

async function main() {
  const searchBody = { skip: 0, limit: 500, formatDependencies: true,
    columns: ['name', 'code', 'longName', 'college', 'degreeDesignation', 'status', 'catalogFullDescription', 'catalogDescription', 'totalCredits', 'requisites', 'learningOutcomes', 'concentrations', 'customFields'] };
  let programs: CoursedogProgram[];
  try { programs = catalogRecords(await apiPost('/programs/search/%24filters', searchBody)) as CoursedogProgram[]; }
  catch { programs = catalogRecords(await apiGet('/programs?limit=500&formatDependencies=true')) as CoursedogProgram[]; }
  if (programs.length >= searchBody.limit) throw new Error('Program response reached its page limit; refusing an incomplete catalog.');
  assertCollectionCount({ dataset: 'Coursedog catalog programs', count: programs.length, minimum: 50,
    previousFilePath: RAW_OUT, minimumPreviousRatio: 0.8 });
  const courses = catalogRecords(await apiPost('/courses/search/%24filters', { skip: 0, limit: 10000,
    columns: ['code', 'name', 'longName', 'status', 'attributes', 'description', 'credits'] }));
  if (courses.length >= 10000) throw new Error('Course response reached its page limit; refusing an incomplete catalog.');
  assertCollectionCount({ dataset: 'Coursedog catalog courses', count: courses.length, minimum: 1000 });
  const capture: CatalogCapture = { scrapedAt: new Date().toISOString(), programs, courses };
  const facultyPath = fs.existsSync(FACULTY_JSON) ? FACULTY_JSON : FACULTY_RAW_JSON;
  const profiles = fs.existsSync(facultyPath) ? JSON.parse(fs.readFileSync(facultyPath, 'utf8')) as FacultyProfile[] : [];
  const normalized = normalizeCatalogCapture(capture, profiles, parseBooleanEnv(process.env.PROGRAMS_INCLUDE_INACTIVE, false));
  const validated = validateProgramsData(normalized.programs);
  // Validate the complete capture before replacing any prior artifact.
  writeJsonFile(RAW_OUT, { ...capture, count: programs.length + courses.length, programCount: programs.length, courseCount: courses.length });
  writeRawFileProvenance('catalog-programs', RAW_OUT, { sourceUrl: `${API_BASE}/programs/search/%24filters`, recordCount: programs.length + courses.length, fetchedAt: capture.scrapedAt });
  if (isRawOnlyMode()) return;
  writeJsonFile(COURSES_JSON, normalized.courses);
  writeJsonFile(PROGRAMS_JSON, validated);
  writeJsonFile(NORMALIZED_PROGRAMS_JSON, validated);
  console.log(`Wrote ${validated.totalPrograms} catalog programs and ${Object.keys(normalized.courses).length} courses.`);
}

if (process.argv[1]?.endsWith('scrape-catalog-api.ts')) {
  main().catch(error => { console.error('Fatal:', error); process.exitCode = 1; });
}
