/**
 * @module api/routes/artifacts
 * Whole published datasets: the calendar, clubs, courses, events, hours, and
 * programs a client renders directly.
 *
 * Served from the active release in PostgreSQL, with the release version and
 * content hash on the response so a client can cache against them.
 */

import {
  isReleaseArtifactKey,
  loadReleaseArtifact,
} from '../../src/data-v2/release-artifacts';
import { fail, ok, PUBLIC_READ_HEADERS, type ApiHandler } from '../http';

export const getArtifact: ApiHandler = async (request) => {
  const key = request.url.pathname.split('/').pop() ?? '';
  if (!isReleaseArtifactKey(key)) {
    return fail(404, 'NOT_FOUND', `Unknown data artifact: ${key}`);
  }

  try {
    const loaded = await loadReleaseArtifact(key);
    const headers: Record<string, string> = {
      ...PUBLIC_READ_HEADERS,
      'X-RockyGPT-Release': loaded.releaseVersion,
      'X-RockyGPT-Data-Source': loaded.source,
    };
    if (loaded.contentHash) headers.ETag = `"${loaded.contentHash}"`;
    if (loaded.activatedAt) {
      headers['Last-Modified'] = new Date(loaded.activatedAt).toUTCString();
    }
    if (headers.ETag && request.headers.get('if-none-match') === headers.ETag) {
      return { status: 304, body: null, headers };
    }
    return ok(loaded.payload, headers);
  } catch (error) {
    console.error(
      'Unable to load release artifact:',
      error instanceof Error ? error.message : String(error)
    );
    return fail(503, 'UNAVAILABLE', 'Data artifact unavailable.', true);
  }
};
