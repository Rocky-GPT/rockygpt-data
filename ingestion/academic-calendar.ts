import fs from 'node:fs';
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

function parseCalendarHtml(currentHtml: string, futureHtml: string): Semester[] {
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

  return validateAcademicCalendar(semesters);
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
    const currentName =
      (await page
        .locator('h1, h2, h3')
        .allTextContents())
        .map(cleanText)
        .find((heading) => /\b(?:spring|summer|fall|winter)\s+20\d{2}\b/i.test(heading)) ||
      'Current Academic Calendar';
    const currentEvents = await page.locator('.ramapo-tribe-event-body').evaluateAll((nodes) =>
      nodes.flatMap((node) => {
        const month = node.querySelector('.month')?.textContent?.trim();
        const day = node.querySelector('.date')?.textContent?.trim();
        const title = node
          .querySelector('.ramapo-tribe-event-title a')
          ?.textContent?.trim();
        const description = node
          .querySelector('.ramapo-tribe-event-time')
          ?.textContent?.trim();
        return title
          ? [{ date: month && day ? `${month} ${day}` : 'Unknown', title, description: description || '' }]
          : [];
      })
    );

    await page.goto(FUTURE_CALENDAR_URL, { waitUntil: 'networkidle', timeout: 30_000 });
    const futureSemesters = await page.locator('.collapsableContent').evaluateAll((sections) =>
      sections.flatMap((section) => {
        const name =
          section.querySelector('.collapsableTitle')?.textContent?.trim() ||
          'Unknown Semester';
        const events = Array.from(section.querySelectorAll('.ramapo-tribe-event-body')).flatMap(
          (node) => {
            const month = node.querySelector('.month')?.textContent?.trim();
            const day = node.querySelector('.date')?.textContent?.trim();
            const title = node
              .querySelector('.ramapo-tribe-event-title a')
              ?.textContent?.trim();
            const description = node
              .querySelector('.ramapo-tribe-event-time')
              ?.textContent?.trim();
            return title
              ? [{
                  date: month && day ? `${month} ${day}` : 'Unknown',
                  title,
                  description: description || '',
                }]
              : [];
          }
        );
        return events.length > 0 ? [{ name, events }] : [];
      })
    );

    return validateAcademicCalendar([
      ...(currentEvents.length > 0 ? [{ name: currentName, events: currentEvents }] : []),
      ...futureSemesters,
    ]);
  } finally {
    await browser.close();
  }
}

function addResidenceLifeDates(semesters: Semester[]): Semester[] {
  const reslifePath = path.join(process.cwd(), 'data', 'normalized', 'reslife.json');
  if (!fs.existsSync(reslifePath)) return semesters;
  try {
    const reslife = validateAcademicCalendar(
      JSON.parse(fs.readFileSync(reslifePath, 'utf8')) as unknown
    );
    console.log(`Injecting ${reslife.length} Residence Life semesters into global calendar.`);
    return [
      ...semesters,
      ...reslife.map((semester) => ({
        ...semester,
        name: `Housing: ${semester.name}`,
      })),
    ];
  } catch (error) {
    console.warn(
      `Residence Life dates were not added: ${error instanceof Error ? error.message : String(error)}`
    );
    return semesters;
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

  const normalizedSemesters = calendarWithConcepts(addResidenceLifeDates(semesters));
  writeJsonFile(JSON_OUTPUT_PATH, normalizedSemesters);
  writeJsonFile(PUBLIC_JSON_OUTPUT_PATH, normalizedSemesters);
  runGeneratorScript(MARKDOWN_GENERATOR_PATH);
}

void fetchAcademicCalendar().catch((error: unknown) => {
  console.error(
    `Academic calendar collection failed: ${error instanceof Error ? error.message : String(error)}`
  );
  process.exitCode = 1;
});
