/**
 * generate-programs-public-json.ts
 * Reads programs.raw.json, parses all successfully scraped course pages,
 * and outputs public/data/programs.json for the MajorsModal frontend.
 */
import fs from 'fs';
import path from 'path';
import type { RawPageV1 } from './raw-types';
import { validateRawDatasetV1 } from './raw-types';
import { publicPath } from '../src/paths';

const RAW_FILE = path.join(process.cwd(), 'data', 'raw', 'programs.raw.json');
const OUTPUT_FILE = publicPath('data', 'programs.json');

// ---------- types ----------

export interface CourseEntry {
  code: string;
  name: string;
  description: string;
  url: string;
  credits?: string;
}

export interface SubjectGroup {
  subjectLabel: string; // e.g. "Accounting (ACCT)"
  subjectCode: string;  // e.g. "ACCT"
  courses: CourseEntry[];
}

export interface SchoolGroup {
  school: string;
  subjects: SubjectGroup[];
}

export interface ProgramsPublicData {
  generatedAt: string;
  totalSchools: number;
  totalSubjects: number;
  totalCourses: number;
  schools: SchoolGroup[];
}

// ---------- helpers ----------

const SCHOOL_ALIASES: Record<string, string> = {
  'Contemporary Arts': 'School of Contemporary Arts',
  'Graduate Business': 'Graduate School of Business',
  'Anisfield School of Business': 'Anisfield School of Business',
  'Humanities and Global Studies': 'School of Humanities and Global Studies',
  'Theoretical & Applied Science': 'School of Theoretical and Applied Science',
  'Social Science and Human Services': 'School of Social Science and Human Services',
};

function canonicalSchool(raw: string): string {
  return SCHOOL_ALIASES[raw.trim()] ?? raw.trim();
}

function normalizeText(value: string | null | undefined): string {
  if (!value) return '';
  return value.replace(/[\u2018\u2019]/g, "'").replace(/[\u2013\u2014]/g, '-').replace(/\s+/g, ' ').trim();
}

function parseCourse(page: RawPageV1): { course: CourseEntry; subject: string; subjectCode: string; school: string } | null {
  if (!page.url.includes('/courses/')) return null;
  const codeMatch = page.url.match(/\/courses\/([A-Z0-9]+)/i);
  if (!codeMatch) return null;
  const code = codeMatch[1].toUpperCase();

  const metaSection = page.sections?.[0];
  if (!metaSection) return null;

  const metaText = normalizeText(metaSection.text);
  const metaMatch = metaText.match(/^(.+?)\s+\((\w+)\)\s+(.+?)\s+General Credits/);
  if (!metaMatch) return null;

  const subject = `${metaMatch[1].trim()} (${metaMatch[2].trim()})`;
  const subjectCode = metaMatch[2].trim();
  const school = canonicalSchool(metaMatch[3].trim());
  const courseName = normalizeText(metaSection.heading);

  const descSection = page.sections?.find(
    s => s.heading?.toLowerCase().includes('description')
  );
  const description = normalizeText(descSection?.text) || '';

  // Try to extract credits from text like "3 Credits" or "1-4 Credits"
  const creditsMatch = metaText.match(/(\d[\d.-]*)\s+Credits?/i);
  const credits = creditsMatch ? `${creditsMatch[1]} credit${parseFloat(creditsMatch[1]) !== 1 ? 's' : ''}` : undefined;

  return {
    course: { code, name: courseName, description, url: page.url, credits },
    subject,
    subjectCode,
    school,
  };
}

// ---------- main ----------

if (!fs.existsSync(RAW_FILE)) {
  console.error(`Raw programs file not found: ${RAW_FILE}`);
  process.exit(1);
}

const rawData = JSON.parse(fs.readFileSync(RAW_FILE, 'utf-8'));
const dataset = validateRawDatasetV1(rawData);

// Parse courses grouped by school → subject
const schoolMap = new Map<string, Map<string, { subjectCode: string; courses: Map<string, CourseEntry> }>>();

for (const page of dataset.pages) {
  if (!page.statusCode || page.statusCode < 200 || page.statusCode >= 400) continue;
  if (!page.sections?.length) continue;
  const result = parseCourse(page);
  if (!result) continue;

  const { course, subject, subjectCode, school } = result;
  if (!schoolMap.has(school)) schoolMap.set(school, new Map());
  const subjectMap = schoolMap.get(school)!;
  if (!subjectMap.has(subject)) subjectMap.set(subject, { subjectCode, courses: new Map() });
  const subjectData = subjectMap.get(subject)!;
  if (!subjectData.courses.has(course.code)) {
    subjectData.courses.set(course.code, course);
  }
}

// Build sorted output
const schools: SchoolGroup[] = [...schoolMap.entries()]
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([school, subjectMap]) => ({
    school,
    subjects: [...subjectMap.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([subjectLabel, { subjectCode, courses }]) => ({
        subjectLabel,
        subjectCode,
        courses: [...courses.values()].sort((a, b) => a.code.localeCompare(b.code)),
      })),
  }));

const totalSubjects = schools.reduce((n, s) => n + s.subjects.length, 0);
const totalCourses = schools.reduce((n, s) => s.subjects.reduce((m, sub) => m + sub.courses.length, n), 0);

const output: ProgramsPublicData = {
  generatedAt: new Date().toISOString(),
  totalSchools: schools.length,
  totalSubjects,
  totalCourses,
  schools,
};

fs.mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true });
fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2), 'utf-8');
console.log(`✅ Generated ${OUTPUT_FILE}`);
console.log(`   ${schools.length} schools, ${totalSubjects} subjects, ${totalCourses} courses`);
