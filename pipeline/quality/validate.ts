import fs from 'fs';
import path from 'path';
import {
  validateAcademicCalendar,
  validateArchwayClubs,
  validateArchwayEvents,
  validateCampusHours,
  validateFacultyProfiles,
  validateMenuData,
} from '../../ingestion/schema';
import { unparseableEventStarts } from '../../src/data-v2/event-time';
import { SOURCES } from '../../src/data-v2/source-seeds';
import {
  collectPublishableArtifactErrors,
  eventDetailCoverageErrors,
  eventQualityErrors,
  facultyQualityErrors,
} from './content-policy';
import {
  evaluateSourceProvenance,
  type SourceProvenanceState,
} from './provenance';
import { hoursValidityErrors } from '../../src/data-v2/validity';

export interface QualitySummaryV2 {
  passed: boolean;
  checkedAt: string;
  recordCounts: Record<string, number>;
  errors: string[];
  warnings: string[];
  /** Per-source collection provenance (PROB-002); unknown age is null. */
  sources: SourceProvenanceState[];
}

export interface QualityOptionsV2 {
  enforceFreshness?: boolean;
  /**
   * Treat stale or unknown source provenance as errors. This defaults to true
   * because a passing quality result certifies publishability. Explicitly set
   * false only for a reporting view that must surface non-fresh states without
   * certifying the dataset.
   */
  enforceProvenance?: boolean;
  /** Override the repository root for deterministic fixture tests. */
  cwd?: string;
  /** Override the clock for deterministic freshness/provenance tests. */
  now?: Date;
}

const REQUIRED_FILES = [
  'data/normalized/menu.json',
  'data/normalized/hours.json',
  'data/normalized/calendar.json',
  'data/normalized/events.json',
  'data/normalized/clubs.json',
  'data/normalized/faculty.json',
  '../ui/public/data/courses.json',
  '../ui/public/data/programs.json',
] as const;

const MAX_AGE_HOURS: Partial<Record<(typeof REQUIRED_FILES)[number], number>> = {
  'data/normalized/menu.json': 36,
  'data/normalized/hours.json': 4_320,
  'data/normalized/calendar.json': 4_320,
  'data/normalized/events.json': 36,
  'data/normalized/clubs.json': 4_320,
  'data/normalized/faculty.json': 720,
  '../ui/public/data/courses.json': 4_320,
  '../ui/public/data/programs.json': 4_320,
};

const MIN_RECORD_COUNTS: Partial<Record<(typeof REQUIRED_FILES)[number], number>> = {
  'data/normalized/menu.json': 1,
  'data/normalized/hours.json': 10,
  'data/normalized/calendar.json': 3,
  'data/normalized/events.json': 1,
  'data/normalized/clubs.json': 100,
  'data/normalized/faculty.json': 150,
  '../ui/public/data/courses.json': 1_000,
  '../ui/public/data/programs.json': 50,
};

const CRITICAL_FACT_KEYS = [
  'safety.emergency_phone',
  'safety.non_emergency_phone',
  'safety.id_card_room_phone',
  'safety.id_card_room_location',
  'safety.id_card_room_email',
  'password.reset_url',
  'tuition.nj_12_18_semester',
  'calendar.spring2026.add_drop_100_refund.full',
  'shuttle.ramsey_route17.express.first_departure',
  'shuttle.ramsey_route17.express.last_dropoff',
] as const;

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readJson(relativePath: string, cwd: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(cwd, relativePath), 'utf8')) as unknown;
}

function countTopLevel(value: unknown): number {
  if (Array.isArray(value)) return value.length;
  if (value && typeof value === 'object') return Object.keys(value).length;
  return 0;
}

function countDataset(relativePath: (typeof REQUIRED_FILES)[number], value: unknown): number {
  if (
    relativePath === '../ui/public/data/programs.json' &&
    value &&
    typeof value === 'object'
  ) {
    const totalPrograms = (value as { totalPrograms?: unknown }).totalPrograms;
    if (typeof totalPrograms === 'number' && Number.isFinite(totalPrograms)) {
      return totalPrograms;
    }
  }
  return countTopLevel(value);
}

function containsMalformedContent(value: unknown): boolean {
  const text = JSON.stringify(value);
  return /(?:<br\s*\/?>|&lt;br|;br&gt;|browserContext|sessionStorage|__VIEWSTATE)/i.test(text);
}

