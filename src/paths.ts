/**
 * @module lib/paths
 * Where this package's own files live, and where the campus data lives.
 *
 * These are two different questions and they were previously answered the same
 * way, by walking up from the working directory to find the package root. That
 * held while the packages were sibling checkouts. It stops holding the moment
 * this one is installed into a consumer's `node_modules`: walking up from the
 * consumer's directory never reaches this package, and the search quietly
 * falls back to the wrong root.
 *
 * So they are separated here.
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
 * A deployment that installs this package as a dependency must set
 * `ROCKY_DATA_ROOT`, since there is no repository to find. Deployments reading
 * releases from PostgreSQL never need it — the file artifacts are a fallback,
 * not the source.
 */
export const DATA_ROOT = process.env.ROCKY_DATA_ROOT
  ? path.resolve(process.env.ROCKY_DATA_ROOT)
  : findRepositoryRoot(process.cwd());

/** Joins path segments against {@link DATA_ROOT}. */
export function dataRootPath(...segments: string[]): string {
  return path.join(/*turbopackIgnore: true*/ DATA_ROOT, ...segments);
}

/** Campus data artifacts produced by the pipeline and read by the brain. */
export const DATA_DIR = dataRootPath('data');

/** Joins path segments against the data directory. */
export function dataPath(...segments: string[]): string {
  return path.join(/*turbopackIgnore: true*/ DATA_DIR, ...segments);
}

/**
 * The web app's static directory, which the pipeline writes browser-fetchable
 * JSON into.
 *
 * This is the one place the pipeline reaches outside itself, and it is a
 * convenience rather than a requirement: the app serves release artifacts from
 * PostgreSQL and only falls back to these files when explicitly told to.
 * `ROCKY_PUBLIC_DIR` names the directory when the app is not a sibling.
 */
export const PUBLIC_DIR = process.env.ROCKY_PUBLIC_DIR
  ? path.resolve(process.env.ROCKY_PUBLIC_DIR)
  : path.join(/*turbopackIgnore: true*/ DATA_ROOT, '..', 'ui', 'public');

/** Joins path segments against the web app's static directory. */
export function publicPath(...segments: string[]): string {
  return path.join(/*turbopackIgnore: true*/ PUBLIC_DIR, ...segments);
}
