import fs from 'node:fs';
import path from 'node:path';
import { validateAcademicCalendar, validateDiningHoursState,
  validateArchwayEvents, validateCampusHours } from './schema';
import { writeJsonFile } from './pipeline-utils';
import { validateProgramsData } from './programs-data';
import { validateRawDatasetV1 } from './raw-types';
import { calendarWithConcepts } from '../src/data-v2/calendar-concepts';
import { mergeCalendarSemesters } from './academic-calendar';
import { normalizeMenuSnapshot, normalizeMenuWeek } from './menu-data';
import { campusHoursPublication } from './campus-hours';
import { rebuildEventsFromRaw, readEventSignalMapFromRawFile } from './archway-events';
import { rebuildClubsFromRaw } from './archway-clubs';
import { normalizeCatalogCapture, parseBooleanEnv } from './scrape-catalog-api';
import { replayFacultySources, type FacultySourceCapture } from './replay-faculty';
import { replayRawSourceCapture, type RawSourceCaptureV1 } from './raw-collector';

export interface NormalizationOptions {
  now?: Date;
  includeInactivePrograms?: boolean;
}

/** Replay the same source-specific transforms as collection, including detail
 * captures. Validate all inputs before writing either consumer's projection.
 * Normalization never advances raw collection timestamps or provenance.
 */
export function normalizeRaw(cwd = process.cwd(), options: NormalizationOptions = {}): void {
  const read = (file: string): unknown => JSON.parse(fs.readFileSync(path.join(cwd, 'data/raw', file), 'utf8'));
  const outputs = new Map<string, unknown>();
  const stage = (name: string, value: unknown, publicCopy = false) => {
    outputs.set(`data/normalized/${name}.json`, value);
    if (publicCopy) outputs.set(`public/data/${name}.json`, value);
  };

  stage('menu', normalizeMenuSnapshot(read('menu.raw.json')));
  stage('menu-week', normalizeMenuWeek(read('menu-week.raw.json')));
  stage('dining-hours', validateDiningHoursState(read('dining-hours.raw.json')));
  const details = validateRawDatasetV1(read('events-detail.raw.json'));
  if (details.dataset !== 'events-detail') throw new Error('Expected events-detail raw dataset.');
  stage('events', rebuildEventsFromRaw(validateArchwayEvents(read('events.raw.json')), details,
    readEventSignalMapFromRawFile(path.join(cwd, 'data/raw/events-signals.raw.json'))), true);
  stage('events-detail', details);
  const clubDetails = validateRawDatasetV1(read('clubs-detail.raw.json'));
  if (clubDetails.dataset !== 'clubs-detail') throw new Error('Expected clubs-detail raw dataset.');
  stage('clubs', rebuildClubsFromRaw(read('clubs.raw.json'), clubDetails), true);
  stage('clubs-detail', clubDetails);
  stage('calendar', calendarWithConcepts(mergeCalendarSemesters(validateAcademicCalendar(read('calendar.raw.json')))), true);
  const faculty = replayFacultySources(read('faculty.raw.json'), read('faculty-sources.raw.json') as FacultySourceCapture);
  stage('faculty', faculty);
  const hours = validateCampusHours(read('hours.raw.json'));
  if (hours.some(record => !record.sourceUrl || !record.collectedAt || !Number.isFinite(Date.parse(record.collectedAt)))) {
    throw new Error('Hours need per-facility source captures; run fetch:hours before normalize:raw.');
  }
  const publication = campusHoursPublication(hours, options.now ?? new Date());
  stage('hours', validateCampusHours(publication.publishable), true);
  const collectedAt = new Date(Math.min(...hours.map(record => Date.parse(record.collectedAt!)))).toISOString();
  stage('hours-omissions', { version: 1, collectedAt, omitted: publication.omitted });

  for (const name of ['transportation', 'directory', 'housing', 'health', 'counseling', 'safety', 'major-page-links', 'office-pages']) {
    const original = validateRawDatasetV1(read(`${name}.raw.json`));
    const dataset = validateRawDatasetV1(replayRawSourceCapture(read(`${name}-sources.raw.json`) as RawSourceCaptureV1));
    const pageIdentities = (pages: typeof dataset.pages) => pages.map(page =>
      JSON.stringify([page.url, page.sourceType, page.statusCode, page.fetchedAt])).sort();
    if (JSON.stringify(pageIdentities(original.pages)) !== JSON.stringify(pageIdentities(dataset.pages))) {
      throw new Error(`${name} source capture does not match the collected pages and timestamps`);
    }
    if (dataset.dataset !== name) throw new Error(`Expected ${name} raw dataset, found ${dataset.dataset}.`);
    stage(name, dataset);
  }
  const catalog = normalizeCatalogCapture(read('catalog-programs-api.raw.json') as Parameters<typeof normalizeCatalogCapture>[0], faculty,
    options.includeInactivePrograms ?? parseBooleanEnv(process.env.PROGRAMS_INCLUDE_INACTIVE, false));
  stage('programs', validateProgramsData(catalog.programs), true);
  outputs.set('public/data/courses.json', catalog.courses);

  for (const [relativePath, payload] of outputs) writeJsonFile(path.join(cwd, relativePath), payload);
  console.log(`Normalized ${outputs.size} source-derived artifacts without changing raw provenance.`);
}

if (process.argv[1]?.endsWith('normalize-raw.ts')) {
  try { normalizeRaw(); }
  catch (error) {
    console.error('normalize:raw failed:', error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
