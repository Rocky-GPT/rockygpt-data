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
import { load, type CheerioAPI } from 'cheerio';
import { catalogDepartments, catalogSettings, type CatalogDepartment, type CatalogSettings, type PageLayout } from './catalog-page-settings';
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
// Any server-rendered catalog page carries the page layouts; this one also lists every department.
const CATALOG_DEPARTMENTS_PAGE = 'https://catalog.ramapo.edu/departments';

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
  programGroupId?: string;
  name?: string;
  code?: string;
  career?: string;
  degreeDesignations?: string[];
  departments?: string[];
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
  /** The requirements as the catalog lists them; the structured sections remain the record. */
  requirementsText?: string;
  requirements?: Array<{
    section: string;
    note?: string;
    selectCount?: number;
    courses?: Array<{ code: string; name: string; credits?: string }>;
    rule?: ReqRule;
  }>;
  concentrations?: string[];

  learningOutcomes?: string[];
  /** Every field the catalog's program page displays, by tab, under the catalog's own labels. */
  catalogSections?: Array<{ title: string; fields: Array<{ key: string; label: string; text: string }> }>;
  learningGoalsAndOutcomes?: string;
  sampleGraduationPlan?: string;
  /** The catalog's Concentrations field, as displayed. */
  catalogConcentrations?: string;
  programLevel?: string;
  degreeDesignations?: string[];
  conveningGroups?: string[];
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

/** Linked programs and courses display their catalog names, not the text stored with the link. */
interface CatalogNames { program(id: string): string | undefined; course(id: string): string | undefined }

function resolveCatalogLinks($: CheerioAPI, names?: CatalogNames) {
  if (!names) return;
  $('a[data-program-id]').each((_, element) => {
    const name = names.program($(element).attr('data-program-id') || '');
    if (name) $(element).text(name);
  });
  $('a[data-course-id]').each((_, element) => {
    const name = names.course($(element).attr('data-course-id') || '');
    if (name) $(element).text(name);
  });
}

function stripHtml(html: string, names?: CatalogNames): string {
  const $ = load(html);
  $('script,style').remove();
  resolveCatalogLinks($, names);
  $('p,li,div,br,h1,h2,h3,h4').before(' ').after(' ');
  return $.root().text().replace(/\s+/g, ' ').trim();
}

/** Catalog rich text with its structure kept: each paragraph, heading and list item on its
 * own line, bulleted items marked and numbered items keeping their numbers. */
export function catalogText(html: string, names?: CatalogNames): string {
  const $ = load(html);
  $('script,style').remove();
  resolveCatalogLinks($, names);
  $('li p').each((_, paragraph) => { $(paragraph).before(' ').after(' ').replaceWith($(paragraph).contents()); });
  $('br').replaceWith('\n');
  $('ol').each((_, list) => { $(list).children('li').each((index, item) => { $(item).prepend(`${index + 1}. `); }); });
  $('ul').each((_, list) => { $(list).children('li').prepend('- '); });
  $('p,li,div,h1,h2,h3,h4,h5,h6,tr').before('\n').after('\n');
  return $.root().text().split('\n').map(line => line.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n');
}

// ─── Extract structured requirements from Coursedog requisitesSimple ──────

function formatCode(raw: string): string {
  return raw.replace(/([A-Z]+)(\d)/, '$1 $2').trim();
}

export function parseRule(rule: CoursedogRule, courseMap: Map<string, string>, references?: Map<string, string>): ReqRule {
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
  const note = [rule.description, rule.notes].filter((value): value is string => typeof value === 'string' && Boolean(value.trim())).map(value => catalogText(value)).join('\n');
  if (note) res.note = note;
  if (Array.isArray(rule.subRules)) res.subRules = rule.subRules.map(sub => parseRule(sub, courseMap, references));
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
          // Most options name a course code; some cite the course's catalog group ID instead.
          const code = formatCode((references?.get(value) ?? value).replace(/\s+/g, ''));
          return { code, name: courseMap.get(code.replace(/\s+/g, '')) || '' };
        });
        res.items.push({ codes, logic: typeof val.logic === 'string' ? val.logic : '' });
      }
    } else constraints.value = rule.value;
  }
  if (Object.keys(constraints).length) res.constraints = constraints;
  return res;
}

