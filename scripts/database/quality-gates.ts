import fs from 'fs';
import path from 'path';
import {
  challengeContentLabel,
  collectPublishableArtifactErrors,
  eventDetailCoverageErrors,
  eventQualityErrors,
  facultyQualityErrors,
} from '../../pipeline/quality/content-policy';
import { evaluateSourceProvenance } from '../../pipeline/quality/provenance';
import { SOURCES } from '../../src/data-v2/source-seeds';
import {
  countDiningLocations,
  validateAcademicCalendar,
  validateArchwayClubs,
  validateArchwayEvents,
  validateCampusHours,
  validateDiningHoursState,
  validateFacultyProfiles,
  validateMenuData,
} from '../../ingestion/schema';
import { validateRawDatasetV1 } from '../../ingestion/raw-types';

type GateValidator<T> = (input: unknown) => T;

interface SourceGate<T> {
  name: string;
  filePath: string;
  maxAgeHours: number;
  minItems: number;
  validator: GateValidator<T>;
  count: (data: T) => number;
  optional?: boolean;
  preserveTopLevelCount?: boolean;
  quality?: (data: T) => string[];
}

interface MarkdownGate {
  name: string;
  filePath: string;
  minBytes: number;
}

interface RawGate {
  name: string;
  filePath: string;
  maxAgeHours: number;
  minPages: number;
  seedUrls: string[];
  minSeedSuccessRate: number;
  allowedHost?: string;
  allowedHosts?: string[];
  requireDetail: boolean;
  enforceSeedCoverage: boolean;
}

interface DataQualityOptions {
  includeRaw?: boolean;
  enforceProvenance?: boolean;
}

function readJson(filePath: string): unknown {
  const raw = fs.readFileSync(filePath, 'utf-8');
  return JSON.parse(raw);
}

function getAgeHours(filePath: string): number {
  const stats = fs.statSync(filePath);
  return (Date.now() - stats.mtimeMs) / (1000 * 60 * 60);
}

function normalizeUrl(raw: string): string {
  const parsed = new URL(raw);
  parsed.hash = '';
  return parsed.toString();
}

function hasSuccessfulStatus(statusCode: number | null): boolean {
  return statusCode !== null && statusCode >= 200 && statusCode < 400;
}

