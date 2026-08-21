import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { SOURCES } from '../src/data-v2/source-seeds';
import { restoreActiveRelease } from '../pipeline/restore-active-release';
import { facultyQualityErrors } from '../pipeline/quality/content-policy';
import {
  evaluateSourceProvenance,
  SOURCE_RAW_DATASETS,
  type SourceProvenanceState,
} from '../pipeline/quality/provenance';
import { validateFacultyProfiles } from './schema';
import { hoursValidityErrors } from '../src/data-v2/validity';

/**
 * Collector commands that can renew each non-static publishable source.
 * A source with multiple datasets runs every contributing collector so one
 * successful scrape cannot conceal another stale publication input.
 */
export const SOURCE_REFRESH_SCRIPTS: Record<string, string[]> = {
  'public-safety': ['fetch:safety:raw'],
  'academic-calendar': ['fetch:calendar'],
  dining: ['fetch:menu', 'fetch:dining-hours'],
  'campus-hours': ['fetch:hours'],
  'archway-events': ['fetch:events:live'],
  'archway-clubs': ['fetch:clubs'],
  'academic-programs': ['fetch:programs:catalog'],
  'campus-directory': ['fetch:directory:raw'],
  transportation: ['fetch:transportation:raw'],
  housing: ['fetch:housing:raw'],
  health: ['fetch:health:raw'],
  counseling: ['fetch:counseling:raw'],
  faculty: ['fetch:faculty'],
};

// The workflow runs daily. Renew a source that would cross its SLA before
// the next run; otherwise a source at 23.9h could pass a 24h gate, skip its
// daily refresh, and become stale minutes after activation.
export const REFRESH_HORIZON_HOURS = 24;

export function refreshScriptsForStates(
  states: ReadonlyArray<Pick<SourceProvenanceState, 'key' | 'status' | 'ageHours' | 'maxAgeHours'>>,
  refreshHorizonHours = REFRESH_HORIZON_HOURS
): string[] {
  const scripts = states
    .filter(
      (state) =>
        state.status === 'stale' ||
        state.status === 'unknown' ||
        (state.status === 'fresh' &&
          state.ageHours !== null &&
          state.maxAgeHours - state.ageHours <= refreshHorizonHours)
    )
    .flatMap((state) => {
      const configured = SOURCE_REFRESH_SCRIPTS[state.key];
      if (!configured) {
        throw new Error(`No refresh command is configured for publishable source ${state.key}.`);
      }
      return configured;
    });
  return [...new Set(scripts)];
}

/**
 * A release can have fresh raw provenance while its restored normalized
 * artifacts predate stricter schema/content gates. Recollect those sources
 * with the current collector instead of weakening publication validation.
 */
export function facultyArtifactRequiresRefresh(input: unknown): boolean {
  if (!Array.isArray(input)) return true;
  try {
    const validated = validateFacultyProfiles(input);
    return validated.length !== input.length || facultyQualityErrors(input).length > 0;
  } catch {
    return true;
  }
}

/**
 * Hours whose own note says they stopped applying need recollecting, and no
 * age check will ever ask for it: freshness measures when a source was
 * collected, not whether what it collected still applies. Campus hours are
 * collected twice a year, so a schedule that expired in May stays "fresh" for
 * months while the publication gate rejects it every single day — the refresh
 * that would fix it never runs, and nothing publishes until someone notices.
 */
export function hoursArtifactRequiresRefresh(input: unknown, now = new Date()): boolean {
  if (input === undefined) return true;
  return hoursValidityErrors(input, now).errors.length > 0;
}

export function refreshScriptsForArtifactCompatibility(
  artifacts: Readonly<{ faculty?: unknown; hours?: unknown }>,
  now = new Date()
): string[] {
  return [
    ...(facultyArtifactRequiresRefresh(artifacts.faculty)
      ? SOURCE_REFRESH_SCRIPTS.faculty
      : []),
    ...(hoursArtifactRequiresRefresh(artifacts.hours, now)
      ? SOURCE_REFRESH_SCRIPTS['campus-hours']
      : []),
  ];
}

