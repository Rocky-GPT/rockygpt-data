/**
 * Keeps the model's how-to readings (data/raw/howto-entries.raw.json) between runs, in the file
 * store beside the captured pages: raw/howto-entries/<time>/<sha256>.json.gz.
 *
 * The model reads a page once and its reply is reused every night the page's words stay the
 * same (ingestion/howto-entries.ts), so the readings must outlive the runner. A run restores the
 * newest archived readings, reads what is new or changed, and archives the result when it
 * differs from what the store holds. Readings already on disk are never dropped: a restore
 * joins the two, keeping for each page the reading made last.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  archiveSourceRawArtifact, downloadRawArtifactBundle, listArchivedCaptures,
  type ArchivedCapture, type ArchivedRawArtifact, type RawArtifactBundleEnvelope,
} from './raw-artifacts';
import type { HowtoCapture } from '../ingestion/howto-entries';

export const HOWTO_STORE_SOURCE = 'howto-entries';
export const HOWTO_STORE_FILE = 'howto-entries.raw.json';
/** What the run did with the readings, shown at the end of the nightly job's log. */
export const HOWTO_READS_NOTE = path.join('data', 'review', 'howto-reads.txt');

export function writeHowtoNote(lines: readonly string[], file = path.join(process.cwd(), HOWTO_READS_NOTE)): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
}

/** The line a run prints after a restore. */
export function restoredLine(held: Pick<RestoredReadings, 'pages' | 'archivedAt'>): string {
  return held.archivedAt
    ? `How-to readings: restored the ones archived ${held.archivedAt}; ${held.pages} pages have a reading.`
    : `How-to readings: the file store holds none yet; ${held.pages} pages have a reading on disk.`;
}

export interface HowtoStoreDeps {
  list?: (sourceKey: string) => Promise<ArchivedCapture[]>;
  download?: (rawUri: string, expectedRawHash?: string) => Promise<RawArtifactBundleEnvelope>;
  archive?: (sourceKey: string, collectedAt: string, rawDir?: string) => Promise<ArchivedRawArtifact | null>;
  /** How many times a store request is tried before the error stands (the store answers a
   * passing "internal error, please try again" now and then). */
  attempts?: number;
  wait?: (milliseconds: number) => Promise<void>;
  now?: () => Date;
}

const emptyCapture = (): HowtoCapture => ({ dataset: 'howto-entries', pages: {} });

function readCapture(file: string): HowtoCapture {
  if (!fs.existsSync(file)) return emptyCapture();
  const capture = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<HowtoCapture>;
  if (!capture || typeof capture.pages !== 'object' || capture.pages === null || Array.isArray(capture.pages)) {
    throw new Error(`${file} is not a how-to readings file.`);
  }
  return { dataset: 'howto-entries', pages: capture.pages };
}

