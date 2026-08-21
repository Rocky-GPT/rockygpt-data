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
  focusAreas: string[];
  publishedResearch: string[];
  bio?: string;
  profileUrl?: string;
}

const DATA_DIR = path.join(process.cwd(), 'data', 'normalized');
const OUTPUT_DIR = path.join(process.cwd(), 'data', 'context', 'academic');
const JSON_INPUT_PATH = path.join(DATA_DIR, 'faculty.json');
const MARKDOWN_OUTPUT_PATH = path.join(OUTPUT_DIR, 'faculty.md');
const MAX_BIO_LENGTH = 500;

function normalizeText(value?: string): string | undefined {
  if (!value) return undefined;
  const trimmed = value.replace(/\s+/g, ' ').trim();
  return trimmed || undefined;
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 3).trimEnd()}...`;
}

function normalizeList(values: string[] | undefined, maxLength = 8): string[] {
  if (!Array.isArray(values)) return [];
  const deduped = Array.from(
    new Set(
      values
        .map((value) => normalizeText(value))
        .filter((value): value is string => Boolean(value))
    )
  );
  return deduped.slice(0, maxLength);
}

function toContextProfiles(profiles: FacultyProfile[]): ContextFacultyProfile[] {
  return sortByName(
    profiles
      .map((profile): ContextFacultyProfile | null => {
        const name = normalizeText(profile.name);
        const title = normalizeText(profile.title);
        const school = normalizeText(profile.school);
        if (!name || !title || !school) return null;

        const courses = normalizeList(profile.courses, 10);
        const focusAreas = normalizeList(
          [...(profile.teachingInterests || []), ...(profile.researchInterests || [])],
          10
        );
        const publishedResearch = normalizeList(profile.publishedResearch, 5);
        const bio = normalizeText(profile.bio);

        return {
          name,
          title,
          school,
          office: normalizeText(profile.office),
          email: normalizeText(profile.email),
          phone: normalizeText(profile.phone),
          courses,
          focusAreas,
          publishedResearch,
          bio: bio ? truncate(bio, MAX_BIO_LENGTH) : undefined,
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

  const contextProfiles = toContextProfiles(profiles);
  console.log(`Loaded ${profiles.length} profiles from JSON.`);
  console.log(`Selected ${contextProfiles.length} profiles for context markdown.`);

  const frontmatter = buildFrontmatter({
    source_url: "https://www.ramapo.edu/faculty/",
    title: "Faculty Directory",
    trust_tier: "official_secondary",
    freshness_sla_hours: 720
  });

  let markdown = frontmatter + '# Ramapo College Faculty Directory\n\n';
  markdown += `*Generated (UTC): ${getGeneratedTimestamp()}*\n\n`;
  markdown += '*This context file contains only fields needed for Q&A retrieval.*\n\n';
  markdown += '---\n\n';

  contextProfiles.forEach((profile) => {
    markdown += `## ${profile.name}\n\n`;
    markdown += `- **Title:** ${profile.title}\n`;
    markdown += `- **School:** ${profile.school}\n`;
    if (profile.office) markdown += `- **Office:** ${profile.office}\n`;
    if (profile.email) markdown += `- **Email:** ${profile.email}\n`;
    if (profile.phone) markdown += `- **Phone:** ${profile.phone}\n`;
    if (profile.courses.length > 0) markdown += `- **Courses:** ${profile.courses.join('; ')}\n`;
    if (profile.focusAreas.length > 0) {
      markdown += `- **Focus Areas:** ${profile.focusAreas.join('; ')}\n`;
    }
    if (profile.publishedResearch.length > 0) {
      markdown += `- **Published Research:** ${profile.publishedResearch.join('; ')}\n`;
    }
    if (profile.bio) markdown += `- **Bio:** ${profile.bio}\n`;
    if (profile.profileUrl) markdown += `- **Profile:** ${profile.profileUrl}\n`;
    markdown += '\n---\n\n';
  });

  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }
  fs.writeFileSync(MARKDOWN_OUTPUT_PATH, markdown, 'utf-8');
  console.log(`Successfully generated markdown at ${MARKDOWN_OUTPUT_PATH}`);
}

generateMarkdown();