export function extractRequirements(program: Pick<CoursedogProgram, 'requisites'>, courseMap: Map<string, string>, references?: Map<string, string>): MajorEntry['requirements'] {
  const blocks = program.requisites?.requisitesSimple;
  if (!blocks?.length) return undefined;

  const result: NonNullable<MajorEntry['requirements']> = [];

  for (const block of blocks) {
    if (block.showInCatalog === false) continue;
    const sectionName = (block.name || block.label || 'Requirements').trim();
    if (block.rules && block.rules.length > 0) {
      const parsed = block.rules.map(rule => parseRule(rule, courseMap, references));
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

function cleanDescription(raw: string, names?: CatalogNames): string {
  return stripHtml(raw, names)
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

export interface CatalogCapture {
  scrapedAt: string; programs: CoursedogProgram[]; courses: Record<string, any>[];
  /** The catalog's page layouts and department names, captured with the records they describe. */
  settings?: CatalogSettings; departments?: CatalogDepartment[];
}

const CONDITIONS: Record<string, string> = {
  allOf: 'all of', completedAllOf: 'complete all of', anyOf: 'any of', completedAnyOf: 'complete any of',
  catalogBlock: '', freeformText: '',
};

/** Requirements as the catalog lists them: each section, each rule by its published name and
 * condition, every course option and note. The structured requirements remain the record. */
export function requirementsText(sections: NonNullable<MajorEntry['requirements']>): string {
  const lines: string[] = [];
  const rule = (item: ReqRule, depth: number) => {
    const pad = '  '.repeat(depth);
    const condition = item.condition === 'completedAtLeastXOf' && item.count !== undefined ? `complete at least ${item.count} of`
      : CONDITIONS[item.condition] ?? item.condition;
    const head = [item.name, condition, item.text].filter(Boolean).join(': ');
    if (head) lines.push(`${pad}${head}`);
    if (item.credits !== undefined) lines.push(`${pad}  ${item.credits} credits`);
    for (const option of item.items ?? []) {
      lines.push(`${pad}  ${option.codes.map(course => [course.code, course.name].filter(Boolean).join(' ')).join(option.logic === 'or' ? ' or ' : ', ')}`);
    }
    for (const note of item.note?.split('\n') ?? []) lines.push(`${pad}  ${note}`);
    for (const sub of item.subRules ?? []) rule(sub, depth + 1);
  };
  for (const section of sections) {
    lines.push(section.section);
    for (const note of section.note?.split('\n') ?? []) lines.push(`  ${note}`);
    for (const course of section.courses ?? []) lines.push(`  ${[course.code, course.name].filter(Boolean).join(' ')}`);
    if (section.rule) rule(section.rule, 1);
  }
  return lines.join('\n');
}

type CatalogSection = NonNullable<MajorEntry['catalogSections']>[number];

/** The fields a catalog page displays, tab by tab, as their displayed text. Requirements are kept
 * in their structured form elsewhere; empty fields display nothing and are left out. */
function pageSections(
  source: Record<string, unknown>, layout: PageLayout, names: CatalogNames, departments: Map<string, string>,
): CatalogSection[] {
  const customFields = (source.customFields && typeof source.customFields === 'object' ? source.customFields : {}) as Record<string, unknown>;
  const text = (key: string, value: unknown): string => {
    if (typeof value === 'string') return key === 'catalogFullDescription' || /<[a-z]/i.test(value) ? catalogText(value, names) : value.trim();
    if (Array.isArray(value)) {
      // A department select stores department IDs; the page shows their names.
      return value.filter((item): item is string => typeof item === 'string' && Boolean(item.trim()))
        .map(item => departments.get(item) ?? item.trim()).join('\n');
    }
    return typeof value === 'number' ? String(value) : '';
  };
  return layout.tabs.map(tab => ({
    title: tab.title,
    fields: tab.fields.filter(field => field.key !== 'requisites' && field.label !== field.key).flatMap(field => {
      const value = text(field.key, field.key in customFields ? customFields[field.key] : source[field.key]);
      return value ? [{ key: field.key, label: field.label, text: value }] : [];
    }),
  })).filter(tab => tab.fields.length);
}

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
  // Course group and record IDs, which some requirements and links cite instead of a code.
  const references = new Map<string, string>();
  const active: Record<string, any>[] = [];
  for (const source of capture.courses) {
    if (typeof source.code !== 'string' || !source.code.trim()) throw new Error('A catalog course has no code.');
    const compact = source.code.replace(/\s+/g, '');
    for (const key of [source.courseGroupId, source.id, source._id]) if (typeof key === 'string' && key.trim()) references.set(key.trim(), compact);
    if (source.status && String(source.status).toLowerCase() !== 'active') continue;
    active.push(source);
    courseMap.set(compact, String(source.longName || source.name || '').trim());
  }
  const programNames = new Map<string, string>();
  for (const source of capture.programs) {
    for (const key of [source.code, source.programGroupId, source.id]) if (typeof key === 'string' && key.trim()) programNames.set(key.trim(), getProgramDisplayName(source));
  }
  const names: CatalogNames = {
    program: id => programNames.get(id),
    course: id => { const code = references.get(id) ?? (courseMap.has(id) ? id : undefined); return code ? formatCode(code) : undefined; },
  };
  const departments = new Map((capture.departments ?? []).map(department => [department.id, department.name]));
  // Programs cite departments by ID; course records embed each department with its display name.
  const departmentNames = (values: unknown): string[] => dedupeStrings((Array.isArray(values) ? values : []).map(value => {
    if (typeof value === 'string') return departments.get(value);
    const department = value && typeof value === 'object' ? value as Record<string, unknown> : {};
    return typeof department.displayName === 'string' ? department.displayName : departments.get(String(department.id ?? ''));
  }));
  for (const source of active) {
    const code = formatCode(source.code.replace(/\s+/g, ''));
    const name = String(source.longName || source.name || '').trim();
    const requisites = extractRequirements(source, courseMap, references);
    const conveningGroups = departmentNames(source.departments);
    // The catalog page shows a course's maximum credit hours as its Credits (4 for a stored
    // "0 TO 4"); the stored hours are kept beside it as creditHours.
    const hours = source.credits?.creditHours ?? source.credits ?? '';
    const shown = hours && typeof hours === 'object' ? hours.max : undefined;
    const value = {
      code, name, description: stripHtml(source.description || '', names), attributes: source.attributes || [],
      ...(typeof shown === 'number' && Number.isFinite(shown) && shown >= 0 ? { credits: shown, creditHours: hours } : { credits: hours }),
      // Written for every course, empty when the catalog has none, so absence reads as unpublished.
      requisites: requisites ?? [], requisitesText: requisites?.length ? requirementsText(requisites) : null,
      conveningGroups, school: typeof source.college === 'string' && source.college.trim() ? source.college.trim() : null,
    };
    if (courses[code] && JSON.stringify(courses[code]) !== JSON.stringify(value)) throw new Error(`Conflicting catalog course code ${code}.`);
    courses[code] = value;
  }
  const byCode = new Map<string, MajorEntry>();
  for (const source of capture.programs) {
    const status = String(source.status || '').trim().toLowerCase() || 'unknown';
    if (!includeInactive && status !== 'active') continue;
    const code = (source.code || '').trim();
    if (!code) throw new Error('A catalog program has no code.');
    const type = inferProgramType(source) || (inferProgramKind(source) === 'certificate' ? 'graduate' : 'undergraduate');
    const catalogUrl = `https://catalog.ramapo.edu/programs/${code}`;
    const requirements = cleanRequirementCourses([...(extractRequirements(source, courseMap, references) || []), ...(extractFreeformRequirements(source) || [])]);
    const description = cleanDescription(source.catalogFullDescription || source.catalogDescription || source.descriptionHtml || '', names);
    const catalogSections = capture.settings ? pageSections(source, capture.settings.program, names, departments) : [];
    const displayed = (label: string) => catalogSections.flatMap(section => section.fields).find(field => field.label === label)?.text;
    const degreeDesignations = dedupeStrings(source.degreeDesignations ?? []);
    // The page shows the Convening Group field; the record's own department list is the fallback.
    const conveningGroups = departmentNames(source.customFields?.YdbEO ?? source.departments);
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
      ...(requirements.length ? { requirements, requirementsText: requirementsText(requirements) } : {}),
      ...(faculty.length ? { faculty } : {}),
      ...(conveners.length === 1 ? { convener: conveners[0] } : {}),
      ...(concentrations.length ? { concentrations } : {}),
      ...(learningOutcomes.length ? { learningOutcomes } : {}),
      ...(catalogSections.length ? { catalogSections } : {}),
      ...Object.fromEntries(([
        ['learningGoalsAndOutcomes', 'Learning Goals and Outcomes'], ['sampleGraduationPlan', 'Sample Graduation Plan'],
        ['catalogConcentrations', 'Concentrations'], ['programLevel', 'Program Level'],
      ] as const).flatMap(([key, label]) => { const text = displayed(label); return text ? [[key, text]] : []; })),
      ...(degreeDesignations.length ? { degreeDesignations } : {}),
      ...(conveningGroups.length ? { conveningGroups } : {}),
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
  const page = await fetchWithPolicy(CATALOG_DEPARTMENTS_PAGE, { headers: { ...HEADERS, accept: 'text/html,application/xhtml+xml' } },
    { expectedContentTypes: ['text/html'], maxResponseBytes: 16 * 1024 * 1024 });
  if (!page.ok) throw new Error(`${page.status} ${page.statusText} for ${CATALOG_DEPARTMENTS_PAGE}`);
  const html = page.text();
  const settings = catalogSettings(html);
  const departments = catalogDepartments(html);
  const searchBody = { skip: 0, limit: 500, formatDependencies: true,
    columns: ['name', 'code', 'longName', 'programGroupId', 'college', 'career', 'degreeDesignation', 'degreeDesignations', 'departments', 'status', 'catalogFullDescription', 'catalogDescription', 'totalCredits', 'requisites', 'learningOutcomes', 'concentrations', 'customFields'] };
  let programs: CoursedogProgram[];
  try { programs = catalogRecords(await apiPost('/programs/search/%24filters', searchBody)) as CoursedogProgram[]; }
  catch { programs = catalogRecords(await apiGet('/programs?limit=500&formatDependencies=true')) as CoursedogProgram[]; }
  if (programs.length >= searchBody.limit) throw new Error('Program response reached its page limit; refusing an incomplete catalog.');
  assertCollectionCount({ dataset: 'Coursedog catalog programs', count: programs.length, minimum: 50,
    previousFilePath: RAW_OUT, minimumPreviousRatio: 0.8 });
  const courses = catalogRecords(await apiPost('/courses/search/%24filters', { skip: 0, limit: 10000,
    columns: ['code', 'name', 'longName', 'courseGroupId', 'status', 'attributes', 'description', 'credits', 'college', 'departments', 'requisites'] }));
  if (courses.length >= 10000) throw new Error('Course response reached its page limit; refusing an incomplete catalog.');
  assertCollectionCount({ dataset: 'Coursedog catalog courses', count: courses.length, minimum: 1000 });
  const capture: CatalogCapture = { scrapedAt: new Date().toISOString(), programs, courses, settings, departments };
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
