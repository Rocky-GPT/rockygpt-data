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
import { fetchWithPolicy } from './http-client';
import {
  assertCollectionCount,
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
  type?: string;
  value?: {
    values?: Array<{ value?: string; name?: string; credits?: string }>;
    courses?: CoursedogCourseRef[];
    courseIds?: string[];
  };
  label?: string;
  credits?: number | string;
  count?: number;
}

interface CoursedogRequirementBlock {
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

interface ExistingProgramMetadata {
  name: string;
  degree: string;
  type: 'undergraduate' | 'graduate';
  url?: string;
  description?: string;
  whatYoullLearn?: string;
  sampleCourses?: string[];
  careers?: string;
  catalogCode?: string;
  catalogUrl?: string;
  totalCredits?: string;
  requirements?: MajorEntry['requirements'];
  concentrations?: string[];
  learningOutcomes?: string[];
  faculty?: MajorEntry['faculty'];
  convener?: MajorEntry['convener'];
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
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#\d+;/g, '')
}

// ─── Ramapo General Education Requirements (Undergraduate) ──────────────────
const GEN_ED_REQUIREMENTS: MajorEntry['requirements'] = [
  { section: "General Education: First-Year Seminar (FYS)", courses: [], note: "Waived for students who transfer in 30 or more credits. Required for all first-time, first-year students.", selectCount: 1 },
  { section: "General Education: Critical Reading and Writing (CRWT)", courses: [{code: "CRWT 102", name: "Critical Reading and Writing II"}], note: "Placement testing may require CRWT 101 first.", selectCount: 1 },
  { section: "General Education: Studies in the Arts and Humanities", courses: [], note: "Choose one course from the approved Arts and Humanities list.", selectCount: 1 },
  { section: "General Education: Social Science Inquiry", courses: [], note: "Choose one course from the approved Social Science list.", selectCount: 1 },
  { section: "General Education: Historical Perspectives", courses: [], note: "Choose one course from the approved History list.", selectCount: 1 },
  { section: "General Education: Global Awareness", courses: [], note: "Choose one course from the approved Global Awareness list.", selectCount: 1 },
  { section: "General Education: Quantitative Reasoning", courses: [{code: "MATH 101", name: "Math with Applications"}, {code: "MATH 104", name: "Math for the Modern World"}, {code: "MATH 106", name: "Intro to Math Modeling"}, {code: "MATH 108", name: "Elementary Probability and Statistics"}, {code: "MATH 110", name: "Precalculus"}, {code: "MATH 121", name: "Calculus I"}], note: "Choose one. Major may specify a particular math course.", selectCount: 1 },
  { section: "General Education: Scientific Reasoning", courses: [], note: "Choose one course with a lab from the approved Science list. Major may specify.", selectCount: 1 },
  { section: "General Education: Distribution Categories", courses: [], note: "Choose two unique courses from: Culture and Creativity, Values and Ethics, Systems Sustainability and Society.", selectCount: 2 }
];

// ─── Extract structured requirements from Coursedog requisitesSimple ──────

function formatCode(raw: string): string {
  return raw.replace(/([A-Z]+)(\d)/, '$1 $2').trim();
}

export interface ReqRule {
  condition: string;
  count?: number;
  items?: { codes: { code: string; name: string }[]; logic: string }[];
  subRules?: ReqRule[];
}

function parseRule(rule: any, courseMap: Map<string, string>): ReqRule | undefined {
  if (!rule) return undefined;
  
  const res: ReqRule = { condition: rule.condition || '' };

  if (typeof rule.restriction === 'number') res.count = rule.restriction;
  else if (typeof rule.restriction === 'string') res.count = parseInt(rule.restriction, 10);
  
  if (typeof rule.credits === 'number') res.credits = rule.credits;
  else if (typeof rule.credits === 'string') res.credits = parseInt(rule.credits, 10);

  const match = res.condition.match(/AtLeast(\d+)Of/i);
  if (match && !res.count) res.count = parseInt(match[1], 10);

  if (res.condition.toLowerCase().includes('minimumcredit')) {
    if (!res.credits && res.count) {
       res.credits = res.count;
       res.count = undefined; // Move from count to credits
    }
  }

  if (rule.subRules && rule.subRules.length > 0) {
    res.subRules = rule.subRules.map((sr: any) => parseRule(sr, courseMap)).filter(Boolean) as ReqRule[];
  }

  let ruleVals = rule.value?.values;
  if (!ruleVals || ruleVals.length === 0) {
     ruleVals = rule.value?.subSelections;
  }
  
  if (Array.isArray(ruleVals) && ruleVals.length > 0) {
    res.items = [];
    for (const val of ruleVals) {
      if (!val.value || !Array.isArray(val.value)) continue;
      const codes = val.value.map((v: string) => {
        const fmt = formatCode(v.replace(/\s+/g, ''));
        return { code: fmt, name: courseMap.get(fmt.replace(/\s+/g, '')) || '' };
      });
      if (codes.length > 0) {
        res.items.push({ codes, logic: val.logic || 'and' });
      }
    }
  }

  return (res.subRules?.length || res.items?.length) ? res : undefined;
}

function extractRequirements(program: CoursedogProgram, courseMap: Map<string, string>): MajorEntry['requirements'] {
  const blocks = program.requisites?.requisitesSimple;
  if (!blocks?.length) return undefined;

  const result: NonNullable<MajorEntry['requirements']> = [];

  for (const block of blocks) {
    const sectionName = (block.name || block.label || 'Requirements').trim();
    if (block.rules && block.rules.length > 0) {
      const parsed = parseRule(block.rules[0], courseMap);
      if (parsed) {
        result.push({
          section: sectionName,
          note: block.description ? stripHtml(block.description) : undefined,
          rule: parsed
        });
      }
    }
  }

  return result.length > 0 ? result : undefined;
}

function extractFreeformRequirements(program: CoursedogProgram): MajorEntry['requirements'] {
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

  const items: string[] = [];
  const liRegex = /<li[^>]*>([\s\S]*?)<\/li>/gi;
  let liMatch: RegExpExecArray | null = null;
  while ((liMatch = liRegex.exec(html)) !== null) {
    const itemText = stripHtml(decodeHtmlEntities(liMatch[1] || ''))
      .replace(/\s+/g, ' ')
      .trim();
    if (itemText) {
      items.push(itemText);
    }
  }

  const note = items.length > 0
    ? items.map((item) => `- ${item}`).join('\n')
    : stripHtml(decodeHtmlEntities(html)).replace(/\s+/g, ' ').trim();

  if (!note) return undefined;

  return [{ section: 'Catalog Requirements', note }];
}


// ─── Normalize program name for matching ─────────────────────────────────

function normName(s: string): string {
  return s.toLowerCase()
    .replace(/\b(bachelor of science|bachelor of arts|master of science|master of arts|master of business administration|master of public policy|4\+1|b\.s\.|b\.a\.|m\.s\.|m\.a\.|mba|mpp|bs|ba|ms|ma|minor)\b/gi, '')
    .replace(/[()]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function isFourPlusOneText(value: string): boolean {
  return /4\+1|bs[-\s]*ms|ba[-\s]*ma|accelerated/i.test(value);
}

function isFourPlusOneMajorName(name: string): boolean {
  return isFourPlusOneText(name);
}

function inferProgramType(prog: CoursedogProgram): 'undergraduate' | 'graduate' | null {
  const code = (prog.code || '').toUpperCase();
  const name = (prog.name || prog.longName || '').toLowerCase();

  if (code.includes('-BS-') || code.includes('-BA-')) return 'undergraduate';
  if (
    code.includes('-MS-') ||
    code.includes('-MA-') ||
    code.includes('-MBA-') ||
    code.includes('-MPP-') ||
    code.includes('-MSN-') ||
    code.includes('-MSW-') ||
    code.includes('-DNP-')
  ) return 'graduate';
  if (/master|m\.s\.|m\.a\.|mba|mpp|msac|mael|mase|msn|msw|dnp/.test(name)) return 'graduate';
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

function inferDegreeLabel(prog: CoursedogProgram, inferredType: 'undergraduate' | 'graduate'): string {
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

function parseBooleanEnv(value: string | undefined, fallback: boolean): boolean {
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

function cloneGenEdRequirements(): NonNullable<MajorEntry['requirements']> {
  return JSON.parse(JSON.stringify(GEN_ED_REQUIREMENTS)) as NonNullable<MajorEntry['requirements']>;
}

function cleanDescription(raw: string): string {
  return stripHtml(raw)
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeFacultySchool(rawSchool: string): string {
  const cleaned = rawSchool
    .replace(/\s*\([^)]*\)\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (cleaned.toLowerCase().includes('social science and human services')) {
    return 'School of Social Science and Human Services';
  }
  if (cleaned.toLowerCase().includes('theoretical and applied science')) {
    return 'School of Theoretical and Applied Science';
  }
  if (cleaned.toLowerCase().includes('humanities and global studies')) {
    return 'School of Humanities and Global Studies';
  }
  if (cleaned.toLowerCase().includes('contemporary arts')) {
    return 'School of Contemporary Arts';
  }
  if (cleaned.toLowerCase().includes('anisfield school of business')) {
    return 'Anisfield School of Business';
  }

  return cleaned;
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

function normalizePersonName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[\u2019']/g, '')
    .replace(/[^a-z0-9]/g, '');
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

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

interface FacultyLinkEntry {
  name: string;
  profileUrl?: string;
}

function toAbsoluteRamapoUrl(rawHref: string): string | undefined {
  if (!rawHref) return undefined;
  try {
    return new URL(rawHref, 'https://www.ramapo.edu').toString();
  } catch {
    return undefined;
  }
}

function extractFacultyLinksFromCustomFields(customFields: unknown): FacultyLinkEntry[] {
  if (!customFields || typeof customFields !== 'object' || Array.isArray(customFields)) {
    return [];
  }

  const links: FacultyLinkEntry[] = [];
  for (const value of Object.values(customFields)) {
    if (typeof value !== 'string' || !value.trim()) continue;

    const anchorRegex = /<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
    let match: RegExpExecArray | null = null;
    while ((match = anchorRegex.exec(value)) !== null) {
      const href = (match[1] || '').trim();
      if (!href.toLowerCase().includes('/faculty/')) continue;

      const text = decodeHtmlEntities((match[2] || '').replace(/<[^>]+>/g, ' '))
        .replace(/\s+/g, ' ')
        .trim();
      if (!text) continue;

      const link: FacultyLinkEntry = { name: text };
      const absoluteUrl = toAbsoluteRamapoUrl(href);
      if (absoluteUrl) link.profileUrl = absoluteUrl;
      links.push(link);
    }
  }

  const deduped = new Map<string, FacultyLinkEntry>();
  links.forEach((link) => {
    const key = normalizePersonName(link.name);
    if (!key) return;
    if (!deduped.has(key)) {
      deduped.set(key, link);
    }
  });

  return Array.from(deduped.values());
}

function looksLikePersonName(raw: string): boolean {
  const value = raw.replace(/\s+/g, ' ').trim();
  if (!value || value.length > 80) return false;
  if (/\d/.test(value)) return false;
  if (/\b(goal|outcome|program|requirement|course|school|major|minor|certificate)\b/i.test(value)) return false;

  const parts = value.split(' ').filter(Boolean);
  if (parts.length < 2 || parts.length > 5) return false;
  return parts.every((part) => /^[A-Za-z][A-Za-z.'\u2019-]*$/.test(part));
}

function extractConvenerFromHtmlValue(value: string): FacultyLinkEntry | undefined {
  const facultyLinks: FacultyLinkEntry[] = [];
  const anchorRegex = /<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let anchorMatch: RegExpExecArray | null = null;
  while ((anchorMatch = anchorRegex.exec(value)) !== null) {
    const href = (anchorMatch[1] || '').trim();
    if (!href.toLowerCase().includes('/faculty/')) continue;
    const name = decodeHtmlEntities((anchorMatch[2] || '').replace(/<[^>]+>/g, ' '))
      .replace(/\s+/g, ' ')
      .trim();
    if (!looksLikePersonName(name)) continue;

    const link: FacultyLinkEntry = { name };
    const absoluteUrl = toAbsoluteRamapoUrl(href);
    if (absoluteUrl) link.profileUrl = absoluteUrl;
    facultyLinks.push(link);
  }

  const dedupedLinks = new Map<string, FacultyLinkEntry>();
  facultyLinks.forEach((link) => {
    const key = normalizePersonName(link.name);
    if (!key || dedupedLinks.has(key)) return;
    dedupedLinks.set(key, link);
  });
  if (dedupedLinks.size === 1) {
    return Array.from(dedupedLinks.values())[0];
  }

  const paragraphRegex = /<p[^>]*>([\s\S]*?)<\/p>/gi;
  const names: string[] = [];
  let paragraphMatch: RegExpExecArray | null = null;
  while ((paragraphMatch = paragraphRegex.exec(value)) !== null) {
    const text = decodeHtmlEntities((paragraphMatch[1] || '').replace(/<[^>]+>/g, ' '))
      .replace(/\s+/g, ' ')
      .trim();
    if (!looksLikePersonName(text)) continue;
    names.push(text);
  }

  const dedupedNames = Array.from(new Map(names.map((name) => [normalizePersonName(name), name])).values())
    .filter(Boolean);
  if (dedupedNames.length === 1) {
    return { name: dedupedNames[0] };
  }

  return undefined;
}

function extractConvenerFromCustomFields(customFields: unknown): FacultyLinkEntry | undefined {
  if (!customFields || typeof customFields !== 'object' || Array.isArray(customFields)) {
    return undefined;
  }

  const candidates: FacultyLinkEntry[] = [];
  for (const value of Object.values(customFields)) {
    if (typeof value !== 'string' || !value.trim()) continue;
    const candidate = extractConvenerFromHtmlValue(value);
    if (candidate) candidates.push(candidate);
  }

  if (candidates.length === 0) return undefined;
  const withProfile = candidates.find((candidate) => Boolean(candidate.profileUrl));
  return withProfile || candidates[0];
}

function tokenizeProgramName(name: string): string[] {
  const cleaned = name
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const stopwords = new Set([
    'and', 'the', 'for', 'with', 'program', 'major', 'minor', 'certificate', 'track', 'concentration',
    'science', 'arts', 'studies', 'graduate', 'undergraduate', 'school', 'master', 'bachelor',
    'degree', 'public', 'policy', 'education',
  ]);

  return Array.from(new Set(
    cleaned
      .split(' ')
      .map((token) => token.trim())
      .filter((token) => token.length >= 4 && !stopwords.has(token))
  ));
}

interface FacultyCandidate {
  value: NonNullable<MajorEntry['faculty']>[number];
  searchableText: string;
}

function loadFacultyCandidatesBySchool(): Map<string, FacultyCandidate[]> {
  const bySchool = new Map<string, FacultyCandidate[]>();
  const seenBySchool = new Map<string, Set<string>>();

  const ingestProfiles = (parsed: unknown) => {
    if (!Array.isArray(parsed)) return;

    for (const item of parsed) {
      if (!item || typeof item !== 'object') continue;
      const profile = item as FacultyProfile;
      const name = (profile.name || '').trim();
      const school = (profile.school || '').trim();
      if (!name || !school) continue;

      const canonicalSchool = normalizeFacultySchool(school);
      const value: NonNullable<MajorEntry['faculty']>[number] = {
        name,
      };
      if (profile.title?.trim()) value.title = profile.title.trim();
      if (profile.email?.trim()) value.email = profile.email.trim();
      if (profile.office?.trim()) value.office = profile.office.trim();
      if (profile.phone?.trim()) value.phone = profile.phone.trim();
      if (profile.profileUrl?.trim()) value.profileUrl = profile.profileUrl.trim();
      if (profile.imageUrl?.trim()) value.imageUrl = profile.imageUrl.trim();

      const searchableText = [
        profile.name,
        profile.title,
        profile.bio,
        ...(profile.courses || []),
        ...(profile.teachingInterests || []),
        ...(profile.researchInterests || []),
        ...(profile.publishedResearch || []),
      ]
        .filter((text): text is string => typeof text === 'string' && text.trim().length > 0)
        .join(' ')
        .toLowerCase();

      if (!bySchool.has(canonicalSchool)) bySchool.set(canonicalSchool, []);
      if (!seenBySchool.has(canonicalSchool)) seenBySchool.set(canonicalSchool, new Set());

      const dedupeKey = normalizeProfileUrl(value.profileUrl) || normalizePersonName(name);
      const schoolSeen = seenBySchool.get(canonicalSchool)!;
      if (!dedupeKey || schoolSeen.has(dedupeKey)) {
        continue;
      }

      // Prefer normalized records; raw is a fallback source for missing faculty metadata.
      schoolSeen.add(dedupeKey);
      bySchool.get(canonicalSchool)!.push({ value, searchableText });
    }
  };

  if (fs.existsSync(FACULTY_JSON)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(FACULTY_JSON, 'utf-8'));
      ingestProfiles(parsed);
    } catch {
      // ignore malformed normalized faculty data and continue with raw fallback
    }
  }

  if (fs.existsSync(FACULTY_RAW_JSON)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(FACULTY_RAW_JSON, 'utf-8'));
      ingestProfiles(parsed);
    } catch {
      // ignore malformed raw faculty data
    }
  }

  return bySchool;
}

function selectFacultyForProgram(
  facultyCandidates: FacultyCandidate[] | undefined,
  programName: string,
  catalogCode: string
): MajorEntry['faculty'] {
  if (!facultyCandidates || facultyCandidates.length === 0) return undefined;

  const nameTokens = tokenizeProgramName(programName);
  const codeToken = (catalogCode.split('-').pop() || '').toLowerCase();

  const ranked = facultyCandidates
    .map((candidate) => {
      let score = 0;
      nameTokens.forEach((token) => {
        if (candidate.searchableText.includes(token)) {
          score += token.length >= 7 ? 2 : 1;
        }
      });
      if (codeToken && codeToken.length >= 4 && candidate.searchableText.includes(codeToken)) {
        score += 2;
      }
      return { candidate: candidate.value, score };
    })
    .sort((a, b) => {
      if (a.score !== b.score) return b.score - a.score;
      return a.candidate.name.localeCompare(b.candidate.name);
    });

  const withMatches = ranked.filter((entry) => entry.score > 0).slice(0, 10).map((entry) => entry.candidate);
  const fallback = ranked.slice(0, 10).map((entry) => entry.candidate);
  const chosen = withMatches.length > 0 ? withMatches : fallback;

  const deduped = new Map<string, NonNullable<MajorEntry['faculty']>[number]>();
  chosen.forEach((candidate) => {
    const key = (candidate.email || candidate.name).toLowerCase();
    if (!deduped.has(key)) deduped.set(key, candidate);
  });
  return Array.from(deduped.values());
}

function buildFacultyLookupByNormalizedName(
  candidates: FacultyCandidate[]
): Map<string, NonNullable<MajorEntry['faculty']>[number]> {
  const lookup = new Map<string, NonNullable<MajorEntry['faculty']>[number]>();
  candidates.forEach((candidate) => {
    const key = normalizePersonName(candidate.value.name);
    if (!key || lookup.has(key)) return;
    lookup.set(key, candidate.value);
  });
  return lookup;
}

function buildFacultyLookupByProfileUrl(
  candidates: FacultyCandidate[]
): Map<string, NonNullable<MajorEntry['faculty']>[number]> {
  const lookup = new Map<string, NonNullable<MajorEntry['faculty']>[number]>();
  candidates.forEach((candidate) => {
    const key = normalizeProfileUrl(candidate.value.profileUrl);
    if (!key || lookup.has(key)) return;
    lookup.set(key, candidate.value);
  });
  return lookup;
}

function resolveAuthoritativeFacultyList(
  links: FacultyLinkEntry[],
  facultyLookupByName: Map<string, NonNullable<MajorEntry['faculty']>[number]>,
  facultyLookupByProfileUrl: Map<string, NonNullable<MajorEntry['faculty']>[number]>
): MajorEntry['faculty'] {
  if (links.length === 0) return undefined;

  const resolved: NonNullable<MajorEntry['faculty']> = [];
  links.forEach((link) => {
    const profileKey = normalizeProfileUrl(link.profileUrl);
    const matchedByProfile = profileKey ? facultyLookupByProfileUrl.get(profileKey) : undefined;
    const key = normalizePersonName(link.name);
    const matchedByName = key ? facultyLookupByName.get(key) : undefined;
    const matched = matchedByProfile || matchedByName;
    if (matched) {
      const merged = { ...matched };
      if (link.profileUrl) {
        merged.profileUrl = merged.profileUrl || link.profileUrl;
      }
      resolved.push(merged);
      return;
    }

    const fallback: NonNullable<MajorEntry['faculty']>[number] = { name: link.name };
    if (link.profileUrl) fallback.profileUrl = link.profileUrl;
    resolved.push(fallback);
  });

  const deduped = new Map<string, NonNullable<MajorEntry['faculty']>[number]>();
  resolved.forEach((candidate) => {
    const key = normalizePersonName(candidate.name);
    if (!key || deduped.has(key)) return;
    deduped.set(key, candidate);
  });

  return Array.from(deduped.values());
}

function resolveConvenerProfile(
  convenerCandidate: FacultyLinkEntry | undefined,
  facultyLookupByName: Map<string, NonNullable<MajorEntry['faculty']>[number]>,
  facultyLookupByProfileUrl: Map<string, NonNullable<MajorEntry['faculty']>[number]>,
  matchedFaculty: MajorEntry['faculty'],
  existingConvener: MajorEntry['convener']
): MajorEntry['convener'] {
  const fallbackFromFaculty = matchedFaculty?.[0];

  if (convenerCandidate) {
    const profileKey = normalizeProfileUrl(convenerCandidate.profileUrl);
    const matchedByProfile = profileKey ? facultyLookupByProfileUrl.get(profileKey) : undefined;
    const key = normalizePersonName(convenerCandidate.name);
    const matchedByName = key ? facultyLookupByName.get(key) : undefined;
    const matched = matchedByProfile || matchedByName;
    if (matched) {
      const merged = { ...matched };
      if (convenerCandidate.profileUrl && !merged.profileUrl) {
        merged.profileUrl = convenerCandidate.profileUrl;
      }
      return merged;
    }

    if (fallbackFromFaculty && normalizePersonName(fallbackFromFaculty.name) === key) {
      return fallbackFromFaculty;
    }

    const fallback: NonNullable<MajorEntry['faculty']>[number] = { name: convenerCandidate.name };
    if (convenerCandidate.profileUrl) fallback.profileUrl = convenerCandidate.profileUrl;
    return fallback;
  }

  return existingConvener || fallbackFromFaculty;
}

function loadExistingProgramsData(): ProgramsData | null {
  if (!fs.existsSync(PROGRAMS_JSON)) return null;
  try {
    return JSON.parse(fs.readFileSync(PROGRAMS_JSON, 'utf-8')) as ProgramsData;
  } catch {
    return null;
  }
}

function buildExistingMetadataMaps(existing: ProgramsData | null): {
  byCode: Map<string, ExistingProgramMetadata>;
  byName: Map<string, ExistingProgramMetadata>;
} {
  const byCode = new Map<string, ExistingProgramMetadata>();
  const byName = new Map<string, ExistingProgramMetadata>();
  if (!existing?.schools?.length) {
    return { byCode, byName };
  }

  existing.schools.forEach((school) => {
    school.majors.forEach((major) => {
      const metadata: ExistingProgramMetadata = {
        name: major.name,
        degree: major.degree,
        type: major.type,
        url: major.url,
        description: major.description,
        whatYoullLearn: major.whatYoullLearn,
        sampleCourses: major.sampleCourses,
        careers: major.careers,
        catalogCode: major.catalogCode,
        catalogUrl: major.catalogUrl,
        totalCredits: major.totalCredits,
        requirements: major.requirements,
        concentrations: major.concentrations,
        learningOutcomes: major.learningOutcomes,
        faculty: major.faculty,
        convener: major.convener,
      };

      const code = (major.catalogCode || '').trim().toUpperCase();
      if (code && !byCode.has(code)) {
        byCode.set(code, metadata);
      }

      const normalizedName = normName(major.name || '');
      if (normalizedName && !byName.has(normalizedName)) {
        byName.set(normalizedName, metadata);
      }
    });
  });

  return { byCode, byName };
}

function getEntryQualityScore(entry: MajorEntry): number {
  return (
    ((entry.requirements?.length || 0) * 1000) +
    ((entry.learningOutcomes?.length || 0) * 100) +
    ((entry.concentrations?.length || 0) * 20) +
    ((entry.totalCredits ? 1 : 0) * 10) +
    ((entry.convener ? 1 : 0) * 8) +
    (entry.faculty?.length || 0)
  );
}

export function matchMajor(prog: CoursedogProgram, allMajors: MajorEntry[]): MajorEntry | null {
  const pNameOrig = (prog.name || prog.longName || '').toLowerCase();
  const isMinor = pNameOrig.includes('minor') || (prog.code || '').includes('-MN-');
  const isCert = pNameOrig.includes('certificate');
  const pCode = (prog.code || '').toLowerCase();
  const isFourPlusOneProgram = isFourPlusOneText(`${prog.name || ''} ${prog.longName || ''} ${prog.code || ''}`);
  const inferredType = inferProgramType(prog);

  // We only want to map Bachelor's or Master's programs to our MajorEntry list.
  // We also explicitly ignore PMCS (Pre-Med Computer Science) to ensure true CMPS binds to 'Computer Science'.
  if (isMinor || isCert || pCode.includes('pmcs') || pNameOrig.includes('pre-med')) return null;

  const pName = normName(pNameOrig);
  const hardcodedMajorNameMap: Record<string, string> = {
    // Programs whose majors include acronym-heavy names that normalize poorly.
    'bg-mba-mbad': 'Master of Business Administration (MBA)',
    'gh-mpp-pbpl': 'Master of Public Policy',
    'ts-bs-clls': 'Clinical Lab Science (CLS)',
    'ts-bsn-nura': 'Nursing (Accelerated Program)',
    'cg-mfa-crmt': 'Music and Creative Music Technology (4+1 BA/MFA)',
  };
  const hardcodedMap: Record<string, string> = {
    'info-tech': 'information technology',
    'bio-chem': 'biochemistry',
    'bioinfo': 'bioinformatics',
    'ts-bs-cmps': 'computer science',
  };

  const explicitByMajorName = hardcodedMajorNameMap[pCode]
    ? allMajors.filter((m) => m.name === hardcodedMajorNameMap[pCode])
    : [];

  const subjCode = pCode.split('-').pop()?.toLowerCase();
  const matchedByName = allMajors.filter((m) => {
    const mNorm = normName(m.name);
    if (mNorm === pName) return true;
    if (pName && mNorm && (pName.includes(mNorm) || mNorm.includes(pName))) {
      if (pName === 'science' || mNorm === 'science') return false;
      return true;
    }
    return false;
  });
  const matchedByCode = allMajors.filter((m) => {
    if (!subjCode) return false;
    return m.name.toLowerCase().replace(/\s/g, '').startsWith(subjCode);
  });
  const explicitMapped = hardcodedMap[pCode]
    ? allMajors.filter((m) => normName(m.name) === hardcodedMap[pCode])
    : [];

  const candidateMap = new Map<string, MajorEntry>();
  [...explicitByMajorName, ...explicitMapped, ...matchedByName, ...matchedByCode].forEach((m) => {
    candidateMap.set(`${m.name}|${m.degree}|${m.type}`, m);
  });
  let candidates = Array.from(candidateMap.values());
  if (candidates.length === 0) return null;

  // 4+1 programs should only map to explicit 4+1 majors.
  if (isFourPlusOneProgram) {
    const variantMatches = candidates.filter((m) => isFourPlusOneMajorName(m.name));
    if (variantMatches.length === 0) return null;
    candidates = variantMatches;
  } else {
    const nonVariantMatches = candidates.filter((m) => !isFourPlusOneMajorName(m.name));
    if (nonVariantMatches.length > 0) {
      candidates = nonVariantMatches;
    }
  }

  if (inferredType) {
    const sameType = candidates.filter((m) => m.type === inferredType);
    if (sameType.length > 0) {
      candidates = sameType;
    }
  }

  candidates.sort((a, b) => {
    const aNorm = normName(a.name);
    const bNorm = normName(b.name);
    const aExact = aNorm === pName ? 1 : 0;
    const bExact = bNorm === pName ? 1 : 0;
    if (aExact !== bExact) return bExact - aExact;

    const aContains = pName.includes(aNorm) || aNorm.includes(pName) ? 1 : 0;
    const bContains = pName.includes(bNorm) || bNorm.includes(pName) ? 1 : 0;
    if (aContains !== bContains) return bContains - aContains;

    // Prefer non-parenthetical base names when both match equally.
    const aParen = a.name.includes('(') ? 1 : 0;
    const bParen = b.name.includes('(') ? 1 : 0;
    if (aParen !== bParen) {
      return aParen - bParen;
    }

    return a.name.localeCompare(b.name);
  });

  return candidates[0] ?? null;
}

// ─── Main ─────────────────────────────────────────────────────────────────

async function main() {
  // 1. Search for all programs via POST
  console.log('Step 1: Fetching all programs from Coursedog API...');

  let allPrograms: CoursedogProgram[] = [];
  try {
    // Try the search endpoint
    const searchBody = {
      skip: 0,
      limit: 500,
      formatDependencies: true,
      columns: ['name', 'code', 'longName', 'college', 'degreeDesignation', 'status',
                'catalogFullDescription', 'catalogDescription', 'totalCredits',
                'requisites', 'learningOutcomes', 'concentrations', 'customFields'],
    };
    const searchRes = await apiPost('/programs/search/%24filters', searchBody) as {
      data?: CoursedogProgram[];
      programs?: CoursedogProgram[];
      results?: CoursedogProgram[];
      [k: string]: unknown;
    };
    allPrograms = searchRes.data ?? searchRes.programs ?? searchRes.results ?? [];
    if (Array.isArray(searchRes)) allPrograms = searchRes as CoursedogProgram[];
  } catch (e) {
    console.error('  Failed to fetch programs:', (e as Error).message);
    try {
      const listRes = await apiGet('/programs?limit=500&formatDependencies=true') as any;
      allPrograms = listRes.data ?? (Array.isArray(listRes) ? listRes : []);
    } catch {}
  }

  console.log(`  Found ${allPrograms.length} programs`);

  if (allPrograms.length === 0) {
    // Try fetching individual known codes as a fallback
    console.log('  Falling back to known catalog URL pattern scraping...');
    // We'll handle this below
  }

  assertCollectionCount({
    dataset: 'Coursedog catalog programs',
    count: allPrograms.length,
    minimum: 50,
    previousFilePath: RAW_OUT,
    minimumPreviousRatio: 0.8,
  });
  const courseMap = new Map<string, string>();
  let catalogCourses: any[] = [];

  // 1.5 Fetch the full course dataset once. This single response powers
  // requirement name mapping, Gen Ed lists, the UI artifact, RAG context, and
  // the immutable raw audit bundle.
  console.log('\nStep 1.5: Fetching complete course data...');
  const genEdLists: Record<string, Array<{code: string; name: string}>> = {
    'Studies in the Arts and Humanities': [],
    'Social Science Inquiry': [],
    'Historical Perspectives': [],
    'Global Awareness': [],
    'Values and Ethics': [],
    'Culture & Creativity': [],
    'Systems, Sustainability & Society': [],
    'Scientific Reasoning': [],
    'Quantitative Reasoning': [],
    'First-Year Seminar (FYS)': []
  };

  try {
    const ethosSearchBody = { 
      skip: 0, 
      limit: 10000, 
      columns: ['code', 'name', 'longName', 'status', 'attributes', 'description', 'credits']
    };
    const ethosRes = await fetchWithPolicy(
      'https://app.coursedog.com/api/v1/cm/ramapo_banner_ethos/courses/search/%24filters',
      {
        method: 'POST',
        headers: { ...HEADERS, 'content-type': 'application/json' },
        body: JSON.stringify(ethosSearchBody),
      },
      {
        expectedContentTypes: ['application/json'],
        retryNonIdempotent: true,
        maxResponseBytes: 64 * 1024 * 1024,
      }
    );
    if (!ethosRes.ok) {
      throw new Error(`Course API returned ${ethosRes.status} ${ethosRes.statusText}.`);
    }
    const ethosData = ethosRes.json<any>();
    const coursePayload = ethosData.data || ethosData.results || [];
    catalogCourses = Array.isArray(coursePayload)
      ? coursePayload.filter(
          (course: any) =>
            course &&
            typeof course.code === 'string' &&
            course.code.trim() &&
            (!course.status || String(course.status).toLowerCase() === 'active')
        )
      : [];
    assertCollectionCount({
      dataset: 'Coursedog catalog courses',
      count: catalogCourses.length,
      minimum: 1_000,
    });
    catalogCourses.forEach((course: any) => {
      if (course.code) {
        courseMap.set(
          String(course.code).replace(/\s+/g, ''),
          course.longName || course.name || ''
        );
      }
    });
    console.log(`  Mapped ${courseMap.size} courses`);

    catalogCourses.forEach((c: any) => {
        if (c.attributes && Array.isArray(c.attributes)) {
          const attrs = c.attributes.map((a: any) => typeof a === 'string' ? a.toLowerCase() : '');
          const courseObj = { 
            code: formatCode(c.code.replace(/\s+/g, '')), 
            name: (c.longName || c.name || '').trim()
          };

          if (attrs.some((a: string) => a.includes('(gega)'))) genEdLists['Global Awareness'].push(courseObj);
          if (attrs.some((a: string) => a.includes('(gehp)'))) genEdLists['Historical Perspectives'].push(courseObj);
          if (attrs.some((a: string) => a.includes('(gcso)') || a.includes('(gtss)') || a.includes('social inquiry') || a.includes('social science inquiry'))) {
            genEdLists['Social Science Inquiry'].push(courseObj);
          }
          if (attrs.some((a: string) => a.includes('(grhu)') || a.includes('arts & human'))) {
            genEdLists['Studies in the Arts and Humanities'].push(courseObj);
          }
          if (attrs.some((a: string) => a.includes('(geve)') || a.includes('values and ethics'))) genEdLists['Values and Ethics'].push(courseObj);
          if (attrs.some((a: string) => a.includes('(gecc)') || a.includes('culture & creativity'))) genEdLists['Culture & Creativity'].push(courseObj);
          if (attrs.some((a: string) => a.includes('(gess)') || a.includes('sustainability'))) genEdLists['Systems, Sustainability & Society'].push(courseObj);
          if (attrs.some((a: string) => a.includes('(gesr)') || a.includes('scientific reasoning'))) genEdLists['Scientific Reasoning'].push(courseObj);
          if (attrs.some((a: string) => a.includes('(geqr)') || a.includes('quantitative reasoning') || a.includes('quantitative rsng'))) {
            genEdLists['Quantitative Reasoning'].push(courseObj);
          }
        }
        
        // Match FYS by subject or name if attribute is missing
        if (c.code.startsWith('FYS') || c.code.startsWith('INTD101')) {
           const courseObj = { code: formatCode(c.code.replace(/\s+/g, '')), name: (c.longName || c.name || '').trim() };
           genEdLists['First-Year Seminar (FYS)'].push(courseObj);
        }
    });
    console.log(`  Populated Gen Ed lists:`);
    Object.entries(genEdLists).forEach(([k, v]) => console.log(`    ${k}: ${v.length} courses`));

    console.log('\nStep 1.6: Saving detailed course dictionary for the UI...');
    const fullCourseDetails: Record<string, any> = {};
    catalogCourses.forEach((c: any) => {
      const fmtCode = formatCode(c.code.replace(/\s+/g, ''));
      fullCourseDetails[fmtCode] = {
        code: fmtCode,
        name: (c.longName || c.name || '').trim(),
        description: stripHtml(c.description || '').trim(),
        credits: c.credits?.creditHours?.min || c.credits?.creditHours || '',
        attributes: c.attributes || []
      };
    });
    writeJsonFile(COURSES_JSON, fullCourseDetails);
    console.log(`  Saved ${Object.keys(fullCourseDetails).length} course details to ${COURSES_JSON}`);

    for (const req of GEN_ED_REQUIREMENTS || []) {
      const sectionKey = req.section.replace('General Education: ', '').trim();
      for (const [key, list] of Object.entries(genEdLists)) {
        if (sectionKey === key) {
          req.courses = [...(req.courses || []), ...list];
        } else if (key === 'Culture & Creativity' || key === 'Values and Ethics' || key === 'Systems, Sustainability & Society') {
          if (sectionKey === 'Distribution Categories') {
            req.courses = [...(req.courses || []), ...list];
          }
        }
      }

      if (req.courses) {
        const seen = new Set();
        req.courses = req.courses.filter(c => {
          if (seen.has(c.code)) return false;
          seen.add(c.code);
          return true;
        });
        req.courses.sort((a, b) => a.code.localeCompare(b.code));
      }
    }
  } catch (e) {
    throw new Error(`Course collection failed: ${(e as Error).message}`);
  }

  const rawCatalogPayload = {
    scrapedAt: new Date().toISOString(),
    count: allPrograms.length + catalogCourses.length,
    programCount: allPrograms.length,
    courseCount: catalogCourses.length,
    programs: allPrograms,
    courses: catalogCourses,
  };
  writeJsonFile(RAW_OUT, rawCatalogPayload);
  console.log(`  Saved combined program + course raw data to ${RAW_OUT}`);

  // 2. Build comprehensive programs.json (majors + minors + certificates + other catalog programs)
  console.log('\nStep 2: Building comprehensive programs.json...');
  const includeInactive = parseBooleanEnv(process.env.PROGRAMS_INCLUDE_INACTIVE, false);
  const existingPrograms = loadExistingProgramsData();
  const existingMetadata = buildExistingMetadataMaps(existingPrograms);
  const facultyBySchool = loadFacultyCandidatesBySchool();
  const allFacultyCandidates = Array.from(facultyBySchool.values()).flat();
  const facultyLookupByName = buildFacultyLookupByNormalizedName(allFacultyCandidates);
  const facultyLookupByProfileUrl = buildFacultyLookupByProfileUrl(allFacultyCandidates);

  const programsByKey = new Map<
    string,
    { school: string; shortName: string; entry: MajorEntry }
  >();
  const kindCounts: Record<NonNullable<MajorEntry['programKind']>, number> = {
    major: 0,
    special: 0,
    minor: 0,
    certificate: 0,
    undeclared: 0,
    other: 0,
  };

  let activeCount = 0;
  let inactiveCount = 0;

  for (const prog of allPrograms) {
    const statusNormalized = String(prog.status || '').trim().toLowerCase() || 'unknown';
    if (statusNormalized === 'active') {
      activeCount++;
    } else {
      inactiveCount++;
      if (!includeInactive) continue;
    }

    const catalogCode = (prog.code || prog.id || '').trim();
    if (!catalogCode) continue;

    const inferredType = inferProgramType(prog) || (inferProgramKind(prog) === 'certificate' ? 'graduate' : 'undergraduate');
    const programKind = inferProgramKind(prog);
    const schoolInfo = normalizeCatalogSchool(prog.college);
    const displayName = getProgramDisplayName(prog);
    const catalogUrl = `https://catalog.ramapo.edu/programs/${catalogCode}`;

    const existing =
      existingMetadata.byCode.get(catalogCode.toUpperCase()) ||
      existingMetadata.byName.get(normName(displayName));

    const extractedReqs = extractRequirements(prog, courseMap) || [];
    const freeformReqs = extractedReqs.length === 0 ? (extractFreeformRequirements(prog) || []) : [];
    const generatedReqsBase = [...extractedReqs, ...freeformReqs];
    const includeGenEd =
      inferredType === 'undergraduate' && (programKind === 'major' || programKind === 'special');
    const generatedReqs = includeGenEd ? [...cloneGenEdRequirements(), ...generatedReqsBase] : generatedReqsBase;
    const cleanedGeneratedReqs = generatedReqs.length > 0 ? cleanRequirementCourses(generatedReqs) : undefined;
    const finalReqs = cleanedGeneratedReqs || existing?.requirements;

    const description = existing?.description || cleanDescription(
      prog.catalogFullDescription || prog.catalogDescription || prog.descriptionHtml || ''
    );
    const learningOutcomes = dedupeStrings([
      ...(prog.learningOutcomes?.map((outcome) => outcome.outcome || outcome.description || '') || []),
      ...(existing?.learningOutcomes || []),
    ]);
    const concentrations = dedupeStrings([
      ...(prog.concentrations?.map((concentration) => concentration.name || '') || []),
      ...(existing?.concentrations || []),
    ]);

    const facultyPool = schoolInfo.facultySchool ? facultyBySchool.get(schoolInfo.facultySchool) : undefined;
    const facultyLinksFromCustomFields = extractFacultyLinksFromCustomFields(prog.customFields);
    const authoritativeFaculty = resolveAuthoritativeFacultyList(
      facultyLinksFromCustomFields,
      facultyLookupByName,
      facultyLookupByProfileUrl
    );
    const matchedFaculty =
      authoritativeFaculty ||
      selectFacultyForProgram(facultyPool, displayName, catalogCode) ||
      selectFacultyForProgram(allFacultyCandidates, displayName, catalogCode) ||
      existing?.faculty;
    const resolvedConvener = resolveConvenerProfile(
      extractConvenerFromCustomFields(prog.customFields),
      facultyLookupByName,
      facultyLookupByProfileUrl,
      matchedFaculty,
      existing?.convener
    );

    const entry: MajorEntry = {
      name: displayName,
      degree: inferDegreeLabel(prog, inferredType),
      type: inferredType,
      url: existing?.url || catalogUrl,
      programKind,
      status: statusNormalized,
      school: schoolInfo.school,
      catalogCode,
      catalogUrl,
    };

    if (description) entry.description = description;
    if (existing?.whatYoullLearn) entry.whatYoullLearn = existing.whatYoullLearn;
    if (existing?.sampleCourses?.length) entry.sampleCourses = existing.sampleCourses;
    if (existing?.careers) entry.careers = existing.careers;
    if (prog.totalCredits || existing?.totalCredits) entry.totalCredits = String(prog.totalCredits || existing?.totalCredits);
    if (finalReqs && finalReqs.length > 0) entry.requirements = finalReqs;
    if (concentrations.length > 0) entry.concentrations = concentrations;
    if (learningOutcomes.length > 0) entry.learningOutcomes = learningOutcomes;
    if (matchedFaculty && matchedFaculty.length > 0) entry.faculty = matchedFaculty;
    if (resolvedConvener) entry.convener = resolvedConvener;

    const uniqueKey = catalogCode.toUpperCase();
    const existingForKey = programsByKey.get(uniqueKey);
    if (!existingForKey || getEntryQualityScore(entry) > getEntryQualityScore(existingForKey.entry)) {
      programsByKey.set(uniqueKey, {
        school: schoolInfo.school,
        shortName: schoolInfo.shortName,
        entry,
      });
    }
  }

  const schoolMap = new Map<string, SchoolGroup>();
  for (const { school, shortName, entry } of programsByKey.values()) {
    if (!schoolMap.has(school)) {
      schoolMap.set(school, { school, shortName, majors: [] });
    }
    schoolMap.get(school)!.majors.push(entry);
  }

  const kindOrder: Record<NonNullable<MajorEntry['programKind']>, number> = {
    major: 0,
    special: 1,
    minor: 2,
    certificate: 3,
    undeclared: 4,
    other: 5,
  };
  const schools = Array.from(schoolMap.values())
    .sort((a, b) => a.school.localeCompare(b.school))
    .map((school) => ({
      ...school,
      majors: school.majors.sort((a, b) => {
        const kindDelta =
          (kindOrder[a.programKind || 'other'] ?? 99) - (kindOrder[b.programKind || 'other'] ?? 99);
        if (kindDelta !== 0) return kindDelta;
        return a.name.localeCompare(b.name);
      }),
    }));

  const totalPrograms = schools.reduce((sum, school) => sum + school.majors.length, 0);
  schools.forEach((school) => {
    school.majors.forEach((entry) => {
      kindCounts[entry.programKind || 'other'] += 1;
    });
  });
  const withReqs = schools.reduce(
    (sum, school) => sum + school.majors.filter((entry) => (entry.requirements?.length || 0) > 0).length,
    0
  );
  const withFaculty = schools.reduce(
    (sum, school) => sum + school.majors.filter((entry) => (entry.faculty?.length || 0) > 0).length,
    0
  );
  const withCatalogUrl = schools.reduce(
    (sum, school) => sum + school.majors.filter((entry) => Boolean(entry.catalogUrl)).length,
    0
  );
  const programsJson: ProgramsData = {
    generatedAt: new Date().toISOString(),
    totalSchools: schools.length,
    totalMajors: totalPrograms,
    totalPrograms,
    schools,
    source: 'https://app.coursedog.com/api/v1/cm/ramapo_banner_ethos + https://www.ramapo.edu/faculty/',
  };

  const validatedProgramsJson = validateProgramsData(programsJson);
  writeJsonFile(PROGRAMS_JSON, validatedProgramsJson);
  writeJsonFile(NORMALIZED_PROGRAMS_JSON, validatedProgramsJson);
  // Structured program rows are published from this artifact, not from the
  // separate catalog-page crawl. Give the source gate provenance for both
  // inputs so an old programs.json cannot ride on a fresh page crawl.
  writeRawFileProvenance('catalog-programs', RAW_OUT, {
    sourceUrl: `${API_BASE}/programs/search/%24filters`,
    recordCount: allPrograms.length + catalogCourses.length,
  });

  console.log(`\n✓ Done!`);
  console.log(`  Programs from API:          ${allPrograms.length}`);
  console.log(`  Included programs:          ${totalPrograms} (${includeInactive ? 'active + inactive' : 'active only'})`);
  console.log(`  Active / inactive fetched:  ${activeCount} / ${inactiveCount}`);
  console.log(`  Program kinds:              major=${kindCounts.major}, special=${kindCounts.special}, minor=${kindCounts.minor}, certificate=${kindCounts.certificate}, undeclared=${kindCounts.undeclared}, other=${kindCounts.other}`);
  console.log(`  Programs with requirements: ${withReqs}`);
  console.log(`  Programs with faculty:      ${withFaculty}`);
  console.log(`  Programs with catalog URL:  ${withCatalogUrl}`);
  console.log(`  Wrote:                      ${PROGRAMS_JSON}`);
  console.log(`  Wrote:                      ${NORMALIZED_PROGRAMS_JSON}`);
}

if (process.argv[1]?.endsWith('scrape-catalog-api.ts')) {
  main().catch(e => { console.error('Fatal:', e); process.exit(1); });
}
