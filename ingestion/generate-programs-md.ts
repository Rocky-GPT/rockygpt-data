import fs from 'node:fs';
import path from 'node:path';
import { buildFrontmatter } from './frontmatter';
import { getGeneratedTimestamp } from './pipeline-utils';
import { publicPath } from '../src/paths';

const PUBLIC_DATA_DIR = publicPath('data');
const OUTPUT_FILE = path.join(process.cwd(), 'data', 'context', 'academic', 'programs.md');

interface CourseDetail {
  code?: string;
  name?: string;
  description?: string;
  credits?: unknown;
  attributes?: unknown[];
}

interface ProgramRequirement {
  section?: string;
  note?: string;
  courses?: Array<{ code?: string; name?: string }>;
}

interface ProgramDetail {
  name?: string;
  degree?: string;
  type?: string;
  status?: string;
  description?: string;
  url?: string;
  catalogUrl?: string;
  requirements?: ProgramRequirement[];
  faculty?: Array<{ name?: string; title?: string; email?: string }>;
}

interface ProgramsData {
  schools?: Array<{ school?: string; majors?: ProgramDetail[] }>;
}

function readJson<T>(fileName: string): T {
  return JSON.parse(fs.readFileSync(path.join(PUBLIC_DATA_DIR, fileName), 'utf8')) as T;
}

function clean(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

function excerpt(value: unknown, maxLength: number): string {
  const text = clean(value);
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1).trimEnd()}…`;
}

function courseSubject(code: string): string {
  return code.match(/^[A-Z]+/)?.[0] || 'Other';
}

export function formatCourseCredits(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return `${value} ${value === 1 ? 'credit' : 'credits'}`;
  }

  if (typeof value === 'string') {
    const credits = clean(value);
    if (!credits) return '';
    return /\bcredits?\b/i.test(credits) ? credits : `${credits} credits`;
  }

  if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
  const record = value as Record<string, unknown>;
  const min = typeof record.min === 'number' && Number.isFinite(record.min) ? record.min : null;
  const max = typeof record.max === 'number' && Number.isFinite(record.max) ? record.max : null;
  if (min === null && max === null) return '';

  if (min !== null && max !== null) {
    if (min === max) return `${min} ${min === 1 ? 'credit' : 'credits'}`;
    return `${min}\u2013${max} credits`;
  }

  const credits = min ?? max;
  return `${credits} ${credits === 1 ? 'credit' : 'credits'}`;
}

function renderProgram(program: ProgramDetail): string {
  const name = clean(program.name);
  if (!name) return '';

  let md = `### ${name}\n\n`;
  const metadata = [clean(program.degree), clean(program.type)].filter(Boolean).join(' · ');
  if (metadata) md += `**${metadata}**\n\n`;
  if (program.description) md += `${excerpt(program.description, 700)}\n\n`;

  const sourceUrl = clean(program.url) || clean(program.catalogUrl);
  if (sourceUrl) md += `- [Official program page](${sourceUrl})\n`;
  if (program.status) md += `- Status: ${clean(program.status)}\n`;
  if (sourceUrl || program.status) md += '\n';

  for (const requirement of program.requirements || []) {
    const section = clean(requirement.section);
    const courses = (requirement.courses || [])
      .map((course) => {
        const code = clean(course.code);
        const courseName = clean(course.name);
        return code ? `${code}${courseName ? ` — ${courseName}` : ''}` : '';
      })
      .filter(Boolean);
    if (!section && !courses.length && !requirement.note) continue;
    md += `#### ${section || 'Program requirement'}\n\n`;
    for (const course of courses.slice(0, 20)) md += `- ${course}\n`;
    if (courses.length > 20) md += `- …and ${courses.length - 20} additional approved courses\n`;
    if (courses.length) md += '\n';
    if (requirement.note) md += `${excerpt(requirement.note, 320)}\n\n`;
  }

  const faculty = (program.faculty || [])
    .map((entry) => {
      const nameValue = clean(entry.name);
      if (!nameValue) return '';
      const details = [clean(entry.title), clean(entry.email)].filter(Boolean).join(' · ');
      return `${nameValue}${details ? ` — ${details}` : ''}`;
    })
    .filter(Boolean);
  if (faculty.length) {
    md += '#### Faculty contacts\n\n';
    for (const entry of faculty) md += `- ${entry}\n`;
    md += '\n';
  }
  return md;
}

function main(): void {
  const programs = readJson<ProgramsData>('programs.json');
  const courses = readJson<Record<string, CourseDetail>>('courses.json');
  const schools = (programs.schools || [])
    .filter((school) => clean(school.school))
    .sort((a, b) => clean(a.school).localeCompare(clean(b.school)));
  const courseEntries = Object.values(courses)
    .map((course) => ({
      code: clean(course.code),
      name: clean(course.name),
      description: excerpt(course.description, 240),
      credits: course.credits,
    }))
    .filter((course) => course.code && course.name)
    .sort((a, b) => a.code.localeCompare(b.code));

  if (!schools.length) throw new Error('programs.json contains no academic schools.');
  if (courseEntries.length < 1_800) {
    throw new Error(`courses.json contains only ${courseEntries.length} courses; expected at least 1800.`);
  }

  let md = buildFrontmatter({
    source_url: 'https://app.coursedog.com/api/v1/cm/ramapo_banner_ethos',
    title: 'Academic Programs and Courses',
    trust_tier: 'official_primary',
    freshness_sla_hours: 4_320,
  });
  md += '# Ramapo College Academic Programs and Courses\n\n';
  md += `*Generated (UTC): ${getGeneratedTimestamp()}*\n\n`;
  md +=
    'This document is generated from Ramapo College’s official Coursedog catalog API and covers programs, requirements, faculty contacts, and course descriptions.\n\n';

  for (const school of schools) {
    md += `## ${clean(school.school)}\n\n`;
    const schoolPrograms = (school.majors || [])
      .filter((program) => clean(program.name))
      .sort((a, b) => clean(a.name).localeCompare(clean(b.name)));
    for (const program of schoolPrograms) md += renderProgram(program);
  }

  md += '## Course Catalog\n\n';
  let currentSubject = '';
  for (const course of courseEntries) {
    const subject = courseSubject(course.code);
    if (subject !== currentSubject) {
      currentSubject = subject;
      md += `### ${subject}\n\n`;
    }
    md += `#### ${course.code}: ${course.name}\n\n`;
    if (course.description) md += `${course.description}\n\n`;
    const credits = formatCourseCredits(course.credits);
    if (credits) md += `Credits: ${credits}\n\n`;
    md += `- [Official catalog page](https://catalog.ramapo.edu/courses/${course.code})\n\n`;
  }

  fs.mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true });
  fs.writeFileSync(OUTPUT_FILE, `${md.trimEnd()}\n`, 'utf8');
  console.log(
    `Generated programs context with ${schools.length} schools and ${courseEntries.length} courses at ${OUTPUT_FILE}`
  );
}

if (process.argv[1]?.endsWith('generate-programs-md.ts')) {
  main();
}
