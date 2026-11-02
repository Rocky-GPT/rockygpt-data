/**
 * The published release's files, kept by the daily workflow between runs (actions/cache), so
 * the next refresh restores the active release without downloading it from the database again.
 *
 * Neon's free plan allows 5 GB of network transfer a month, and every nightly refresh used to
 * download the whole active release (its artifacts and context documents) only to put back the
 * files the previous night's publish had just uploaded. The publisher now saves exactly what it
 * uploaded here. The restore reads only the database's content hashes and takes each artifact or
 * document from this copy when its hash matches, so the database stays the truth: anything
 * missing here, or different, is still read from the database.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const RELEASE_SNAPSHOT_FILE = path.join('.release-snapshot', 'release.json');

export interface ReleaseSnapshot {
  version: string;
  /** artifact key -> the exact text the publisher hashed (release_artifacts.content_hash). */
  artifacts: Record<string, string>;
  /** context document sourcePath -> the exact content the publisher stored. */
  documents: Record<string, string>;
}

export const sha256 = (text: string): string =>
  crypto.createHash('sha256').update(text).digest('hex');
export const md5 = (text: string): string => crypto.createHash('md5').update(text).digest('hex');

export function writeReleaseSnapshot(file: string, snapshot: ReleaseSnapshot): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, JSON.stringify(snapshot), 'utf8');
  fs.renameSync(temporary, file);
}

/** The saved copy, or null when there is none or it cannot be read (then the database serves). */
export function readReleaseSnapshot(file: string): ReleaseSnapshot | null {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<ReleaseSnapshot>;
    const isTextMap = (map: unknown): map is Record<string, string> =>
      Boolean(map) && typeof map === 'object' &&
      Object.values(map as object).every((text) => typeof text === 'string');
    if (typeof value.version !== 'string' || !isTextMap(value.artifacts) || !isTextMap(value.documents)) {
      return null;
    }
    return { version: value.version, artifacts: value.artifacts, documents: value.documents };
  } catch {
    return null;
  }
}

function utf8Compare(a: string, b: string): number {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length - right.length || Buffer.compare(left, right);
}

/**
 * A parsed JSON value with its object keys in the order PostgreSQL's jsonb keeps them (shorter
 * keys first, then by bytes), so a file restored from this copy is written byte for byte as one
 * restored from the database's jsonb payload.
 */
export function inJsonbKeyOrder(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(inJsonbKeyOrder);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort(utf8Compare)
    .map((key) => [key, inJsonbKeyOrder((value as Record<string, unknown>)[key])]));
}
