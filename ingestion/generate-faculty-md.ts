import fs from 'fs';
import path from 'path';
import { buildFrontmatter } from './frontmatter';
import { getGeneratedTimestamp, sortByName } from './pipeline-utils';
import { type FacultyProfile, validateFacultyProfiles } from './schema';

interface ContextFacultyProfile {
  name: string;
  title: string;
  school: string;
  office?: string;
  email?: string;
  phone?: string;
  courses: string[];
  education: string[];
  teachingInterests: string[];
  researchInterests: string[];
  publishedResearch: string[];
  bio?: string;
  profileUrl?: string;
}

const DATA_DIR = path.join(process.cwd(), 'data', 'normalized');
const OUTPUT_DIR = path.join(process.cwd(), 'data', 'context', 'academic');
const JSON_INPUT_PATH = path.join(DATA_DIR, 'faculty.json');
const MARKDOWN_OUTPUT_PATH = path.join(OUTPUT_DIR, 'faculty.md');

function normalizeText(value?: string): string | undefined {
  if (!value) return undefined;
  const trimmed = value.replace(/\s+/g, ' ').trim();
  return trimmed || undefined;
}

function normalizeList(values: string[] | undefined): string[] {
  if (!Array.isArray(values)) return [];
  const deduped = Array.from(
    new Set(
      values
        .map((value) => normalizeText(value))
        .filter((value): value is string => Boolean(value))
    )
  );
  return deduped;
}

function toContextProfiles(profiles: FacultyProfile[]): ContextFacultyProfile[] {
  return sortByName(
    profiles
      .map((profile): ContextFacultyProfile | null => {
        const name = normalizeText(profile.name);
        const title = normalizeText(profile.title);
        const school = normalizeText(profile.school);
        if (!name || !title || !school) return null;

        const courses = normalizeList(profile.courses);
        const education = normalizeList(profile.education);
        const teachingInterests = normalizeList(profile.teachingInterests);
        const researchInterests = normalizeList(profile.researchInterests);
        const publishedResearch = normalizeList(profile.publishedResearch);
        const bio = normalizeText(profile.bio);

        return {
          name,
          title,
          school,
          office: normalizeText(profile.office),
          email: normalizeText(profile.email),
          phone: normalizeText(profile.phone),
          courses,
          education,
          teachingInterests,
          researchInterests,
          publishedResearch,
          bio,
          profileUrl: normalizeText(profile.profileUrl),
        };
      })
      .filter((profile): profile is ContextFacultyProfile => profile !== null),
    (profile) => profile.name
  );
}

function generateMarkdown() {
  if (!fs.existsSync(JSON_INPUT_PATH)) {
    console.error(`Error: Data file not found at ${JSON_INPUT_PATH}`);
    process.exit(1);
  }

  let profiles: FacultyProfile[];
  try {
    const rawData = JSON.parse(fs.readFileSync(JSON_INPUT_PATH, 'utf-8'));
    profiles = validateFacultyProfiles(rawData);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Error validating faculty JSON: ${message}`);
    process.exit(1);
  }

  const sourceCapture = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'data/raw/faculty-sources.raw.json'), 'utf8')) as {
    pages: Array<{ requestedUrl: string; url: string; fetchedAt: string }>;
  };
  const collectedAt = Object.fromEntries(sourceCapture.pages.flatMap(page =>
    [[page.requestedUrl, page.fetchedAt], [page.url, page.fetchedAt]]));
  const markdown = renderFacultyMarkdown(profiles, collectedAt);
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(MARKDOWN_OUTPUT_PATH, markdown, 'utf-8');
  console.log(`Generated complete faculty context for ${profiles.length} profiles at ${MARKDOWN_OUTPUT_PATH}`);
}

export function renderFacultyMarkdown(profiles: FacultyProfile[], collectedAt: Record<string, string> = {}): string {
  const contextProfiles = toContextProfiles(profiles);
  const frontmatter = buildFrontmatter({
    source_url: "https://www.ramapo.edu/faculty/",
    title: "Faculty Directory",
    trust_tier: "official_secondary",
    freshness_sla_hours: 720
  });

  let markdown = frontmatter + '# Ramapo College Faculty Directory\n\n';
  markdown += `*Generated (UTC): ${getGeneratedTimestamp()}*\n\n`;
  markdown += '*Source-backed faculty profile content. Profile course lists are undated and do not establish current teaching assignments.*\n\n';
  markdown += '---\n\n';

  contextProfiles.forEach((profile) => {
    markdown += `## ${profile.name}\n\n`;
    if (profile.profileUrl) {
      markdown += `- URL: ${profile.profileUrl}\n`;
      if (collectedAt[profile.profileUrl]) markdown += `- Collected At: ${collectedAt[profile.profileUrl]}\n`;
      markdown += '\n';
    }
    markdown += `- **Title:** ${profile.title}\n`;
    markdown += `- **School:** ${profile.school}\n`;
    if (profile.office) markdown += `- **Office:** ${profile.office}\n`;
    if (profile.email) markdown += `- **Email:** ${profile.email}\n`;
    if (profile.phone) markdown += `- **Phone:** ${profile.phone}\n`;
    if (profile.courses.length > 0) markdown += `- **Courses:** ${profile.courses.join('; ')}\n`;
    if (profile.education.length) markdown += `- **Education:** ${profile.education.join('; ')}\n`;
    if (profile.teachingInterests.length) markdown += `- **Teaching Interests:** ${profile.teachingInterests.join('; ')}\n`;
    if (profile.researchInterests.length) markdown += `- **Research Interests:** ${profile.researchInterests.join('; ')}\n`;
    if (profile.publishedResearch.length > 0) {
      markdown += `- **Published Research:** ${profile.publishedResearch.join('; ')}\n`;
    }
    if (profile.bio) markdown += `- **Bio:** ${profile.bio}\n`;
    markdown += '\n---\n\n';
  });

  return markdown;
}

if (process.argv[1]?.endsWith('generate-faculty-md.ts')) generateMarkdown();
