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
import { partitionHoursForPublication } from '../src/data-v2/validity';
import { hoursSourceErrors } from '../pipeline/quality/hours-coverage';
import {
  groupScriptsBySource,
  KEPT_SOURCES_REPORT,
  keptSourcesReport,
  runIsolatedRefresh,
  type KeptSource,
} from './refresh-isolation';

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
  'campus-directory': ['fetch:directory:raw', 'fetch:reviewed-contacts', 'fetch:reviewed-contact-documents'],
  transportation: ['fetch:transportation:raw'],
  housing: ['fetch:housing:raw'],
  health: ['fetch:health:raw'],
  counseling: ['fetch:counseling:raw'],
  faculty: ['fetch:faculty'],
  'graduation-plans': ['fetch:graduation-plans'],
  'major-pages': ['fetch:major-pages'],
  // Reads the program pages' links, so it follows fetch:major-pages in source order.
  'major-page-links': ['fetch:major-page-links'],
  // Skips the pages the other Ramapo site collectors keep, so it follows them in source order.
  'office-pages': ['fetch:office-pages'],
  'catalog-policies': ['fetch:catalog-policies'],
  // Skips the office pages as well, so it follows fetch:office-pages in source order.
  'academic-sites': ['fetch:academic-sites'],
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
  if (!Array.isArray(input)) return true;
  return partitionHoursForPublication(input, now).omitted.length > 0;
}

/**
 * A parser change can make the archived pages read differently, as when a stale sidebar
 * year stopped withholding the Research Help Desk's identical hours. The quality gate
 * replays the pages with the current parser and rejects hours collected by the old one,
 * and no age check asks for a recollection, so every daily run would fail until campus
 * hours aged out months later.
 */
export function hoursReplayRequiresRefresh(raw: unknown, sources: unknown): boolean {
  return hoursSourceErrors(raw, sources).length > 0;
}

/**
 * The catalog collector writes a requisites list on every course, empty when the catalog
 * publishes none (Sept 24, 2026), and the real catalog has hundreds of courses with
 * prerequisites (879 of 2,658 on Oct 13). A catalog where no course has one was captured by
 * an older collector: production served a July 16 capture of 3,344 courses, every one with
 * "requisites": [], and the Brain said "CMPS 231 has no published prerequisites" though the
 * catalog lists CMPS 148. The catalog's 180-day freshness would not have recollected it until
 * January.
 */
export function coursesArtifactRequiresRefresh(input: unknown): boolean {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return true;
  const courses = Object.values(input as Record<string, unknown>);
  const requisites = courses.map((course) => course && typeof course === 'object'
    ? (course as { requisites?: unknown }).requisites : undefined);
  return courses.length === 0
    || requisites.some((list) => !Array.isArray(list))
    || !requisites.some((list) => Array.isArray(list) && list.length > 0);
}

export function refreshScriptsForArtifactCompatibility(
  artifacts: Readonly<{ faculty?: unknown; hours?: unknown; hoursRaw?: unknown; hoursSources?: unknown;
    courses?: unknown }>,
  now = new Date()
): string[] {
  const replays = !('hoursSources' in artifacts)
    || !hoursReplayRequiresRefresh(artifacts.hoursRaw, artifacts.hoursSources);
  return [
    ...(facultyArtifactRequiresRefresh(artifacts.faculty)
      ? SOURCE_REFRESH_SCRIPTS.faculty
      : []),
    ...(hoursArtifactRequiresRefresh(artifacts.hours, now) || !replays
      ? SOURCE_REFRESH_SCRIPTS['campus-hours']
      : []),
    // Checked only when the caller passes the catalog's courses.
    ...('courses' in artifacts && coursesArtifactRequiresRefresh(artifacts.courses)
      ? SOURCE_REFRESH_SCRIPTS['academic-programs']
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

function readRaw(cwd: string, name: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(path.join(cwd, 'data', 'raw', name), 'utf8')) as unknown;
  } catch {
    return undefined;
  }
}

function readPublic(cwd: string, name: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(path.join(cwd, 'public', 'data', name), 'utf8')) as unknown;
  } catch {
    return undefined;
  }
}

function restoredArtifactCompatibilityScripts(cwd = process.cwd()): string[] {
  return refreshScriptsForArtifactCompatibility({
    faculty: readNormalized(cwd, 'faculty.json'),
    hours: readNormalized(cwd, 'hours.json'),
    hoursRaw: readRaw(cwd, 'hours.raw.json'),
    hoursSources: readRaw(cwd, 'hours-sources.raw.json'),
    courses: readPublic(cwd, 'courses.json'),
  });
}

function runNpmScript(script: string, rawOnly: boolean): void {
  console.log(`\n=== npm run ${script} ===`);
  const result = spawnSync('npm', ['run', script], {
    cwd: process.cwd(),
    // stderr is read back so a failure can say why (the collector's own message), then echoed.
    stdio: ['inherit', 'inherit', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
    env: {
      ...process.env,
      ...(rawOnly ? { RAW_ONLY: '1' } : {}),
      ...(script === 'fetch:events:live' ? { EVENTS_FORCE_SCRAPE: '1' } : {}),
    },
  });
  const stderr = result.stderr?.toString() ?? '';
  if (stderr) process.stderr.write(stderr);
  if (result.status !== 0) {
    const reason = stderr
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('(node:') && !line.startsWith('(Use `node'))
      .slice(-2)
      .join(' ');
    throw new Error(
      `npm run ${script} failed with exit code ${result.status ?? 'unknown'}.${reason ? ` ${reason}` : ''}`
    );
  }
}

export function assertRefreshCoverage(): void {
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
  const restored = await restoreActiveRelease({ requireRawArtifacts: true, allowIncompleteRawArtifacts: true });
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
  let kept: KeptSource[] = [];

  if (scripts.length) {
    console.log(
      `Refreshing ${scripts.length} collector(s) for source provenance or artifact compatibility.`
    );
    // Collector-owned normalization preserves enrichment from detail pages,
    // public APIs, and source-specific merging that the generic validator
    // cannot reconstruct from the primary raw file alone.
    kept = runIsolatedRefresh({
      rootDir: process.cwd(),
      groups: groupScriptsBySource(scripts, SOURCE_REFRESH_SCRIPTS),
      runScript: (script) => runNpmScript(script, false),
    });
  } else {
    console.log('All publishable source provenance is fresh; no collection needed.');
  }

  const after = evaluateSourceProvenance(SOURCES);
  const nonFresh = after.filter((state) => state.status === 'stale' || state.status === 'unknown');
  if (nonFresh.length) {
    throw new Error(
      `Collection finished without fresh provenance for: ${nonFresh
        .map((state) => {
          const failed = kept.find((entry) => entry.key === state.key);
          return `${state.key} (${state.detail}${failed ? `; its collector failed: ${failed.error}` : ''})`;
        })
        .join('; ')}`
    );
  }
  if (kept.length) {
    fs.mkdirSync(path.dirname(KEPT_SOURCES_REPORT), { recursive: true });
    fs.writeFileSync(KEPT_SOURCES_REPORT, keptSourcesReport(kept, after, restored.version));
    console.log(
      `Kept the active release's copy of ${kept.map((entry) => entry.key).join(', ')}; ` +
        `see ${KEPT_SOURCES_REPORT}.`
    );
  }

  // Rebuild every projection from its complete source capture, including
  // event/club detail pages; never relabel old normalized content as fresh.
  runNpmScript('quality:raw', false);
  runNpmScript('normalize:raw', false);
  runNpmScript('generate:context', false);
}

if (process.argv[1]?.endsWith('refresh-publishable.ts')) {
  void main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
