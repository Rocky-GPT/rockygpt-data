/**
 * Run each source's collectors on their own, so one source that cannot be collected keeps the
 * active release's copy of its files while every other source still refreshes.
 *
 * The daily refresh used to stop at the first failed collector. A single page Ramapo removed
 * (a 404 among 273 reviewed contact pages, a sitemap answering 410) then kept menus, events and
 * every other source out of production until someone fixed it by hand.
 *
 * Before the collectors run, the restored release's files are copied aside. A source whose
 * collector fails has every file it wrote put back from that copy (and every file it created
 * removed), so it is published from exactly what the active release already carried. Whether
 * that copy is still fresh enough to publish is left to the provenance check that follows, which
 * still stops the refresh once a kept source passes its freshness window.
 *
 * When the kept copy is already past that window the run cannot publish, so it stops at once
 * (`unpublishable`) instead of collecting every later source first. On November 10, 2026 two
 * runs lost dining in their second minute, to a hidden button and then to a menu service that
 * timed out, and each still downloaded about 330 pages from Ramapo's sites before failing.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface SourceRefreshGroup {
  key: string;
  scripts: string[];
}

export interface KeptSource {
  key: string;
  scripts: string[];
  failedScript: string;
  error: string;
}

/** Directories under the working tree that collectors write. */
export const COLLECTOR_OUTPUT_ROOTS = ['data', 'public/data', 'src/reference'];

// Local caches and run reports, not publication inputs: never snapshotted or restored.
const IGNORED_DIRECTORIES = new Set([
  'data/cache',
  'data/.cache',
  'data/logs',
  'data/playwright',
  'data/review',
]);

type FileStates = Map<string, string>;

function stateOf(file: string): string {
  const stat = fs.statSync(file, { bigint: true });
  return `${stat.size}:${stat.mtimeNs}`;
}

/** Every file under the roots, as relative path -> size and modification time. */
export function listFiles(rootDir: string, roots: readonly string[] = COLLECTOR_OUTPUT_ROOTS): FileStates {
  const files: FileStates = new Map();
  const visit = (relative: string): void => {
    if (IGNORED_DIRECTORIES.has(relative)) return;
    const absolute = path.join(rootDir, relative);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(absolute, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = path.posix.join(relative, entry.name);
      if (entry.isDirectory()) visit(child);
      else if (entry.isFile()) files.set(child, stateOf(path.join(rootDir, child)));
    }
  };
  for (const root of roots) visit(root);
  return files;
}

/** Paths created, changed or removed between two listings. */
export function changedPaths(before: FileStates, after: FileStates): string[] {
  const changed = new Set<string>();
  for (const [file, state] of after) if (before.get(file) !== state) changed.add(file);
  for (const file of before.keys()) if (!after.has(file)) changed.add(file);
  return [...changed].sort();
}

/** Group collector scripts by the source they renew, in the order they would have run. */
export function groupScriptsBySource(
  scripts: readonly string[],
  sourceScripts: Readonly<Record<string, readonly string[]>>
): SourceRefreshGroup[] {
  const owner = new Map<string, string>();
  for (const [key, list] of Object.entries(sourceScripts)) for (const script of list) owner.set(script, key);
  const groups: SourceRefreshGroup[] = [];
  for (const script of scripts) {
    const key = owner.get(script);
    if (!key) throw new Error(`No publishable source owns collector ${script}.`);
    const group = groups.find((entry) => entry.key === key);
    if (group) group.scripts.push(script);
    else groups.push({ key, scripts: [script] });
  }
  return groups;
}

export interface IsolatedRefreshOptions {
  rootDir: string;
  groups: readonly SourceRefreshGroup[];
  runScript: (script: string) => void;
  log?: (line: string) => void;
  /**
   * Why a source that was just kept cannot be published as it is (its copy is past its freshness
   * window), or null when it can. A reason stops the refresh before the remaining collectors run.
   */
  unpublishable?: (kept: KeptSource) => string | null;
}

/**
 * Run every group. A group whose script throws has its files put back as the restored release
 * left them, and is reported as kept. If a failed group touched a file an earlier, successful
 * group had already rewritten, the release's copy would undo that source's work, so the refresh
 * stops as it always did.
 */
export function runIsolatedRefresh(options: IsolatedRefreshOptions): KeptSource[] {
  const { rootDir, groups, runScript } = options;
  const log = options.log ?? ((line: string) => console.log(line));
  const snapshotDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rockygpt-release-snapshot-'));
  const kept: KeptSource[] = [];
  try {
    const release = listFiles(rootDir);
    for (const file of release.keys()) {
      const target = path.join(snapshotDir, file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.join(rootDir, file), target);
    }
    const rewritten = new Set<string>();

    for (const group of groups) {
      const before = listFiles(rootDir);
      let failedScript: string | null = null;
      let failure: unknown = null;
      for (const script of group.scripts) {
        try {
          runScript(script);
        } catch (error) {
          failedScript = script;
          failure = error;
          break;
        }
      }
      const touched = changedPaths(before, listFiles(rootDir));
      if (failedScript === null) {
        touched.forEach((file) => rewritten.add(file));
        continue;
      }

      const message = failure instanceof Error ? failure.message : String(failure);
      const shared = touched.filter((file) => rewritten.has(file));
      if (shared.length) {
        throw new Error(
          `${message} The release's copy of ${group.key} cannot be kept: it would undo files another ` +
            `source refreshed this run (${shared.slice(0, 5).join(', ')}).`
        );
      }
      for (const file of touched) {
        const target = path.join(rootDir, file);
        if (release.has(file)) {
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.copyFileSync(path.join(snapshotDir, file), target);
        } else {
          fs.rmSync(target, { force: true });
        }
      }
      log(
        `Kept the active release's ${group.key} files: ${message} ` +
          `(${touched.length} file(s) put back; the other sources keep refreshing).`
      );
      const entry: KeptSource = { key: group.key, scripts: [...group.scripts], failedScript, error: message };
      kept.push(entry);
      const reason = options.unpublishable?.(entry);
      if (reason) {
        const notRun = groups.slice(groups.indexOf(group) + 1).flatMap((later) => later.scripts);
        throw new Error(
          `Collection finished without fresh provenance for: ${group.key} (${reason}; its collector failed: ${message}). ` +
            (notRun.length
              ? `Stopped before ${notRun.join(', ')}: a run that cannot publish downloads nothing more.`
              : 'It was the last collector of the run.')
        );
      }
    }
    return kept;
  } finally {
    fs.rmSync(snapshotDir, { recursive: true, force: true });
  }
}

export const KEPT_SOURCES_REPORT = path.join('data', 'review', 'refresh-kept-sources.md');

/** The note the workflow posts on the data-refresh incident when a run kept any source. */
export function keptSourcesReport(
  kept: readonly KeptSource[],
  states: ReadonlyArray<{ key: string; detail: string }>,
  releaseVersion: string
): string {
  const lines = [
    `This run published every other source, but could not collect ${kept.length} source(s). ` +
      `Each keeps its copy from release ${releaseVersion} until it is fixed or passes its freshness window.`,
    '',
  ];
  for (const entry of kept) {
    const state = states.find((candidate) => candidate.key === entry.key);
    lines.push(
      `- **${entry.key}**: \`npm run ${entry.failedScript}\` failed: ${entry.error}` +
        (state ? ` Kept data: ${state.detail}.` : '')
    );
  }
  return `${lines.join('\n')}\n`;
}