function readNormalized(cwd: string, name: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(path.join(cwd, 'data', 'normalized', name), 'utf8')) as unknown;
  } catch {
    // Unreadable reads as "needs recollecting", which is what each check does
    // with an undefined artifact.
    return undefined;
  }
}

function restoredArtifactCompatibilityScripts(cwd = process.cwd()): string[] {
  return refreshScriptsForArtifactCompatibility({
    faculty: readNormalized(cwd, 'faculty.json'),
    hours: readNormalized(cwd, 'hours.json'),
  });
}

function runNpmScript(script: string, rawOnly: boolean): void {
  console.log(`\n=== npm run ${script} ===`);
  const result = spawnSync('npm', ['run', script], {
    cwd: process.cwd(),
    stdio: 'inherit',
    env: {
      ...process.env,
      ...(rawOnly ? { RAW_ONLY: '1' } : {}),
      ...(script === 'fetch:events:live' ? { EVENTS_FORCE_SCRAPE: '1' } : {}),
    },
  });
  if (result.status !== 0) {
    throw new Error(`npm run ${script} failed with exit code ${result.status ?? 'unknown'}.`);
  }
}

function assertRefreshCoverage(): void {
  const required = Object.keys(SOURCE_RAW_DATASETS).sort();
  const configured = Object.keys(SOURCE_REFRESH_SCRIPTS).sort();
  if (JSON.stringify(required) !== JSON.stringify(configured)) {
    throw new Error(
      `Refresh coverage does not match provenance sources. Required: ${required.join(', ')}; ` +
        `configured: ${configured.join(', ')}.`
    );
  }
}

export async function main(): Promise<void> {
  assertRefreshCoverage();
  const restored = await restoreActiveRelease({ requireRawArtifacts: true });
  console.log(
    `Bootstrapped ${restored.version}: ${restored.artifactFilesWritten} release artifact file(s), ` +
      `${restored.documentsRestored} context document(s), and ${restored.rawFilesRestored} raw file(s) ` +
      `for ${restored.rawSourcesRestored} source(s).`
  );
  const before = evaluateSourceProvenance(SOURCES);
  const provenanceScripts = refreshScriptsForStates(before);
  const compatibilityScripts = restoredArtifactCompatibilityScripts();
  if (compatibilityScripts.length) {
    console.log(
      `Restored artifacts require current collector output: ${compatibilityScripts.join(', ')}.`
    );
  }
  const scripts = [...new Set([...provenanceScripts, ...compatibilityScripts])];

  if (scripts.length) {
    console.log(
      `Refreshing ${scripts.length} collector(s) for source provenance or artifact compatibility.`
    );
    // Collector-owned normalization preserves enrichment from detail pages,
    // public APIs, and source-specific merging that the generic validator
    // cannot reconstruct from the primary raw file alone.
    for (const script of scripts) runNpmScript(script, false);
  } else {
    console.log('All publishable source provenance is fresh; no collection needed.');
  }

  const after = evaluateSourceProvenance(SOURCES);
  const nonFresh = after.filter((state) => state.status === 'stale' || state.status === 'unknown');
  if (nonFresh.length) {
    throw new Error(
      `Collection finished without fresh provenance for: ${nonFresh
        .map((state) => `${state.key} (${state.detail})`)
        .join('; ')}`
    );
  }

  // Normalize the raw-only sources. Collector-managed artifacts are preserved
  // because their transforms combine multiple raw inputs (for example event
  // detail signals and club detail pages) rather than merely validating the
  // primary raw JSON file.
  runNpmScript('quality:raw', false);
  const previousExclude = process.env.NORMALIZE_RAW_EXCLUDE_COLLECTOR_MANAGED;
  process.env.NORMALIZE_RAW_EXCLUDE_COLLECTOR_MANAGED = '1';
  try {
    runNpmScript('normalize:raw', false);
  } finally {
    if (previousExclude === undefined) {
      delete process.env.NORMALIZE_RAW_EXCLUDE_COLLECTOR_MANAGED;
    } else {
      process.env.NORMALIZE_RAW_EXCLUDE_COLLECTOR_MANAGED = previousExclude;
    }
  }
  runNpmScript('generate:context', false);
}

if (process.argv[1]?.endsWith('refresh-publishable.ts')) {
  void main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
