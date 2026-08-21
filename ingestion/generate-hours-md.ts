import fs from 'fs';
import path from 'path';
import { buildFrontmatter } from './frontmatter';
import { getGeneratedTimestamp, sortByName } from './pipeline-utils';
import { type LocationHours, validateCampusHours } from './schema';

interface ContextLocationHours {
  name: string;
  hours: Record<string, string>;
  notes?: string;
}

const DATA_DIR = path.join(process.cwd(), 'data', 'normalized');
const OUTPUT_DIR = path.join(process.cwd(), 'data', 'context', 'campus');
const JSON_INPUT_PATH = path.join(DATA_DIR, 'hours.json');
const MARKDOWN_OUTPUT_PATH = path.join(OUTPUT_DIR, 'hours.md');
const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

function normalizeText(value?: string): string | undefined {
  if (!value) return undefined;
  const trimmed = value.replace(/\s+/g, ' ').trim();
  return trimmed || undefined;
}

function toContextHours(locations: LocationHours[]): ContextLocationHours[] {
  return sortByName(
    locations
      .map((location): ContextLocationHours | null => {
        const name = normalizeText(location.name);
        if (!name) return null;

        const hours: Record<string, string> = {};
        DAYS.forEach((day) => {
          const value = normalizeText(location.hours?.[day]);
          hours[day] = value || 'N/A';
        });

        return {
          name,
          hours,
          notes: normalizeText(location.notes),
        };
      })
      .filter((location): location is ContextLocationHours => location !== null),
    (location) => location.name
  );
}

function generateMarkdown() {
  if (!fs.existsSync(JSON_INPUT_PATH)) {
    console.error(`Error: Data file not found at ${JSON_INPUT_PATH}`);
    process.exit(1);
  }

  let locations: LocationHours[];
  try {
    const rawData = JSON.parse(fs.readFileSync(JSON_INPUT_PATH, 'utf-8'));
    locations = validateCampusHours(rawData);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Error validating hours JSON: ${message}`);
    process.exit(1);
  }

  const contextLocations = toContextHours(locations);
  console.log(`Loaded ${locations.length} locations from JSON.`);
  console.log(`Selected ${contextLocations.length} locations for context markdown.`);

  const frontmatter = buildFrontmatter({
    source_url: "https://www.ramapo.edu/about/campus-hours/",
    title: "Campus Hours",
    trust_tier: "official_primary",
    freshness_sla_hours: 4_320
  });

  let markdown = frontmatter + '# Ramapo College Campus Hours\n\n';
  markdown += `*Generated (UTC): ${getGeneratedTimestamp()}*\n\n`;
  markdown += '---\n\n';

  contextLocations.forEach((location) => {
    markdown += `## ${location.name}\n\n`;
    markdown += '| Day | Hours |\n';
    markdown += '|-----|-------|\n';
    DAYS.forEach((day) => {
      markdown += `| ${day} | ${location.hours[day] || 'N/A'} |\n`;
    });
    if (location.notes) {
      markdown += `\n> **Note:** ${location.notes}\n`;
    }
    markdown += '\n---\n\n';
  });

  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }
  fs.writeFileSync(MARKDOWN_OUTPUT_PATH, markdown, 'utf-8');
  console.log(`Successfully generated markdown at ${MARKDOWN_OUTPUT_PATH}`);
}

generateMarkdown();
