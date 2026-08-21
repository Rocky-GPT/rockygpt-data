import fs from 'fs';
import path from 'path';
import { buildFrontmatter } from './frontmatter';
import { getGeneratedTimestamp, sortByName } from './pipeline-utils';
import { type ArchwayClub, validateArchwayClubs } from './schema';

interface ContextClub {
  name: string;
  category: string;
  websiteUrl?: string;
  email?: string;
  instagramUrl?: string;
}

const DATA_DIR = path.join(process.cwd(), 'data', 'normalized');
const OUTPUT_DIR = path.join(process.cwd(), 'data', 'context', 'campus');
const JSON_INPUT_PATH = path.join(DATA_DIR, 'clubs.json');
const MARKDOWN_OUTPUT_PATH = path.join(OUTPUT_DIR, 'clubs.md');

function normalizeText(value?: string): string | undefined {
  if (!value) return undefined;
  const trimmed = value.replace(/\s+/g, ' ').trim();
  return trimmed || undefined;
}

function toContextClubs(clubs: ArchwayClub[]): ContextClub[] {
  return sortByName(
    clubs
      .map((club): ContextClub | null => {
        const name = normalizeText(club.name);
        if (!name) return null;
        return {
          name,
          category: normalizeText(club.category) || 'Other',
          websiteUrl: normalizeText(club.websiteUrl),
          email: normalizeText(club.email),
          instagramUrl: normalizeText(club.instagramUrl),
        };
      })
      .filter((club): club is ContextClub => club !== null),
    (club) => club.name
  );
}

function generateMarkdown() {
  if (!fs.existsSync(JSON_INPUT_PATH)) {
    console.error(`Error: Data file not found at ${JSON_INPUT_PATH}`);
    process.exit(1);
  }

  let clubs: ArchwayClub[];
  try {
    const rawData = JSON.parse(fs.readFileSync(JSON_INPUT_PATH, 'utf-8'));
    clubs = validateArchwayClubs(rawData);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Error validating clubs JSON: ${message}`);
    process.exit(1);
  }

  const contextClubs = toContextClubs(clubs);
  console.log(`Loaded ${clubs.length} clubs from JSON.`);
  console.log(`Selected ${contextClubs.length} clubs for context markdown.`);

  const frontmatter = buildFrontmatter({
    source_url: "https://archway.ramapo.edu/organizations",
    title: "Archway Events & Clubs",
    trust_tier: "official_secondary",
    freshness_sla_hours: 4_320
  });

  let markdown = frontmatter + '# Student Organizations at Ramapo College\n\n';
  markdown += `*Generated (UTC): ${getGeneratedTimestamp()}*\n`;
  markdown += `*Total Organizations: ${contextClubs.length}*\n\n`;
  markdown += 'Use this list to answer questions about clubs, organizations, and greek life on campus.\n\n';

  contextClubs.forEach((club) => {
    markdown += `## ${club.name}\n`;
    markdown += `- **Category:** ${club.category}\n`;
    if (club.websiteUrl) markdown += `- **Link:** [Archway Page](${club.websiteUrl})\n`;
    if (club.email) markdown += `- **Email:** ${club.email}\n`;
    if (club.instagramUrl) markdown += `- **Instagram:** [Link](${club.instagramUrl})\n`;
    markdown += '\n';
  });

  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }
  fs.writeFileSync(MARKDOWN_OUTPUT_PATH, markdown, 'utf-8');
  console.log(`Successfully generated markdown at ${MARKDOWN_OUTPUT_PATH}`);
}

generateMarkdown();
