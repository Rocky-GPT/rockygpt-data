import fs from 'fs';
import path from 'path';
import { buildFrontmatter } from './frontmatter';
import { getGeneratedTimestamp, sortByName } from './pipeline-utils';
import { type ArchwayEvent, validateArchwayEvents } from './schema';
import { sanitizeEventDescription } from './event-description';

interface ContextEvent {
  title: string;
  date: string;
  timeRange?: string;
  location?: string;
  organizer?: string;
  description?: string;
  ticketStatus?: string;
  url?: string;
}

const DATA_DIR = path.join(process.cwd(), 'data', 'normalized');
const OUTPUT_DIR = path.join(process.cwd(), 'data', 'context', 'campus');
const JSON_INPUT_PATH = path.join(DATA_DIR, 'events.json');
const MARKDOWN_OUTPUT_PATH = path.join(OUTPUT_DIR, 'live-events.md');
const MAX_DESCRIPTION_LENGTH = 300;

function normalizeText(value?: string): string | undefined {
  if (!value) return undefined;
  const trimmed = value.replace(/\s+/g, ' ').trim();
  return trimmed || undefined;
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 3).trimEnd()}...`;
}

function parseDateKey(value: string): number {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? Number.MAX_SAFE_INTEGER : parsed;
}

function toContextEvents(events: ArchwayEvent[]): ContextEvent[] {
  return sortByName(
    events
      .map((event): ContextEvent | null => {
        const title = normalizeText(event.title);
        const date = normalizeText(event.date);
        if (!title || !date) {
          return null;
        }

        const startTime = normalizeText(event.time);
        const endTime = normalizeText(event.endTime);
        const timeRange = startTime ? (endTime ? `${startTime} - ${endTime}` : startTime) : undefined;
        const description = sanitizeEventDescription(event.description);

        return {
          title,
          date,
          timeRange,
          location: normalizeText(event.location),
          organizer: normalizeText(event.organizer),
          description: description ? truncate(description, MAX_DESCRIPTION_LENGTH) : undefined,
          ticketStatus: normalizeText(event.ticketStatus),
          url: normalizeText(event.url),
        };
      })
      .filter((event): event is ContextEvent => event !== null),
    (event) => `${event.date}|${event.title}|${event.timeRange || ''}`
  );
}

function generateMarkdown() {
  if (!fs.existsSync(JSON_INPUT_PATH)) {
    console.error(`Error: Data file not found at ${JSON_INPUT_PATH}`);
    process.exit(1);
  }

  let events: ArchwayEvent[];
  try {
    const rawData = JSON.parse(fs.readFileSync(JSON_INPUT_PATH, 'utf-8'));
    events = validateArchwayEvents(rawData);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Error validating events JSON: ${message}`);
    process.exit(1);
  }

  const contextEvents = toContextEvents(events);
  console.log(`Loaded ${events.length} events from JSON.`);
  console.log(`Selected ${contextEvents.length} events for context markdown.`);

  const generatedAt = getGeneratedTimestamp();

  const frontmatter = buildFrontmatter({
    source_url: "https://archway.ramapo.edu/events",
    title: "Events Page",
    trust_tier: "official_primary",
    freshness_sla_hours: 24
  });

  let markdown = frontmatter + '# Archway Campus Events\n\n';
  markdown += `*Generated (UTC): ${generatedAt}*\n\n`;
  markdown += '*Showing all upcoming events with key details for campus Q&A*\n\n';
  markdown += `**Total Events: ${contextEvents.length}**\n\n`;
  markdown += '---\n\n';

  if (contextEvents.length === 0) {
    markdown += 'No events found.\n';
  } else {
    const eventsByDate = new Map<string, ContextEvent[]>();
    contextEvents.forEach((event) => {
      const dateKey = event.date || 'No Date';
      if (!eventsByDate.has(dateKey)) {
        eventsByDate.set(dateKey, []);
      }
      eventsByDate.get(dateKey)!.push(event);
    });

    const sortedDates = Array.from(eventsByDate.keys()).sort((a, b) => {
      if (a === 'No Date') return 1;
      if (b === 'No Date') return -1;
      const aValue = parseDateKey(a);
      const bValue = parseDateKey(b);
      if (aValue !== bValue) return aValue - bValue;
      return a.localeCompare(b);
    });

    sortedDates.forEach((date) => {
      const dateEvents = sortByName(eventsByDate.get(date) || [], (event) => {
        return `${event.title}|${event.timeRange || ''}`;
      });

      markdown += `## ${date}\n\n`;
      dateEvents.forEach((event) => {
        markdown += `### ${event.title}\n\n`;
        if (event.timeRange) markdown += `- **Time:** ${event.timeRange}\n`;
        if (event.location) markdown += `- **Location:** ${event.location}\n`;
        if (event.organizer) markdown += `- **Organizer:** ${event.organizer}\n`;
        if (event.description) markdown += `- **Description:** ${event.description}\n`;
        if (event.ticketStatus) markdown += `- **Ticket:** ${event.ticketStatus}\n`;
        if (event.url) markdown += `- **Link:** ${event.url}\n`;
        markdown += '\n';
      });
      markdown += '---\n\n';
    });
  }

  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }
  fs.writeFileSync(MARKDOWN_OUTPUT_PATH, markdown, 'utf-8');
  console.log(`Successfully generated markdown at ${MARKDOWN_OUTPUT_PATH}`);
}

generateMarkdown();
