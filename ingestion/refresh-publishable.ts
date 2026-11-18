import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { SOURCES } from '../src/data-v2/source-seeds';
import { restoreActiveRelease } from '../pipeline/restore-active-release';
import { facultyQualityErrors } from '../pipeline/quality/content-policy';
import {
  evaluateSourceProvenance,
  KEPT_PAST_WINDOW_FILE,
  SOURCE_RAW_DATASETS,
  type SourceProvenanceState,
} from '../pipeline/quality/provenance';
import { validateFacultyProfiles } from './schema';
import { partitionHoursForPublication } from '../src/data-v2/validity';
import { hoursSourceErrors } from '../pipeline/quality/hours-coverage';
import { HOURS_READ_ENV } from './campus-hours';
import {
  groupScriptsBySource,
  KEPT_SOURCES_REPORT,
  keptSourcesReport,
  runIsolatedRefresh,
  type KeptSource,
} from './refresh-isolation';
import { replayPageDatasets } from './replay-raw';
import { ALLOW_SITE_FETCH_ENV, noteSiteDownloads, siteFetchAllowed, startSiteDownloadsNote } from './site-guard';

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
  // The athletics site, one page every 30 seconds (its robots.txt).
  'athletics-schedules': ['fetch:athletics-schedules'],
  'athletics-coaches': ['fetch:athletics-coaches'],
  // Weekly: the site's information pages (intramurals, Bradley Center memberships).
  'athletics-pages': ['fetch:athletics-pages'],
};

// The workflow runs daily. Renew a source that would cross its SLA before
// the next run; otherwise a source at 23.9h could pass a 24h gate, skip its
// daily refresh, and become stale minutes after activation.
export const REFRESH_HORIZON_HOURS = 24;

type RefreshState = Pick<SourceProvenanceState, 'key' | 'status' | 'ageHours' | 'maxAgeHours'>;

/** Whether tonight's run must recollect a source: it is stale, unknown, or would go stale before the next run. */
export function mustRefreshTonight(state: RefreshState, refreshHorizonHours = REFRESH_HORIZON_HOURS): boolean {
  return state.status === 'stale' ||
    state.status === 'unknown' ||
    (state.status === 'fresh' &&
      state.ageHours !== null &&
      state.maxAgeHours - state.ageHours <= refreshHorizonHours);
}

/**
 * Sources collected every night whatever their freshness window says (Dan, November 16, 2026). Their
 * collectors read each site's sitemap and download only the pages edited since the last download (and
 * each page once in a while on its own night), so a nightly run reads a few pages, not thousands, and a
 * page edit reaches the bot within a day instead of up to a week. Their freshness window stays a week,
 * so one failed night keeps the last copy instead of stopping the publish.
 */
export const NIGHTLY_SOURCES: ReadonlySet<string> = new Set([
  'office-pages', 'academic-sites',
  // The smaller www.ramapo.edu sources read the same sitemap dates (page-dates.ts, 11-18). The
  // directory stays on its weekly window: its pages show names from another system, which change
  // without an edit to the page. Campus hours are PAGE_COPY_SOURCES below.
  'public-safety', 'housing', 'counseling', 'transportation', 'health',
]);

/**
 * Sources read every night from the pages the collectors above just saved, with no download of
 * their own unless they are due (audit 2026-11-17, item 9): campus hours re-reads each hours page
 * whose nightly copy changed, and reads every hours page from Ramapo's sites once its weekly
 * window comes due, because some pages show hours from other systems without an edit.
 */
export const PAGE_COPY_SOURCES: ReadonlySet<string> = new Set(['campus-hours']);

/** The environment variable a run started by hand sets to collect named sources tonight, fresh or not. */
export const FORCE_SOURCES_ENV = 'REFRESH_FORCE_SOURCES';

/**
 * The sources a run was asked to collect tonight whatever their freshness window says, from a list
 * separated by commas or spaces ("campus-hours, archway-clubs"). Campus hours and clubs sit on a
 * 180-day window, and on November 17, 2026 every hours record dated from October 23 and every club
 * from July 16 while the library's page already listed its Thanksgiving closure: until then the only
 * way to read them sooner was a code change. An unknown name stops the run, so a typo never passes
 * for a collection that did not happen.
 */
