import fs from 'fs';
import path from 'path';
import {
  validateAcademicCalendar,
  validateArchwayClubs,
  validateArchwayEvents,
  validateCampusHours,
  validateDiningHoursState,
  validateFacultyProfiles,
  validateMenuData,
} from './schema';
import { writeJsonFile } from './pipeline-utils';
import { validateProgramsData } from './programs-data';
import { validateRawDatasetV1 } from './raw-types';
import { publicPath } from '../src/paths';
import { calendarWithConcepts } from '../src/data-v2/calendar-concepts';

type Validator = (input: unknown) => unknown;

interface NormalizationTask {
  name: string;
  inputFile: string;
  inputDirectory?: string;
  normalizedFile: string;
  validator: Validator;
  expectedDataset?: string;
}

const RAW_DIR = path.join(process.cwd(), 'data', 'raw');
const PUBLIC_DATA_DIR = publicPath('data');
const NORMALIZED_DIR = path.join(process.cwd(), 'data', 'normalized');

export const COLLECTOR_MANAGED_NORMALIZATION_TASKS = new Set([
  'menu',
  'dining-hours',
  'events',
  'hours',
  'clubs',
  'calendar',
  'faculty',
]);

const TASKS: NormalizationTask[] = [
  {
    name: 'menu',
    inputFile: 'menu.raw.json',
    normalizedFile: 'menu.json',
    validator: validateMenuData,
  },
  {
    name: 'dining-hours',
    inputFile: 'dining-hours.raw.json',
    normalizedFile: 'dining-hours.json',
    validator: validateDiningHoursState,
  },
  {
    name: 'events',
    inputFile: 'events.raw.json',
    normalizedFile: 'events.json',
    validator: validateArchwayEvents,
  },
  {
    name: 'hours',
    inputFile: 'hours.raw.json',
    normalizedFile: 'hours.json',
    validator: validateCampusHours,
  },
  {
    name: 'clubs',
    inputFile: 'clubs.raw.json',
    normalizedFile: 'clubs.json',
    validator: validateArchwayClubs,
  },
  {
    name: 'calendar',
    inputFile: 'calendar.raw.json',
    normalizedFile: 'calendar.json',
    validator: (input) => calendarWithConcepts(validateAcademicCalendar(input)),
  },
  {
    name: 'faculty',
    inputFile: 'faculty.raw.json',
    normalizedFile: 'faculty.json',
    validator: validateFacultyProfiles,
  },
  {
    name: 'events-detail',
    inputFile: 'events-detail.raw.json',
    normalizedFile: 'events-detail.json',
    validator: validateRawDatasetV1,
    expectedDataset: 'events-detail',
  },
  {
    name: 'clubs-detail',
    inputFile: 'clubs-detail.raw.json',
    normalizedFile: 'clubs-detail.json',
    validator: validateRawDatasetV1,
    expectedDataset: 'clubs-detail',
  },
  {
    name: 'transportation',
    inputFile: 'transportation.raw.json',
    normalizedFile: 'transportation.json',
    validator: validateRawDatasetV1,
    expectedDataset: 'transportation',
  },
  {
    name: 'directory',
    inputFile: 'directory.raw.json',
    normalizedFile: 'directory.json',
    validator: validateRawDatasetV1,
    expectedDataset: 'directory',
  },
  {
    name: 'housing',
    inputFile: 'housing.raw.json',
    normalizedFile: 'housing.json',
    validator: validateRawDatasetV1,
    expectedDataset: 'housing',
  },
  {
    name: 'health',
    inputFile: 'health.raw.json',
    normalizedFile: 'health.json',
    validator: validateRawDatasetV1,
    expectedDataset: 'health',
  },
  {
    name: 'counseling',
    inputFile: 'counseling.raw.json',
    normalizedFile: 'counseling.json',
    validator: validateRawDatasetV1,
    expectedDataset: 'counseling',
  },
  {
    name: 'safety',
    inputFile: 'safety.raw.json',
    normalizedFile: 'safety.json',
    validator: validateRawDatasetV1,
    expectedDataset: 'safety',
  },
  {
    name: 'programs',
    inputFile: 'programs.json',
    inputDirectory: PUBLIC_DATA_DIR,
    normalizedFile: 'programs.json',
    validator: validateProgramsData,
  },
];

function summarize(value: unknown): string {
  if (Array.isArray(value)) {
    return `${value.length} records`;
  }

  if (value && typeof value === 'object') {
    const maybeDataset = value as { pages?: unknown[]; dataset?: string };
    if (Array.isArray(maybeDataset.pages)) {
      return `${maybeDataset.pages.length} pages`;
    }
    return `${Object.keys(value).length} keys`;
  }

  return typeof value;
}

function readJson(filePath: string): unknown {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

function normalizeRaw() {
  console.log('Starting step 2: normalize raw JSON into data/normalized...');

  const excludeCollectorManaged = process.env.NORMALIZE_RAW_EXCLUDE_COLLECTOR_MANAGED === '1';
  const tasks = TASKS.filter(
    (task) => !excludeCollectorManaged || !COLLECTOR_MANAGED_NORMALIZATION_TASKS.has(task.name)
  );

  if (excludeCollectorManaged) {
    console.log(
      'Preserving collector-enriched normalized artifacts for menu, dining, events, hours, clubs, calendar, and faculty.'
    );
  }

  for (const task of tasks) {
    const rawPath = path.join(task.inputDirectory ?? RAW_DIR, task.inputFile);
    const normalizedPath = path.join(NORMALIZED_DIR, task.normalizedFile);

    if (!fs.existsSync(rawPath)) {
      throw new Error(`Missing raw file for ${task.name}: ${rawPath}`);
    }

    const rawInput = readJson(rawPath);
    const normalized = task.validator(rawInput);

    if (task.expectedDataset) {
      const dataset = (normalized as { dataset?: string }).dataset;
      if (dataset !== task.expectedDataset) {
        throw new Error(
          `${task.name}: expected dataset '${task.expectedDataset}' but found '${dataset ?? 'undefined'}'`
        );
      }
    }

    writeJsonFile(normalizedPath, normalized);
    console.log(`Normalized ${task.name}: ${summarize(normalized)} -> ${normalizedPath}`);
  }

  console.log(`Step 2 complete. Wrote ${tasks.length} normalized JSON files.`);
}

if (process.argv[1]?.endsWith('normalize-raw.ts')) {
  try {
    normalizeRaw();
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('normalize:raw failed:', message);
    process.exit(1);
  }
}
