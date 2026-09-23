import path from 'node:path';
import { load } from 'cheerio';
import { chromium } from 'playwright';
import { fetchWithPolicy } from './http-client';
import {
  assertCollectionCount,
  isRawOnlyMode,
  runGeneratorScript,
  writeJsonFile,
  writeRawProvenance,
} from './pipeline-utils';
import { type CalendarEvent, type Semester, validateAcademicCalendar } from './schema';
import { publicPath } from '../src/paths';
import { calendarWithConcepts } from '../src/data-v2/calendar-concepts';

const CURRENT_CALENDAR_URL = 'https://www.ramapo.edu/academic-calendars/';
const FUTURE_CALENDAR_URL =
  'https://www.ramapo.edu/academic-calendars/future-calendars/';
const RAW_JSON_OUTPUT_PATH = path.join(process.cwd(), 'data', 'raw', 'calendar.raw.json');
const JSON_OUTPUT_PATH = path.join(process.cwd(), 'data', 'normalized', 'calendar.json');
const PUBLIC_JSON_OUTPUT_PATH = publicPath('data', 'calendar.json');
const MARKDOWN_GENERATOR_PATH = path.join(__dirname, 'generate-calendar-md.ts');

function cleanText(value: string | null | undefined): string {
  return value?.replace(/\s+/g, ' ').trim() || '';
}

function semesterNameFromPage(html: string): string {
  const $ = load(html);
  const headings = $('h1, h2, h3')
    .toArray()
    .map((element) => cleanText($(element).text()));
  return (
    headings.find((heading) => /\b(?:spring|summer|fall|winter)\s+20\d{2}\b/i.test(heading)) ||
    'Current Academic Calendar'
  );
}

function parseEvents(
  $: ReturnType<typeof load>,
  selector: string
): CalendarEvent[] {
  const events: CalendarEvent[] = [];
  $(selector).each((_, node) => {
    const container = $(node);
    const month = cleanText(container.find('.month').first().text());
    const day = cleanText(container.find('.date').first().text());
    const title = cleanText(container.find('.ramapo-tribe-event-title a').first().text());
    const description = cleanText(container.find('.ramapo-tribe-event-time').first().text());
    if (!title) return;
    events.push({
      date: month && day ? `${month} ${day}` : 'Unknown',
      title,
      description,
    });
  });
  return events;
}

export function mergeCalendarSemesters(semesters: Semester[]): Semester[] {
  const merged = new Map<string, Semester>();
  for (const semester of semesters) {
    const key = cleanText(semester.name).toLowerCase();
    const existing = merged.get(key) ?? { name: semester.name, events: [] };
    for (const event of semester.events) {
      const prior = existing.events.find(item => item.date === event.date && item.title === event.title);
      if (prior && prior.description !== event.description) {
        throw new Error(`Academic calendar sources disagree for ${semester.name}: ${event.date} ${event.title}`);
      }
      if (!prior) existing.events.push({ ...event });
    }
    merged.set(key, existing);
  }
  return validateAcademicCalendar([...merged.values()]);
}

export function parseCalendarHtml(currentHtml: string, futureHtml: string): Semester[] {
  const semesters: Semester[] = [];
  const current$ = load(currentHtml);
  const currentEvents = parseEvents(current$, '.ramapo-tribe-event-body');
  if (currentEvents.length > 0) {
    semesters.push({
      name: semesterNameFromPage(currentHtml),
      events: currentEvents,
    });
  }

  const future$ = load(futureHtml);
  future$('.collapsableContent').each((_, section) => {
    const container = future$(section);
    const name =
      cleanText(container.find('.collapsableTitle').first().text()) || 'Unknown Semester';
    const events = parseEvents(
      load(`<div>${container.html() || ''}</div>`),
      '.ramapo-tribe-event-body'
    );
    if (events.length > 0) semesters.push({ name, events });
  });

  return mergeCalendarSemesters(semesters);
}

async function collectCalendarWithHttp(): Promise<Semester[]> {
  const [current, future] = await Promise.all([
    fetchWithPolicy(
      CURRENT_CALENDAR_URL,
      { headers: { Accept: 'text/html,application/xhtml+xml' } },
      { expectedContentTypes: ['text/html', 'application/xhtml+xml'] }
    ),
    fetchWithPolicy(
      FUTURE_CALENDAR_URL,
      { headers: { Accept: 'text/html,application/xhtml+xml' } },
      { expectedContentTypes: ['text/html', 'application/xhtml+xml'] }
    ),
  ]);
  if (!current.ok || !future.ok) {
    throw new Error(
      `Calendar HTTP fetch returned current=${current.status}, future=${future.status}.`
    );
  }
  return parseCalendarHtml(current.text(), future.text());
}

async function collectCalendarWithBrowser(): Promise<Semester[]> {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(CURRENT_CALENDAR_URL, { waitUntil: 'networkidle', timeout: 30_000 });
    const currentHtml = await page.content();
    await page.goto(FUTURE_CALENDAR_URL, { waitUntil: 'networkidle', timeout: 30_000 });
    return parseCalendarHtml(currentHtml, await page.content());
  } finally {
    await browser.close();
  }
}

async function fetchAcademicCalendar(): Promise<void> {
  console.log('Fetching the academic calendar with lightweight HTTP parsing...');
  let semesters: Semester[];
  try {
    semesters = await collectCalendarWithHttp();
  } catch (error) {
    console.warn(
      `HTTP calendar parsing failed; using browser fallback. ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    semesters = await collectCalendarWithBrowser();
  }

  console.log(`Successfully collected ${semesters.length} academic-calendar semesters.`);
  assertCollectionCount({
    dataset: 'academic calendar',
    count: semesters.length,
    minimum: 3,
    previousFilePath: RAW_JSON_OUTPUT_PATH,
    minimumPreviousRatio: 0.5,
  });
  writeJsonFile(RAW_JSON_OUTPUT_PATH, semesters);
  writeRawProvenance('calendar', {
    sourceUrl: CURRENT_CALENDAR_URL,
    recordCount: semesters.length,
    payload: semesters,
  });

  if (isRawOnlyMode()) {
    console.log('RAW_ONLY enabled: skipping normalization and context generation.');
    return;
  }

  const normalizedSemesters = calendarWithConcepts(semesters);
  writeJsonFile(JSON_OUTPUT_PATH, normalizedSemesters);
  writeJsonFile(PUBLIC_JSON_OUTPUT_PATH, normalizedSemesters);
  runGeneratorScript(MARKDOWN_GENERATOR_PATH);
}

if (process.argv[1]?.endsWith('academic-calendar.ts')) void fetchAcademicCalendar().catch((error: unknown) => {
  console.error(
    `Academic calendar collection failed: ${error instanceof Error ? error.message : String(error)}`
  );
  process.exitCode = 1;
});