export function forcedSources(value: string | undefined): Set<string> {
  const keys = (value ?? '').split(/[\s,]+/).map((key) => key.trim()).filter(Boolean);
  const unknown = keys.filter((key) => !SOURCE_REFRESH_SCRIPTS[key]);
  if (unknown.length) {
    throw new Error(
      `${FORCE_SOURCES_ENV} names no such source: ${unknown.join(', ')}. ` +
        `Sources: ${Object.keys(SOURCE_REFRESH_SCRIPTS).join(', ')}.`
    );
  }
  return new Set(keys);
}

export function refreshScriptsForStates(
  states: ReadonlyArray<RefreshState>,
  refreshHorizonHours = REFRESH_HORIZON_HOURS,
  forced: ReadonlySet<string> = new Set()
): string[] {
  const scripts = states
    .filter((state) => mustRefreshTonight(state, refreshHorizonHours) || NIGHTLY_SOURCES.has(state.key)
      || PAGE_COPY_SOURCES.has(state.key) || forced.has(state.key))
    .flatMap((state) => {
      const configured = SOURCE_REFRESH_SCRIPTS[state.key];
      if (!configured) {
        throw new Error(`No refresh command is configured for publishable source ${state.key}.`);
      }
      return configured;
    });
  // The sources that read tonight's page copies run after every collector that saves them.
  const readsCopies = new Set([...PAGE_COPY_SOURCES].flatMap((key) => SOURCE_REFRESH_SCRIPTS[key] ?? []));
  const unique = [...new Set(scripts)];
  return [...unique.filter((script) => !readsCopies.has(script)), ...unique.filter((script) => readsCopies.has(script))];
}

/**
 * Whether a page-copy source reads only tonight's page copies: true unless it is due (stale, unknown,
 * or about to be), named by hand, or its saved files no longer replay with the current code.
 */
export function readsPageCopiesOnly(
  key: string,
  states: ReadonlyArray<RefreshState>,
  forced: ReadonlySet<string>,
  compatibilityScripts: readonly string[],
  refreshHorizonHours = REFRESH_HORIZON_HOURS
): boolean {
  if (!PAGE_COPY_SOURCES.has(key) || forced.has(key)) return false;
  const state = states.find((candidate) => candidate.key === key);
  if (!state || mustRefreshTonight(state, refreshHorizonHours)) return false;
  return !(SOURCE_REFRESH_SCRIPTS[key] ?? []).some((script) => compatibilityScripts.includes(script));
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

function runNpmScript(script: string, rawOnly: boolean, extraEnv: Record<string, string> = {}): void {
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
      ...extraEnv,
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

/**
 * `--from-captured-pages` (the workflow's dev build): restore production's newest pages and
 * rebuild every projection with this checkout's code, but collect nothing. A source past its
 * freshness window is listed, not refused; the dev build's publish skips the age check too.
 */
export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const unknown = argv.filter((arg) => arg !== '--from-captured-pages');
  if (unknown.length) throw new Error(`Unknown option: ${unknown.join(', ')}`);
  if (argv.includes('--from-captured-pages')) return rebuildFromCapturedPages();
  assertRefreshCoverage();
  // Pages a run collected but could not publish are restored in place of the release's older
  // ones, so a failed publish does not send the next run back to Ramapo's sites for them.
  const restored = await restoreActiveRelease({
    requireRawArtifacts: true, allowIncompleteRawArtifacts: true, reuseUnpublishedCaptures: true,
  });
  console.log(
    `Bootstrapped ${restored.version}: ${restored.artifactFilesWritten} release artifact file(s) ` +
      `and ${restored.rawFilesRestored} raw file(s) ` +
      `for ${restored.rawSourcesRestored} source(s); downloaded from the database: ` +
      `${restored.artifactsDownloaded} artifact(s) ` +
      `(the rest matched the last publish's saved copy).`
  );
  startSiteDownloadsNote();
  for (const entry of restored.rawSourcesReused) {
    noteSiteDownloads(`${entry.sourceKey}: reused the pages a run collected ${entry.collectedAt} and could not publish; ` +
      'not downloaded again unless the source is due tonight.');
  }
  const forced = forcedSources(process.env[FORCE_SOURCES_ENV]);
  if (forced.size) console.log(`Asked to collect tonight whatever their age: ${[...forced].join(', ')}.`);
  const before = evaluateSourceProvenance(SOURCES);
  const provenanceScripts = refreshScriptsForStates(before, REFRESH_HORIZON_HOURS, forced);
  const compatibilityScripts = restoredArtifactCompatibilityScripts();
  if (compatibilityScripts.length) {
    console.log(
      `Restored artifacts require current collector output: ${compatibilityScripts.join(', ')}.`
    );
  }
  const scripts = [...new Set([...provenanceScripts, ...compatibilityScripts])];
  const hoursFromCopies = readsPageCopiesOnly('campus-hours', before, forced, compatibilityScripts);
  if (hoursFromCopies) {
    console.log('Campus hours are not due: re-reading only the hours pages whose nightly copy changed.');
  }
  let kept: KeptSource[] = [];

  if (scripts.length && !siteFetchAllowed()) {
    throw new Error(
      `This refresh would download from Ramapo's sites (${scripts.join(', ')}), and only the daily data run does that. ` +
        "Use production's captured pages instead (npm run data:bootstrap -- --require-raw). " +
        `If Dan asked for a fresh collection on this machine, run it with ${ALLOW_SITE_FETCH_ENV}=1.`
    );
  }
  noteSiteDownloads(scripts.length
    ? `Collectors run tonight: ${scripts.join(', ')}.`
    : 'No collector ran tonight: every source was fresh.');
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
      runScript: (script) => runNpmScript(script, false,
        hoursFromCopies && SOURCE_REFRESH_SCRIPTS['campus-hours'].includes(script)
          ? { [HOURS_READ_ENV]: 'changed-pages' } : {}),
      // A kept copy of unknown age can never publish, so the run stops there instead of
      // downloading every later source from Ramapo's sites for nothing. A kept copy that is only
      // past its window publishes with the rest (keptPastWindowKeys below).
      unpublishable: (entry) => {
        const state = evaluateSourceProvenance(SOURCES).find((candidate) => candidate.key === entry.key);
        return state?.status === 'unknown' ? state.detail : null;
      },
    });
  } else {
    console.log('All publishable source provenance is fresh; no collection needed.');
  }

  const after = evaluateSourceProvenance(SOURCES);
  const keptLast = keptPastWindowKeys(after, kept);
  fs.rmSync(KEPT_PAST_WINDOW_FILE, { force: true });
  if (keptLast.length) {
    fs.mkdirSync(path.dirname(KEPT_PAST_WINDOW_FILE), { recursive: true });
    fs.writeFileSync(KEPT_PAST_WINDOW_FILE, `${JSON.stringify(keptLast)}\n`);
    console.warn(`Past their freshness window and not collected tonight, published from the last copy: ${keptLast.join(', ')}.`);
  }
  const nonFresh = after.filter((state) => (state.status === 'stale' || state.status === 'unknown')
    && !keptLast.includes(state.key));
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

  rebuildProjections();
}

