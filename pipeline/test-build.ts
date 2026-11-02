/**
 * @module pipeline/test-build
 * The switch for a laptop test build made from the pages already captured.
 *
 * `ROCKYGPT_TEST_BUILD_FROM_CAPTURED_PAGES=1` lets `npm run data:publish` publish sources older
 * than their freshness window, so a test graph never re-collects from ramapo.edu. It is for a
 * throwaway database on this machine only: it refuses a database that is not on 127.0.0.1,
 * ::1 or localhost, and refuses to run with a raw artifact bucket set, so a test build can never
 * reach production storage. A source with no collection record is still refused.
 */

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/** Whether the URL's host is this machine. Unix sockets (host=/path) count as local. */
export function isLocalDatabaseUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const socket = parsed.searchParams.get('host');
  if (!parsed.hostname && socket?.startsWith('/')) return true;
  return LOCAL_HOSTS.has(parsed.hostname);
}

/** True when the test-build switch is on and safe; throws when it is on but unsafe. */
export function testBuildFromCapturedPages(env: NodeJS.ProcessEnv): boolean {
  if (env.ROCKYGPT_TEST_BUILD_FROM_CAPTURED_PAGES !== '1') return false;
  if (!isLocalDatabaseUrl(env.DATABASE_URL ?? '')) {
    throw new Error('ROCKYGPT_TEST_BUILD_FROM_CAPTURED_PAGES works only with a database on this machine (127.0.0.1 or localhost).');
  }
  if (env.RAW_ARTIFACT_BUCKET) {
    throw new Error('ROCKYGPT_TEST_BUILD_FROM_CAPTURED_PAGES refuses to run with RAW_ARTIFACT_BUCKET set; a test build never uploads.');
  }
  if (env.GITHUB_ACTIONS === 'true') {
    throw new Error('ROCKYGPT_TEST_BUILD_FROM_CAPTURED_PAGES is for a laptop test build, never a workflow.');
  }
  return true;
}