function runSourceGate<T>(gate: SourceGate<T>, errors: string[], warnings: string[]): void {
  if (!fs.existsSync(gate.filePath)) {
    const message = `${gate.name}: missing file ${gate.filePath}`;
    if (gate.optional) {
      warnings.push(message);
      return;
    }
    errors.push(message);
    return;
  }

  try {
    const input = readJson(gate.filePath);
    const data = gate.validator(input);
    const count = gate.count(data);
    if (count < gate.minItems) {
      errors.push(`${gate.name}: expected at least ${gate.minItems} records but found ${count}`);
    }
    if (
      gate.preserveTopLevelCount &&
      Array.isArray(input) &&
      input.length !== count
    ) {
      errors.push(
        `${gate.name}: schema rejected ${input.length - count} top-level record(s)`
      );
    }
    for (const issue of gate.quality?.(data) ?? []) {
      errors.push(`${gate.name}: ${issue}`);
    }

    const ageHours = getAgeHours(gate.filePath);
    if (ageHours > gate.maxAgeHours) {
      const message = `${gate.name}: data is stale (${ageHours.toFixed(1)}h old, max ${gate.maxAgeHours}h)`;
      if (gate.optional) {
        warnings.push(message);
      } else {
        errors.push(message);
      }
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    const formatted = `${gate.name}: validation failed (${message})`;
    // Optional means absence/staleness is tolerated. If an optional artifact
    // is present, invalid or contaminated content must still fail closed.
    errors.push(formatted);
  }
}

function runMarkdownGate(gate: MarkdownGate, errors: string[]): void {
  if (!fs.existsSync(gate.filePath)) {
    errors.push(`${gate.name}: missing markdown output ${gate.filePath}`);
    return;
  }

  const bytes = fs.statSync(gate.filePath).size;
  if (bytes < gate.minBytes) {
    errors.push(
      `${gate.name}: markdown output is too small (${bytes} bytes, expected >= ${gate.minBytes})`
    );
  }
}

function runRawGate(gate: RawGate, errors: string[]): void {
  if (!fs.existsSync(gate.filePath)) {
    errors.push(`${gate.name}: missing file ${gate.filePath}`);
    return;
  }

  let dataset: ReturnType<typeof validateRawDatasetV1>;
  try {
    dataset = validateRawDatasetV1(readJson(gate.filePath));
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    errors.push(`${gate.name}: schema validation failed (${message})`);
    return;
  }

  const successfulPages = dataset.pages.filter((page) =>
    hasSuccessfulStatus(page.statusCode)
  );
  if (successfulPages.length < gate.minPages) {
    errors.push(
      `${gate.name}: expected at least ${gate.minPages} successful pages but found ${successfulPages.length}`
    );
  }

  for (const page of dataset.pages) {
    const challenge = challengeContentLabel(JSON.stringify(page));
    if (challenge) {
      errors.push(`${gate.name}: browser challenge content found at ${page.url} (${challenge})`);
    }
  }

  const ageHours = getAgeHours(gate.filePath);
  if (ageHours > gate.maxAgeHours) {
    errors.push(
      `${gate.name}: data is stale (${ageHours.toFixed(1)}h old, max ${gate.maxAgeHours}h)`
    );
  }

  const allowedHosts = new Set([
    ...(gate.allowedHosts ?? []),
    ...(gate.allowedHost ? [gate.allowedHost] : []),
  ]);
  if (allowedHosts.size > 0) {
    const invalidPage = dataset.pages.find((page) => {
      try {
        return !allowedHosts.has(new URL(page.url).host);
      } catch {
        return true;
      }
    });

    if (invalidPage) {
      errors.push(
        `${gate.name}: found page outside allowed hosts ${Array.from(allowedHosts).join(', ')} (${invalidPage.url})`
      );
    }
  }

  if (
    gate.requireDetail &&
    !successfulPages.some((page) => page.sourceType === 'detail')
  ) {
    errors.push(`${gate.name}: expected at least one successful detail page`);
  }

  if (gate.enforceSeedCoverage) {
    const normalizedSeeds = gate.seedUrls.map((url) => normalizeUrl(url));
    const pageMap = new Map(dataset.pages.map((page) => [normalizeUrl(page.url), page]));

    const missingSeeds = normalizedSeeds.filter((seed) => !pageMap.has(seed));
    if (missingSeeds.length > 0) {
      errors.push(`${gate.name}: missing seed pages (${missingSeeds.join(', ')})`);
    }

    const successfulSeeds = normalizedSeeds.filter((seed) => {
      const page = pageMap.get(seed);
      return page ? hasSuccessfulStatus(page.statusCode) : false;
    }).length;

    const successRate = normalizedSeeds.length === 0 ? 1 : successfulSeeds / normalizedSeeds.length;
    if (successRate < gate.minSeedSuccessRate) {
      errors.push(
        `${gate.name}: seed success rate ${(successRate * 100).toFixed(1)}% is below ${(gate.minSeedSuccessRate * 100).toFixed(0)}%`
      );
    }
  }
}

function runEventDetailCoverageGate(cwd: string, errors: string[]): void {
  const eventPath = path.join(cwd, 'data', 'raw', 'events.raw.json');
  const detailPath = path.join(cwd, 'data', 'raw', 'events-detail.raw.json');
  if (!fs.existsSync(eventPath)) {
    errors.push(`events.raw.json: missing file ${eventPath}`);
    return;
  }
  if (!fs.existsSync(detailPath)) return;

  try {
    const events = validateArchwayEvents(readJson(eventPath));
    const details = validateRawDatasetV1(readJson(detailPath));
    for (const issue of eventDetailCoverageErrors(events, details)) {
      errors.push(`events-detail.raw.json: ${issue}`);
    }
  } catch (error) {
    errors.push(
      `events-detail.raw.json: cross-artifact validation failed (${
        error instanceof Error ? error.message : String(error)
      })`
    );
  }
}

function runProvenanceGate(
  cwd: string,
  errors: string[],
  warnings: string[],
  enforce: boolean
): void {
  const states = evaluateSourceProvenance(
    SOURCES,
    new Date(),
    path.join(cwd, 'data', 'raw')
  );
  for (const state of states) {
    if (state.status !== 'stale' && state.status !== 'unknown') continue;
    const message =
      state.status === 'stale'
        ? `Source ${state.key} is stale: ${state.detail}`
        : `Source ${state.key} has unknown collection age: ${state.detail}`;
    (enforce ? errors : warnings).push(message);
  }
}

export function buildRawGates(cwd: string): RawGate[] {
  return [
    {
      name: 'transportation.raw.json',
      filePath: path.join(cwd, 'data', 'raw', 'transportation.raw.json'),
      maxAgeHours: 168,
      minPages: 4,
      seedUrls: [
        'https://www.ramapo.edu/csi/commuter-affairs/',
        'https://www.ramapo.edu/csi/commuter-affairs/commuter-resources/',
        'https://www.ramapo.edu/about/transportation-services/',
      ],
      minSeedSuccessRate: 0.75,
      allowedHost: 'www.ramapo.edu',
      requireDetail: true,
      enforceSeedCoverage: true,
    },
    {
      name: 'directory.raw.json',
      filePath: path.join(cwd, 'data', 'raw', 'directory.raw.json'),
      maxAgeHours: 168,
      minPages: 2,
      seedUrls: ['https://www.ramapo.edu/campus-directory/', 'https://www.ramapo.edu/about/phone/'],
      minSeedSuccessRate: 0.75,
      allowedHost: 'www.ramapo.edu',
      requireDetail: false,
      enforceSeedCoverage: true,
    },
    {
      name: 'housing.raw.json',
      filePath: path.join(cwd, 'data', 'raw', 'housing.raw.json'),
      maxAgeHours: 168,
      minPages: 1,
      seedUrls: ['https://www.ramapo.edu/reslife/'],
      minSeedSuccessRate: 0.75,
      allowedHost: 'www.ramapo.edu',
      requireDetail: true,
      enforceSeedCoverage: true,
    },
    {
      name: 'health.raw.json',
      filePath: path.join(cwd, 'data', 'raw', 'health.raw.json'),
      maxAgeHours: 168,
      minPages: 2,
      seedUrls: [
        'https://www.ramapo.edu/health/',
        'https://www.valleyhealth.com/ramapo-college-health-services',
      ],
      minSeedSuccessRate: 1,
      allowedHosts: ['www.ramapo.edu', 'www.valleyhealth.com'],
      // Ramapo delegates clinical and appointment details to its official
      // Valley Medical Group partner page, which is collected as a seed.
      requireDetail: false,
      enforceSeedCoverage: true,
    },
    {
      name: 'counseling.raw.json',
      filePath: path.join(cwd, 'data', 'raw', 'counseling.raw.json'),
      maxAgeHours: 168,
      minPages: 1,
      seedUrls: ['https://www.ramapo.edu/counseling/'],
      minSeedSuccessRate: 0.75,
      allowedHost: 'www.ramapo.edu',
      requireDetail: true,
      enforceSeedCoverage: true,
    },
    {
      name: 'safety.raw.json',
      filePath: path.join(cwd, 'data', 'raw', 'safety.raw.json'),
      maxAgeHours: 168,
      minPages: 1,
      seedUrls: ['https://www.ramapo.edu/publicsafety/'],
      minSeedSuccessRate: 0.75,
      allowedHost: 'www.ramapo.edu',
      requireDetail: true,
      enforceSeedCoverage: true,
    },
    {
      name: 'events-detail.raw.json',
      filePath: path.join(cwd, 'data', 'raw', 'events-detail.raw.json'),
      maxAgeHours: 168,
      minPages: 10,
      seedUrls: ['https://archway.ramapo.edu/events'],
      minSeedSuccessRate: 0,
      allowedHost: 'archway.ramapo.edu',
      requireDetail: true,
      enforceSeedCoverage: false,
    },
    {
      name: 'clubs-detail.raw.json',
      filePath: path.join(cwd, 'data', 'raw', 'clubs-detail.raw.json'),
      maxAgeHours: 168,
      minPages: 10,
      seedUrls: ['https://archway.ramapo.edu/club_signup?view=all&'],
      minSeedSuccessRate: 0,
      allowedHost: 'archway.ramapo.edu',
      requireDetail: true,
      enforceSeedCoverage: false,
    },
  ];
}

export function runRawDataQualityGates(cwd = process.cwd()): void {
  const errors: string[] = [];
  buildRawGates(cwd).forEach((gate) => runRawGate(gate, errors));
  runEventDetailCoverageGate(cwd, errors);
  runProvenanceGate(cwd, errors, [], true);

  if (errors.length > 0) {
    const joined = errors.map((error) => `- ${error}`).join('\n');
    throw new Error(`Raw quality gates failed:\n${joined}`);
  }
}

export function runDataQualityGates(cwd = process.cwd(), options: DataQualityOptions = {}): void {
  const errors: string[] = [];
  const warnings: string[] = [];

  const sourceGates: Array<SourceGate<unknown>> = [
    {
      name: 'menu.json',
      filePath: path.join(cwd, 'data', 'normalized', 'menu.json'),
      maxAgeHours: 72,
      minItems: 1,
      validator: validateMenuData,
      count: (data) => (data as ReturnType<typeof validateMenuData>).length,
      preserveTopLevelCount: true,
    },
    {
      name: 'dining-hours.json',
      filePath: path.join(cwd, 'data', 'normalized', 'dining-hours.json'),
      maxAgeHours: 72,
      minItems: 1,
      validator: validateDiningHoursState,
      count: (data) => countDiningLocations(data as ReturnType<typeof validateDiningHoursState>),
    },
    {
      name: 'events.json',
      filePath: path.join(cwd, 'data', 'normalized', 'events.json'),
      maxAgeHours: 72,
      minItems: 1,
      validator: validateArchwayEvents,
      count: (data) => (data as ReturnType<typeof validateArchwayEvents>).length,
      preserveTopLevelCount: true,
      quality: eventQualityErrors,
    },
    {
      name: 'hours.json',
      filePath: path.join(cwd, 'data', 'normalized', 'hours.json'),
      maxAgeHours: 168,
      minItems: 1,
      validator: validateCampusHours,
      count: (data) => (data as ReturnType<typeof validateCampusHours>).length,
      preserveTopLevelCount: true,
    },
    {
      name: 'clubs.json',
      filePath: path.join(cwd, 'data', 'normalized', 'clubs.json'),
      maxAgeHours: 168,
      minItems: 1,
      validator: validateArchwayClubs,
      count: (data) => (data as ReturnType<typeof validateArchwayClubs>).length,
      preserveTopLevelCount: true,
    },
    {
      name: 'calendar.json',
      filePath: path.join(cwd, 'data', 'normalized', 'calendar.json'),
      maxAgeHours: 2160,
      minItems: 1,
      validator: validateAcademicCalendar,
      count: (data) => (data as ReturnType<typeof validateAcademicCalendar>).length,
      optional: true,
      preserveTopLevelCount: true,
    },
    {
      name: 'faculty.json',
      filePath: path.join(cwd, 'data', 'normalized', 'faculty.json'),
      maxAgeHours: 2160,
      minItems: 1,
      validator: validateFacultyProfiles,
      count: (data) => (data as ReturnType<typeof validateFacultyProfiles>).length,
      optional: true,
      preserveTopLevelCount: true,
      quality: facultyQualityErrors,
    },
  ];

  const markdownGates: MarkdownGate[] = [
    {
      name: 'menu.md',
      filePath: path.join(cwd, 'data', 'context', 'dining', 'menu.md'),
      minBytes: 100,
    },
    {
      name: 'dining hours.md',
      filePath: path.join(cwd, 'data', 'context', 'dining', 'hours.md'),
      minBytes: 100,
    },
    {
      name: 'live-events.md',
      filePath: path.join(cwd, 'data', 'context', 'campus', 'live-events.md'),
      minBytes: 50,
    },
    {
      name: 'campus hours.md',
      filePath: path.join(cwd, 'data', 'context', 'campus', 'hours.md'),
      minBytes: 100,
    },
    {
      name: 'clubs.md',
      filePath: path.join(cwd, 'data', 'context', 'campus', 'clubs.md'),
      minBytes: 100,
    },
  ];

  sourceGates.forEach((gate) => runSourceGate(gate, errors, warnings));
  markdownGates.forEach((gate) => runMarkdownGate(gate, errors));
  errors.push(...collectPublishableArtifactErrors(cwd));

  if (options.includeRaw !== false) {
    const rawErrors: string[] = [];
    buildRawGates(cwd).forEach((gate) => runRawGate(gate, rawErrors));
    runEventDetailCoverageGate(cwd, rawErrors);
    errors.push(...rawErrors);
  }
  runProvenanceGate(cwd, errors, warnings, options.enforceProvenance !== false);

  if (warnings.length > 0) {
    console.warn('Quality gate warnings:');
    warnings.forEach((warning) => console.warn(`- ${warning}`));
  }

  if (errors.length > 0) {
    const joined = errors.map((error) => `- ${error}`).join('\n');
    throw new Error(`Quality gates failed:\n${joined}`);
  }
}

if (path.basename(process.argv[1] ?? '') === 'quality-gates.ts') {
  const runRawOnly = process.argv.includes('--raw');
  const includeRaw = !process.argv.includes('--normalized-only');

  try {
    if (runRawOnly) {
      runRawDataQualityGates();
      console.log('Raw quality gates passed.');
    } else {
      runDataQualityGates(process.cwd(), { includeRaw });
      console.log('Data quality gates passed.');
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exit(1);
  }
}
