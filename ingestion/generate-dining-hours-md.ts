import fs from 'fs';
import path from 'path';
import { buildFrontmatter } from './frontmatter';
import { getGeneratedTimestamp, sortByName } from './pipeline-utils';
import {
  type DiningHoursGroup,
  type DiningHoursPreloadedState,
  validateDiningHoursState,
} from './schema';

interface ContextHoursGroup {
  days: string;
  hours: string;
}

interface ContextHoursSection {
  label: string;
  groups: ContextHoursGroup[];
}

interface ContextDiningLocation {
  name: string;
  sections: ContextHoursSection[];
}

const DATA_DIR = path.join(process.cwd(), 'data', 'normalized');
const OUTPUT_DIR = path.join(process.cwd(), 'data', 'context', 'dining');
const JSON_INPUT_PATH = path.join(DATA_DIR, 'dining-hours.json');
const MARKDOWN_OUTPUT_PATH = path.join(OUTPUT_DIR, 'hours.md');

function normalizeText(value?: string): string | undefined {
  if (!value) return undefined;
  const trimmed = value.replace(/\s+/g, ' ').trim();
  return trimmed || undefined;
}

function formatIsoDateOnly(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }
  return parsed.toISOString().slice(0, 10);
}

function formatTime(time: { hour: string; minute: string; period: string }): string {
  return `${time.hour}:${time.minute} ${time.period}`;
}

function formatHoursList(hoursList: DiningHoursGroup['hours']): string {
  const segments = hoursList
    .map((hours) => {
      if (hours.allDay) return 'Open 24 Hours';
      const start = hours.startTime ? formatTime(hours.startTime) : undefined;
      const end = hours.finishTime ? formatTime(hours.finishTime) : undefined;
      const timeRange = start && end ? `${start} - ${end}` : undefined;
      const label = normalizeText(hours.label);

      if (label && timeRange) return `${label}: ${timeRange}`;
      if (label) return label;
      if (timeRange) return timeRange;
      return undefined;
    })
    .filter((segment): segment is string => Boolean(segment));

  return segments.length > 0 ? segments.join('; ') : 'Closed';
}

function mapHoursGroups(groups: DiningHoursGroup[]): ContextHoursGroup[] {
  return groups
    .map((group) => {
      const days = group.days
        .map((day) => normalizeText(day.value))
        .filter((day): day is string => Boolean(day))
        .join(', ');

      return {
        days: days || 'Daily',
        hours: formatHoursList(group.hours),
      };
    })
    .filter((group) => Boolean(group.hours))
    .sort((a, b) => a.days.localeCompare(b.days));
}

function toContextDiningHours(
  rawState: DiningHoursPreloadedState,
  referenceTime: Date
): ContextDiningLocation[] {
  const locationMap = new Map<string, ContextDiningLocation>();
  const regions = rawState.composition.subject.regions;

  regions.forEach((region) => {
    region.fragments.forEach((fragment) => {
      if (fragment.type !== 'Location') return;

      const name = normalizeText(fragment.content.main.name);
      if (!name || locationMap.has(name)) return;

      const openingHours = fragment.content.main.openingHours;
      let sections: ContextHoursSection[] = [];

      const activeSeason = openingHours.seasonalHours.find((season) => {
        const from = new Date(season.from);
        const to = new Date(season.to);
        return referenceTime >= from && referenceTime <= to;
      });

      if (activeSeason) {
        sections.push({
          label: `Special Hours (${formatIsoDateOnly(activeSeason.from)} - ${formatIsoDateOnly(activeSeason.to)})`,
          groups: mapHoursGroups(activeSeason.openingHours),
        });
      } else if (openingHours.standardHours.length > 0) {
        sections.push({
          label: 'Regular Hours',
          groups: mapHoursGroups(openingHours.standardHours),
        });
      }

      sections = sections
        .map((section) => ({
          ...section,
          groups: section.groups.filter((group) => Boolean(group.hours)),
        }))
        .filter((section) => section.groups.length > 0);

      if (sections.length === 0) {
        sections = [
          {
            label: 'Hours',
            groups: [{ days: 'Daily', hours: 'Hours not available' }],
          },
        ];
      }

      locationMap.set(name, { name, sections });
    });
  });

  return sortByName(Array.from(locationMap.values()), (location) => location.name);
}

function generateMarkdown() {
  if (!fs.existsSync(JSON_INPUT_PATH)) {
    console.error(`Error: Data file not found at ${JSON_INPUT_PATH}`);
    process.exit(1);
  }

  let state: DiningHoursPreloadedState;
  try {
    const rawData = JSON.parse(fs.readFileSync(JSON_INPUT_PATH, 'utf-8'));
    state = validateDiningHoursState(rawData);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Error validating dining-hours JSON: ${message}`);
    process.exit(1);
  }

  const generatedAt = getGeneratedTimestamp();
  const referenceTime = new Date(generatedAt);
  const contextLocations = toContextDiningHours(
    state,
    Number.isNaN(referenceTime.getTime()) ? new Date() : referenceTime
  );
  console.log(`Selected ${contextLocations.length} dining locations for context markdown.`);

  const frontmatter = buildFrontmatter({
    source_url: "https://ramapo.sodexomyway.com/en-us/locations/hours",
    title: "Dining Hours",
    trust_tier: "official_primary",
    freshness_sla_hours: 24
  });

  let markdown = frontmatter + '# Dining Hours\n\n';
  markdown += `*Generated (UTC): ${generatedAt}*\n\n`;

  contextLocations.forEach((location) => {
    markdown += `## ${location.name}\n\n`;
    location.sections.forEach((section) => {
      markdown += `### ${section.label}\n`;
      section.groups.forEach((group) => {
        markdown += `- **${group.days}**: ${group.hours}\n`;
      });
      markdown += '\n';
    });
  });

  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }
  fs.writeFileSync(MARKDOWN_OUTPUT_PATH, markdown, 'utf-8');
  console.log(`Successfully generated markdown at ${MARKDOWN_OUTPUT_PATH}`);
}

generateMarkdown();
