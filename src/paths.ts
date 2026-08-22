/**
 * @module lib/paths
 * Where this package's own files live, and where the campus data lives.
 *
 * Assets that ship inside the package — the schema and its migrations — are
 * resolved from this module's own location, which is correct whether the code
 * is running from `src` under tsx or from the compiled `dist`.
 *
 * The campus data directory is deployment state rather than package content.
 * `ROCKY_DATA_ROOT` names it. Without that variable the repository layout is
 * assumed, which is what the ingestion scripts and pipeline commands rely on
 * when they run from this repository.
 */

import fs from 'node:fs';
import path from 'node:path';

const DATA_PACKAGE_NAME = '@rockygpt/data';

/**
 * A file that ships inside this package, addressed relative to the package
 * root. Both `src/data-v2/schema.sql` and its compiled counterpart resolve,
 * because this module sits at the root of whichever tree is running.
 */
export function packageAsset(...segments: string[]): string {
  return path.join(/*turbopackIgnore: true*/ __dirname, ...segments);
}

/** True when `manifest` is this package's own package.json. */
function isDataManifest(manifest: string): boolean {
  try {
    return (
      JSON.parse(fs.readFileSync(/*turbopackIgnore: true*/ manifest, 'utf8')).name ===
      DATA_PACKAGE_NAME
    );
  } catch {
    return false;
  }
}

/**
 * Walks up from `start` looking for this repository, either because we are
 * inside it or because it sits one level down as a sibling checkout. Used only
 * when `ROCKY_DATA_ROOT` is unset, which is the in-repository case.
 */
function findRepositoryRoot(start: string): string {
  let dir = path.resolve(start);
  for (;;) {
    if (isDataManifest(path.join(/*turbopackIgnore: true*/ dir, 'package.json'))) return dir;
    const sibling = path.join(/*turbopackIgnore: true*/ dir, 'data');
    if (isDataManifest(path.join(/*turbopackIgnore: true*/ sibling, 'package.json'))) return sibling;
    const parent = path.dirname(dir);
    if (parent === dir) return path.resolve(start);
    dir = parent;
  }
}

/**
 * The root the campus data directory hangs off.
 *
 * Tooling may set `ROCKY_DATA_ROOT` when its working directory is elsewhere.
 * The runtime service reads published releases from PostgreSQL.
 */
export const DATA_ROOT = process.env.ROCKY_DATA_ROOT
  ? path.resolve(process.env.ROCKY_DATA_ROOT)
  : findRepositoryRoot(process.cwd());

/** Joins path segments against {@link DATA_ROOT}. */
export function dataRootPath(...segments: string[]): string {
  return path.join(/*turbopackIgnore: true*/ DATA_ROOT, ...segments);
}

/** Campus data artifacts produced and consumed inside this repository. */
export const DATA_DIR = dataRootPath('data');

/** Joins path segments against the data directory. */
export function dataPath(...segments: string[]): string {
  return path.join(/*turbopackIgnore: true*/ DATA_DIR, ...segments);
}

/** Browser-shaped release artifacts staged inside the data repository. */
export const PUBLIC_DIR = dataRootPath('public');

/** Joins path segments against the internal release-artifact staging area. */
export function publicPath(...segments: string[]): string {
  return path.join(/*turbopackIgnore: true*/ PUBLIC_DIR, ...segments);
}
