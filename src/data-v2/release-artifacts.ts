import fs from 'node:fs/promises';
import path from 'node:path';
import { getRuntimePool } from '../db/runtime-pool';
import { DATA_ROOT } from '../paths';

const FALLBACK_FILES = {
  calendar: '../ui/public/data/calendar.json',
  clubs: '../ui/public/data/clubs.json',
  courses: '../ui/public/data/courses.json',
  events: '../ui/public/data/events.json',
  hours: '../ui/public/data/hours.json',
  programs: '../ui/public/data/programs.json',
  menu: 'data/normalized/menu.json',
  'menu-week': 'data/normalized/menu-week.json',
  'menu-context': 'data/context/dining/menu.md',
  'dining-hours': 'data/normalized/dining-hours.json',
  faculty: 'data/normalized/faculty.json',
  transportation: 'data/context/campus/transportation.md',
  'dining-hours-context': 'data/context/dining/hours.md',
} as const;

export type ReleaseArtifactKey = keyof typeof FALLBACK_FILES;

export interface LoadedReleaseArtifact {
  payload: unknown;
  contentHash?: string;
  releaseVersion: string;
  activatedAt?: string;
  source: 'postgres' | 'file-fallback';
}

export function isReleaseArtifactKey(value: string): value is ReleaseArtifactKey {
  return Object.hasOwn(FALLBACK_FILES, value);
}

async function loadFileArtifact(key: ReleaseArtifactKey): Promise<LoadedReleaseArtifact> {
  const relativePath = FALLBACK_FILES[key];
  const fallbackPath = process.env.ROCKY_DATA_ROOT
    ? path.join(/*turbopackIgnore: true*/ process.env.ROCKY_DATA_ROOT, relativePath)
    : path.join(/*turbopackIgnore: true*/ DATA_ROOT, relativePath);
  const [content, stats] = await Promise.all([
    fs.readFile(fallbackPath, 'utf8'),
    fs.stat(fallbackPath),
  ]);
  return {
    payload: relativePath.endsWith('.json') ? (JSON.parse(content) as unknown) : { content },
    releaseVersion: 'file-fallback',
    activatedAt: stats.mtime.toISOString(),
    source: 'file-fallback',
  };
}

function explicitFileArtifactMode(): boolean {
  if (process.env.NODE_ENV === 'production') return false;
  return (
    process.env.V2_DATA_SOURCE === 'file' || process.env.ROCKY_ALLOW_FILE_ARTIFACT_FALLBACK === '1'
  );
}

export async function loadReleaseArtifact(key: ReleaseArtifactKey): Promise<LoadedReleaseArtifact> {
  if (explicitFileArtifactMode()) {
    return loadFileArtifact(key);
  }

  const pool = getRuntimePool();
  if (!pool) {
    throw new Error(
      'DATABASE_URL is required for release artifacts. ' +
        'For explicit local file mode, set V2_DATA_SOURCE=file.'
    );
  }

  const result = await pool.query<{
    version: string;
    payload: unknown;
    content_hash: string;
    activated_at: string | null;
  }>(
    `SELECT v.version, v.activated_at::text, a.payload, a.content_hash
     FROM rockygpt_v2.dataset_versions v
     JOIN rockygpt_v2.release_artifacts a ON a.dataset_version_id = v.id
     WHERE v.status = 'active' AND a.artifact_key = $1
     ORDER BY v.activated_at DESC LIMIT 1`,
    [key]
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error(`Release artifact "${key}" is unavailable in the active dataset.`);
  }
  return {
    payload: row.payload,
    contentHash: row.content_hash,
    releaseVersion: row.version,
    activatedAt: row.activated_at || undefined,
    source: 'postgres',
  };
}
