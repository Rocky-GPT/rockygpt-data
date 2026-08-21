import fs from 'fs';
import path from 'path';
import { getGeneratedTimestamp } from './pipeline-utils';
import { type RawDatasetV1, type RawPageV1, validateRawDatasetV1 } from './raw-types';

const DATA_DIR = path.join(process.cwd(), 'data', 'normalized');
const OUTPUT_DIR = path.join(process.cwd(), 'data', 'context', 'campus');
const INPUT_FILE = path.join(DATA_DIR, 'transportation.json');
const OUTPUT_FILE = path.join(OUTPUT_DIR, 'transportation.md');
const TIME_PATTERN = /\b\d{1,2}\s*:\s*\d{2}\s*(?:AM|PM)\b/i;

function normalizeText(value: string | null | undefined): string {
  if (!value) return '';
  return value
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeTime(value: string): string {
  return normalizeText(value).replace(/\s*:\s*/g, ':').toUpperCase();
}

function dedupeStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of values) {
    const key = value.toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    output.push(value);
  }
  return output;
}

function chunkArray<T>(values: T[], size: number): T[][] {
  if (size <= 0) return [values];
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

function ensureOutputDir(filePath: string): void {
  const directory = path.dirname(filePath);
  if (!fs.existsSync(directory)) {
    fs.mkdirSync(directory, { recursive: true });
  }
}

function loadDataset(filePath: string): RawDatasetV1 {
  if (!fs.existsSync(filePath)) {
    console.error(`Error: normalized dataset not found at ${filePath}`);
    process.exit(1);
  }

  try {
    const rawInput = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    const dataset = validateRawDatasetV1(rawInput);
    if (dataset.dataset !== 'transportation') {
      console.error(`Error: expected dataset "transportation" but found "${dataset.dataset}" in ${filePath}`);
      process.exit(1);
    }
    return dataset;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Error validating transportation normalized JSON: ${message}`);
    process.exit(1);
  }
}

function successfulPages(dataset: RawDatasetV1): RawPageV1[] {
  return dataset.pages.filter((page) => page.statusCode !== null && page.statusCode >= 200 && page.statusCode < 400);
}

function pageByUrlFragment(pages: RawPageV1[], fragment: string): RawPageV1 | null {
  const lower = fragment.toLowerCase();
  return pages.find((page) => page.url.toLowerCase().includes(lower)) ?? null;
}

function tableDepartureTimes(page: RawPageV1 | null): string[] {
  if (!page || page.tables.length === 0) return [];
  const table = page.tables[0];
  const departures: string[] = [];

  for (const row of table.rows) {
    const first = normalizeText(row[0]);
    if (!first || /leave ramapo|^campus$/i.test(first)) continue;
    const match = first.match(TIME_PATTERN);
    if (!match) continue;
    departures.push(normalizeTime(match[0]));
  }

  return dedupeStrings(departures);
}

function listTextCandidates(page: RawPageV1): string[] {
  const sectionText = page.sections.map((section) => normalizeText(section.text)).filter(Boolean);
  const listText = page.lists.flatMap((list) => list.map((item) => normalizeText(item)).filter(Boolean));
  return [...sectionText, ...listText];
}

function firstMatchingSentence(pages: RawPageV1[], pattern: RegExp): string | null {
  for (const page of pages) {
    const candidates = listTextCandidates(page);
    for (const text of candidates) {
      if (!pattern.test(text)) continue;
      const sentence = text.split(/(?<=[.!?])\s+/).find((part) => pattern.test(part)) ?? text;
      const cleaned = normalizeText(sentence);
      if (!cleaned) continue;
      return /[.!?]$/.test(cleaned) ? cleaned : `${cleaned}.`;
    }
  }
  return null;
}

function firstCommuterEmail(pages: RawPageV1[]): string | null {
  for (const page of pages) {
    for (const contact of page.contacts) {
      const email = normalizeText(contact.email) || normalizeText(contact.name);
      if (email.includes('@')) return email;
    }
  }
  return null;
}

function timeRangeLine(label: string, times: string[]): string | null {
  if (times.length === 0) return null;
  const first = times[0];
  const last = times[times.length - 1];
  return `- ${label} departures run from ${first} to ${last}.`;
}

function timeBullets(label: string, times: string[]): string[] {
  if (times.length === 0) return [`- ${label} departures are not available in the current context.`];
  const groups = chunkArray(times, 6);
  return groups.map((group, index) =>
    index === 0
      ? `- ${label} departures: ${group.join(', ')}.`
      : `- ${label} departures (continued): ${group.join(', ')}.`
  );
}

function titleWithoutSiteName(value: string | null): string {
  const cleaned = normalizeText(value);
  if (!cleaned) return 'Transportation Services';
  return cleaned
    .replace(/\s+\|\|\s+Ramapo College of New Jersey$/i, '')
    .replace(/\s+-\s+Ramapo College of New Jersey$/i, '');
}

const dataset = loadDataset(INPUT_FILE);
const pages = successfulPages(dataset);

const weekdayPage = pageByUrlFragment(pages, 'ramapo-roadrunner-express-shuttle');
const saturdayPage = pageByUrlFragment(pages, 'saturday-shuttle-schedule');
const sundayPage = pageByUrlFragment(pages, 'sunday-shuttle-schedule');
const expressPage = pageByUrlFragment(pages, 'shuttle-mid-day-weekday-express-train-schedule');
const servicesPage = pageByUrlFragment(pages, 'transportation-services') ?? pageByUrlFragment(pages, '/about/transportation/');

const weekdayDepartures = tableDepartureTimes(weekdayPage);
const saturdayDepartures = tableDepartureTimes(saturdayPage);
const sundayDepartures = tableDepartureTimes(sundayPage);
const expressDepartures = tableDepartureTimes(expressPage);

const bradleyNote =
  firstMatchingSentence(pages, /bradley center|residential areas/i) ??
  'The shuttle stops at Bradley Center on campus and does not enter residential areas.';
const updatesNote =
  firstMatchingSentence(pages, /@RCNJShuttle|changes to the shuttle schedule/i) ??
  'Schedule changes are announced on Transportation Services and @RCNJShuttle.';
const commuterEmail = firstCommuterEmail(pages);

let markdown = '# Ramapo Transportation Services\n\n';
markdown += `*Generated (UTC): ${getGeneratedTimestamp()}*\n\n`;
markdown += 'Context focused on shuttle schedule questions and commuter transportation resources.\n\n';

markdown += '## Quick Shuttle Answers\n\n';
const weekdayRange = timeRangeLine('Weekday', weekdayDepartures);
if (weekdayRange) markdown += `${weekdayRange}\n`;
const saturdayRange = timeRangeLine('Saturday', saturdayDepartures);
if (saturdayRange) markdown += `${saturdayRange}\n`;
const sundayRange = timeRangeLine('Sunday', sundayDepartures);
if (sundayRange) markdown += `${sundayRange}\n`;
markdown += '- For "next shuttle" questions, compare the current time against the departure list for the day.\n';
markdown += `- ${bradleyNote}\n`;
markdown += `- ${updatesNote}\n\n`;

markdown += '## Weekday Campus Departures (Spring 2026)\n\n';
timeBullets('Weekday', weekdayDepartures).forEach((line) => {
  markdown += `${line}\n`;
});
markdown += '\n';

markdown += '## Saturday Campus Departures (Spring 2026)\n\n';
timeBullets('Saturday', saturdayDepartures).forEach((line) => {
  markdown += `${line}\n`;
});
markdown += '\n';

markdown += '## Sunday Campus Departures (Spring 2026)\n\n';
timeBullets('Sunday', sundayDepartures).forEach((line) => {
  markdown += `${line}\n`;
});
markdown += '\n';

markdown += '## Mid-Day Weekday Express Train Loop\n\n';
timeBullets('Mid-day weekday express', expressDepartures).forEach((line) => {
  markdown += `${line}\n`;
});
markdown += '\n';

markdown += '## Common Shuttle Stops\n\n';
markdown += '- Common stops include Ramsey Rt 17 Train, Interstate Plaza, Garden State Plaza, Barnes & Noble, and Ramsey Square.\n';
markdown += '- Some runs also include CityMD Ramsey and Ramsey Farmers Market.\n\n';

markdown += '## Official Transportation Sources\n\n';
if (servicesPage) {
  markdown += `- ${titleWithoutSiteName(servicesPage.title)}: ${servicesPage.url}\n`;
}
if (weekdayPage) {
  markdown += `- ${titleWithoutSiteName(weekdayPage.title)}: ${weekdayPage.url}\n`;
}
if (saturdayPage) {
  markdown += `- ${titleWithoutSiteName(saturdayPage.title)}: ${saturdayPage.url}\n`;
}
if (sundayPage) {
  markdown += `- ${titleWithoutSiteName(sundayPage.title)}: ${sundayPage.url}\n`;
}
if (expressPage) {
  markdown += `- ${titleWithoutSiteName(expressPage.title)}: ${expressPage.url}\n`;
}
if (commuterEmail) {
  markdown += `- Commuter Affairs email: ${commuterEmail}\n`;
}

ensureOutputDir(OUTPUT_FILE);
fs.writeFileSync(OUTPUT_FILE, markdown, 'utf-8');
console.log(`Generated transportation context at ${OUTPUT_FILE}`);