function schemaErrors(
  relativePath: (typeof REQUIRED_FILES)[number],
  value: unknown
): string[] {
  const errors: string[] = [];
  const requireArrayPreservation = (
    validator: (input: unknown) => unknown[],
    label: string
  ): void => {
    const validated = validator(value);
    if (Array.isArray(value) && validated.length !== value.length) {
      errors.push(
        `${label} schema rejected ${value.length - validated.length} top-level record(s)`
      );
    }
  };

  if (relativePath === 'data/normalized/menu.json') {
    requireArrayPreservation(validateMenuData, 'Menu');
  } else if (relativePath === 'data/normalized/hours.json') {
    requireArrayPreservation(validateCampusHours, 'Campus hours');
  } else if (relativePath === 'data/normalized/calendar.json') {
    requireArrayPreservation(validateAcademicCalendar, 'Academic calendar');
  } else if (relativePath === 'data/normalized/events.json') {
    requireArrayPreservation(validateArchwayEvents, 'Events');
    errors.push(...eventQualityErrors(value));
  } else if (relativePath === 'data/normalized/clubs.json') {
    requireArrayPreservation(validateArchwayClubs, 'Clubs');
  } else if (relativePath === 'data/normalized/faculty.json') {
    requireArrayPreservation(validateFacultyProfiles, 'Faculty');
    errors.push(...facultyQualityErrors(value));
  } else if (relativePath === '../ui/public/data/courses.json') {
    if (!isRecord(value)) {
      errors.push('Course catalog must be an object keyed by course code');
    } else {
      let missingCode = 0;
      let missingName = 0;
      let mismatchedCode = 0;
      const recordCodes = new Set<string>();
      let duplicateRecordCodes = 0;
      for (const [key, course] of Object.entries(value)) {
        if (!isRecord(course)) {
          missingCode += 1;
          continue;
        }
        const code = typeof course.code === 'string' ? course.code.trim() : '';
        const name = typeof course.name === 'string' ? course.name.trim() : '';
        if (!code) missingCode += 1;
        if (!name) missingName += 1;
        if (code && code !== key) mismatchedCode += 1;
        if (code && recordCodes.has(code)) duplicateRecordCodes += 1;
        if (code) recordCodes.add(code);
      }
      if (missingCode) errors.push(`Course catalog has ${missingCode} record(s) without a code`);
      if (missingName) errors.push(`Course catalog has ${missingName} record(s) without a name`);
      if (mismatchedCode) {
        errors.push(`Course catalog has ${mismatchedCode} key/code mismatch(es)`);
      }
      if (duplicateRecordCodes) {
        errors.push(`Course catalog has ${duplicateRecordCodes} duplicate course code(s)`);
      }
      // Course names intentionally are not unique: transfer electives,
      // independent studies, and cross-listed offerings legitimately repeat.
    }
  } else if (relativePath === '../ui/public/data/programs.json') {
    if (!isRecord(value) || !Array.isArray(value.schools)) {
      errors.push('Program catalog must contain a schools array');
    } else {
      let invalidPrograms = 0;
      let duplicateCatalogCodes = 0;
      const catalogCodes = new Set<string>();
      const programs = value.schools.flatMap((school) =>
        isRecord(school) && Array.isArray(school.majors) ? school.majors : []
      );
      for (const program of programs) {
        if (!isRecord(program)) {
          invalidPrograms += 1;
          continue;
        }
        const required = [program.name, program.degree, program.type, program.url];
        if (
          required.some(
            (entry) => typeof entry !== 'string' || entry.trim().length === 0
          )
        ) {
          invalidPrograms += 1;
        }
        const catalogCode =
          typeof program.catalogCode === 'string' ? program.catalogCode.trim() : '';
        if (catalogCode && catalogCodes.has(catalogCode)) duplicateCatalogCodes += 1;
        if (catalogCode) catalogCodes.add(catalogCode);
      }
      if (invalidPrograms) {
        errors.push(`Program catalog has ${invalidPrograms} invalid program record(s)`);
      }
      if (duplicateCatalogCodes) {
        errors.push(`Program catalog has ${duplicateCatalogCodes} duplicate catalog code(s)`);
      }
      if (
        typeof value.totalPrograms !== 'number' ||
        !Number.isFinite(value.totalPrograms) ||
        value.totalPrograms !== programs.length
      ) {
        errors.push(
          `Program catalog totalPrograms does not match flattened program count (${String(
            value.totalPrograms
          )} vs ${programs.length})`
        );
      }
    }
  }

  return errors;
}