/**
 * The sources whose collector failed tonight while their copy was already past its freshness window.
 * Dan's rule since November 17, 2026 (the overnight audit plan, decision 2): they keep the last
 * published copy and every other source publishes, instead of one late source holding back all the
 * new data. A source of unknown age, or a stale source whose collector did not fail, still stops it.
 */
export function keptPastWindowKeys(
  states: ReadonlyArray<{ key: string; status: string }>,
  kept: ReadonlyArray<{ key: string }>
): string[] {
  const failed = new Set(kept.map((entry) => entry.key));
  return states.filter((state) => state.status === 'stale' && failed.has(state.key)).map((state) => state.key);
}

function rebuildProjections(): void {
  // The parsed pages first: every page source is read again from its saved HTML with this
  // checkout's reader, so a source not collected tonight carries no older reader's sections.
  for (const line of replayPageDatasets()) console.log(line);
  // Rebuild every projection from its complete source capture, including
  // event/club detail pages; never relabel old normalized content as fresh.
  runNpmScript('quality:raw', false);
  runNpmScript('normalize:raw', false);
}

async function rebuildFromCapturedPages(): Promise<void> {
  const restored = await restoreActiveRelease({ requireRawArtifacts: true });
  console.log(
    `Dev build from production's ${restored.version}: ${restored.rawFilesRestored} raw file(s) for ` +
      `${restored.rawSourcesRestored} source(s); downloaded from the database: ` +
      `${restored.artifactsDownloaded} artifact(s) ` +
      `(the rest matched the last publish's saved copy).`
  );
  startSiteDownloadsNote();
  noteSiteDownloads(`Dev build: no collector ran; built from production's captured pages (${restored.version}).`);
  const aged = evaluateSourceProvenance(SOURCES)
    .filter((state) => state.status === 'stale' || state.status === 'unknown');
  if (aged.length) {
    console.log(`Past their freshness window (built anyway): ${aged.map((state) => `${state.key} (${state.detail})`).join('; ')}.`);
  }
  rebuildProjections();
}

if (process.argv[1]?.endsWith('refresh-publishable.ts')) {
  void main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