function writeCapture(file: string, capture: HowtoCapture): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify(capture, null, 2)}\n`);
  fs.renameSync(temporary, file);
}

/** What tells two sets of readings apart, whatever the order or spacing of their files. */
export function readingsDigest(capture: HowtoCapture): string {
  const rows = Object.entries(capture.pages).map(([page, read]) => `${page}\n${read.key}\n${read.read_at}`).sort();
  return crypto.createHash('sha256').update(rows.join('\n')).digest('hex');
}

/** Both sets of readings joined: for each page the one read last, and the local one on a tie. */
export function mergeReadings(local: HowtoCapture, archived: HowtoCapture): HowtoCapture {
  const pages = { ...archived.pages };
  for (const [page, read] of Object.entries(local.pages)) {
    const other = pages[page];
    if (!other || Date.parse(read.read_at) >= Date.parse(other.read_at) || !Number.isFinite(Date.parse(other.read_at))) pages[page] = read;
  }
  return { dataset: 'howto-entries', pages: Object.fromEntries(Object.entries(pages).sort(([a], [b]) => a.localeCompare(b))) };
}

async function withRetries<T>(what: string, run: () => Promise<T>, deps: HowtoStoreDeps): Promise<T> {
  const attempts = Math.max(1, deps.attempts ?? 4);
  const wait = deps.wait ?? ((milliseconds: number) => new Promise<void>(resolve => setTimeout(resolve, milliseconds)));
  for (let attempt = 1; ; attempt++) {
    try {
      return await run();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // A store with no settings will not gain them on the next try.
      if (/not configured|is required/i.test(message)) throw new Error(`${what} failed: ${message}`);
      if (attempt >= attempts) throw new Error(`${what} failed ${attempts} times: ${message}`);
      await wait(2000 * 2 ** (attempt - 1));
    }
  }
}

export interface RestoredReadings {
  /** Pages with a reading on disk after the restore. */
  pages: number;
  /** Pages the store's readings added or replaced on disk. */
  fromStore: number;
  /** When the store's newest readings were archived; null when it holds none yet. */
  archivedAt: string | null;
  /** The digest of what the store holds, for saveHowtoReadings; null when it holds none. */
  storedDigest: string | null;
}

/** Joins the store's newest readings into rawDir's file. A store that cannot be read is an error:
 * carrying on without the readings would publish every page with no how-to tasks. */
export async function restoreHowtoReadings(rawDir: string, deps: HowtoStoreDeps = {}): Promise<RestoredReadings> {
  const list = deps.list ?? listArchivedCaptures;
  const download = deps.download ?? downloadRawArtifactBundle;
  const file = path.join(rawDir, HOWTO_STORE_FILE);
  const local = readCapture(file);
  const captures = await withRetries('Listing the archived how-to readings', () => list(HOWTO_STORE_SOURCE), deps);
  const newest = [...captures].sort((left, right) => Date.parse(right.collectedAt) - Date.parse(left.collectedAt))[0];
  if (!newest) return { pages: Object.keys(local.pages).length, fromStore: 0, archivedAt: null, storedDigest: null };
  const bundle = await withRetries('Downloading the archived how-to readings', () => download(newest.rawUri, newest.rawHash), deps);
  const entry = bundle.entries.find(candidate => candidate.file === HOWTO_STORE_FILE);
  const content = entry?.content as Partial<HowtoCapture> | undefined;
  if (!content || typeof content.pages !== 'object' || content.pages === null || Array.isArray(content.pages)) {
    throw new Error(`The archived how-to readings ${newest.rawUri} hold no ${HOWTO_STORE_FILE}.`);
  }
  const archived: HowtoCapture = { dataset: 'howto-entries', pages: content.pages };
  const merged = mergeReadings(local, archived);
  const fromStore = Object.entries(merged.pages).filter(([page, read]) => local.pages[page] !== read).length;
  if (fromStore || !fs.existsSync(file)) writeCapture(file, merged);
  return { pages: Object.keys(merged.pages).length, fromStore, archivedAt: newest.collectedAt, storedDigest: readingsDigest(archived) };
}

/** A publish may not replace the live how-to tasks with far fewer: under this share of the live
 * release's pages with tasks, the readings were lost or most pages wait to be read again. */
export const HOWTO_PAGES_FLOOR = 0.5;
/** With fewer live pages with tasks than this there is nothing to protect yet (before the first read). */
export const HOWTO_PAGES_WORTH_GUARDING = 100;

/** Why a candidate with this many pages with how-to tasks may not replace a live release with
 * `active` of them, or null when it may. */
export function howtoPagesShortfall(candidate: number, active: number): string | null {
  if (active < HOWTO_PAGES_WORTH_GUARDING || candidate >= active * HOWTO_PAGES_FLOOR) return null;
  return `pages with how-to tasks dropped from ${active} to ${candidate} (minimum allowed ratio ${HOWTO_PAGES_FLOOR}). `
    + 'The readings were not restored, or most pages wait to be read again: the reading instructions changed, or more '
    + 'pages changed than HOWTO_MAX_USD covers in a night. The readings made so far are archived; run Daily Data Update '
    + 'by hand with howto_max_usd raised to read the rest in one run.';
}

/** Archives rawDir's readings unless the store already holds exactly these (storedDigest, from
 * the restore or the last save). */
export async function saveHowtoReadings(rawDir: string, storedDigest: string | null,
  deps: HowtoStoreDeps = {}): Promise<{ saved: boolean; digest: string; pages: number }> {
  const archive = deps.archive ?? archiveSourceRawArtifact;
  const capture = readCapture(path.join(rawDir, HOWTO_STORE_FILE));
  const digest = readingsDigest(capture);
  const pages = Object.keys(capture.pages).length;
  if (digest === storedDigest || !pages) return { saved: false, digest, pages };
  const archivedAt = (deps.now?.() ?? new Date()).toISOString();
  const stored = await withRetries('Archiving the how-to readings', () => archive(HOWTO_STORE_SOURCE, archivedAt, rawDir), deps);
  if (!stored?.stored) throw new Error('The how-to readings were not archived: the file store is not configured (RAW_ARTIFACT_BUCKET).');
  return { saved: true, digest, pages };
}