export function validateCurrentDatasetV2(
  criticalFacts: Record<string, string>,
  options: QualityOptionsV2 = {}
): QualitySummaryV2 {
  const errors: string[] = [];
  const warnings: string[] = [];
  const recordCounts: Record<string, number> = {};
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const now = options.now ?? new Date();
  const enforceProvenance = options.enforceProvenance !== false;

  for (const relativePath of REQUIRED_FILES) {
    const fullPath = path.join(cwd, relativePath);
    if (!fs.existsSync(fullPath)) {
      errors.push(`Missing required dataset: ${relativePath}`);
      continue;
    }
    try {
      const data = readJson(relativePath, cwd);
      const count = countDataset(relativePath, data);
      recordCounts[relativePath] = count;
      const minimum = MIN_RECORD_COUNTS[relativePath] ?? 1;
      if (count < minimum) {
        errors.push(
          `Dataset has too few records: ${relativePath} has ${count} (minimum ${minimum})`
        );
      }
      if (options.enforceFreshness) {
        const ageHours = (now.getTime() - fs.statSync(fullPath).mtimeMs) / 3_600_000;
        const maxAgeHours = MAX_AGE_HOURS[relativePath];
        if (maxAgeHours && ageHours > maxAgeHours) {
          errors.push(
            `Dataset is stale: ${relativePath} is ${ageHours.toFixed(1)}h old (max ${maxAgeHours}h)`
          );
        }
      }
      if (containsMalformedContent(data)) {
        errors.push(`Malformed HTML or browser metadata found in ${relativePath}`);
      }
      errors.push(...schemaErrors(relativePath, data));
    } catch (error) {
      errors.push(
        `Invalid JSON in ${relativePath}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  for (const key of CRITICAL_FACT_KEYS) {
    if (!criticalFacts[key]?.trim()) errors.push(`Missing required critical fact: ${key}`);
  }

  // PROB-011: every publishable event needs a deterministic start timestamp.
  // A parse failure here blocks activation instead of silently publishing a
  // permanently eligible NULL starts_at.
  try {
    const events = readJson('data/normalized/events.json', cwd);
    if (Array.isArray(events)) {
      for (const failure of unparseableEventStarts(events as Array<Record<string, unknown>>)) {
        errors.push(
          `Event start is unparseable: "${failure.title}" (${failure.dateLabel}) — ${failure.reason}`
        );
      }
    }
  } catch {
    // Missing or invalid events.json is already reported by the file loop.
  }

  // Hours state their own applicability in a free-text note. Freshness only
  // measures collection time, so a schedule that expired last semester passes
  // every age check; this is the content-side counterpart.
  try {
    const hours = readJson('data/normalized/hours.json', cwd);
    const validity = hoursValidityErrors(hours, now);
    errors.push(...validity.errors);
    warnings.push(...validity.warnings);
  } catch {
    // Missing or invalid hours.json is already reported by the file loop.
  }

  try {
    const events = readJson('data/normalized/events.json', cwd);
    const detailPages = readJson('data/raw/events-detail.raw.json', cwd);
    errors.push(...eventDetailCoverageErrors(events, detailPages));
  } catch {
    // Raw artifact presence/provenance is enforced below. This cross-artifact
    // check only runs when both inputs are readable.
  }

  errors.push(...collectPublishableArtifactErrors(cwd));

  const contextRoot = path.join(cwd, 'data/context');
  const markdownFiles = fs.existsSync(contextRoot)
    ? fs.readdirSync(contextRoot, { recursive: true }).filter((entry) => String(entry).endsWith('.md'))
    : [];
  recordCounts.documents = markdownFiles.length;
  if (markdownFiles.length < 10) errors.push('Expected at least 10 clean context documents.');

  // PROB-002: source-native provenance. Filesystem mtime is not source
  // truth; a source without a valid collector-written sidecar has unknown
  // age, and unknown is never rendered as zero hours.
  const sourceStates = evaluateSourceProvenance(
    SOURCES,
    now,
    path.join(cwd, 'data/raw')
  );
  for (const state of sourceStates) {
    if (state.status === 'stale') {
      const message =
        `Source ${state.key} is stale: ${state.detail}. ` +
        'Refresh the source before publishing.';
      (enforceProvenance ? errors : warnings).push(message);
    } else if (state.status === 'unknown') {
      const message =
        `Source ${state.key} has unknown collection age (${state.detail}). ` +
        'Unknown age is not zero; a collector-written provenance sidecar is required to publish.';
      (enforceProvenance ? errors : warnings).push(message);
    }
  }

  const uniqueErrors = Array.from(new Set(errors));
  return {
    passed: uniqueErrors.length === 0,
    checkedAt: now.toISOString(),
    recordCounts,
    errors: uniqueErrors,
    warnings,
    sources: sourceStates,
  };
}

export function assertQualityV2(summary: QualitySummaryV2): void {
  if (!summary.passed) {
    throw new Error(`V2 quality gates failed:\n- ${summary.errors.join('\n- ')}`);
  }
}
