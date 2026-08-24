/**
 * @module api/server
 * The HTTP service for campus data.
 *
 * The web app used to read this package directly, which made it both a client
 * and a server: every route that served a menu or a directory listing was a
 * Next.js handler importing the repository layer. Nothing else could reach that
 * data — a native client had no way in.
 *
 * Behind HTTP the web app becomes one client among several. A second client can
 * use the same interface without sharing application source.
 *
 * Campus data is public and read-mostly, so responses are cacheable and
 * cross-origin reads are allowed. Nothing here writes.
 */

import 'dotenv/config';
import http from 'node:http';
import { Readable } from 'node:stream';
import { timingSafeEqual } from 'node:crypto';
import { getArtifact } from './routes/artifacts';
import { getHealth, getReadiness } from './routes/health';
import { getDataExplorer, getEntityRegistry, getEntityRows, getScrapeStatus } from './routes/dev';
import { getDiningHours } from './routes/dining-hours';
import { getDirectory } from './routes/directory';
import { getMap } from './routes/map';
import { getMenu } from './routes/menu';
import { getMenuBrowse } from './routes/menu-browse';
import { getShuttle } from './routes/shuttle';
import { postShuttleQuery } from './routes/shuttle-query';
import { postRetrieve } from './routes/retrieve';
import { getSafetyResources, getSearch } from './routes/search';
import { fail, type ApiHandler, type ApiRequest } from './http';

/**
 * A hosting platform hands the port over in PORT and expects the process to
 * listen on every interface; binding loopback there passes locally and then
 * fails every health check in the container. PORT is therefore also the
 * signal that this is a hosted run.
 */
const PORT = Number(process.env.PORT || process.env.DATA_PORT || 8100);
const HOST = process.env.DATA_HOST || (process.env.PORT ? '0.0.0.0' : '127.0.0.1');

/** A whole request body of JSON, with room to spare; larger than this is junk. */
const MAX_BODY_BYTES = 256 * 1024;
/** Bounds parsing work before an endpoint applies its parameter-specific limits. */
const MAX_REQUEST_TARGET_CHARS = 8_192;
const MAX_QUERY_PARAMETERS = 32;

const ENVIRONMENT_TOKEN_HEADER = 'x-rockygpt-environment-token';

function environmentAccessAllowed(
  incoming: http.IncomingMessage,
  configuredToken: string | undefined
): boolean {
  const expected = configuredToken?.trim();
  if (!expected) return true;
  const supplied = incoming.headers[ENVIRONMENT_TOKEN_HEADER];
  const provided = Array.isArray(supplied) ? supplied[0] : supplied;
  if (!provided) return false;
  const expectedBytes = Buffer.from(expected);
  const providedBytes = Buffer.from(provided);
  return expectedBytes.length === providedBytes.length && timingSafeEqual(expectedBytes, providedBytes);
}

/**
 * Exact paths first, then the one prefix route. Kept deliberately small: every
 * entry here is a promise to a client that may not be updated in step with
 * this service.
 */
const ROUTES: Record<string, ApiHandler> = {
  'GET /health': getHealth,
  'GET /readiness': getReadiness,
  'GET /v1/shuttle': getShuttle,
  'GET /v1/map': getMap,
  'GET /v1/menu': getMenu,
  'GET /v1/menu/browse': getMenuBrowse,
  'GET /v1/dining-hours': getDiningHours,
  'GET /v1/directory': getDirectory,
  'GET /v1/search/campus-hours': getSearch,
  'GET /v1/search/dining-hours': getSearch,
  'GET /v1/search/menu': getSearch,
  'GET /v1/search/contacts': getSearch,
  'GET /v1/search/clubs': getSearch,
  'GET /v1/search/events': getSearch,
  'GET /v1/search/programs': getSearch,
  'GET /v1/search/academic-dates': getSearch,
  'GET /v1/search/shuttles': getSearch,
  'GET /v1/safety-resources': getSafetyResources,
  'POST /v2/capabilities/shuttle/query': postShuttleQuery,
  'POST /v2/retrieve': postRetrieve,
};

// Development inspectors expose release metadata and broad database reads.
// They are not part of the public/native-client contract and are not even
// registered in a production process; each handler retains its own guard too.
if (process.env.NODE_ENV === 'development') {
  Object.assign(ROUTES, {
    'GET /v1/dev/entity-registry': getEntityRegistry,
    'GET /v1/dev/entity-rows': getEntityRows,
    'GET /v1/dev/scrape-status': getScrapeStatus,
    'GET /v1/dev/data-explorer': getDataExplorer,
  });
}

/** Collects the request body, refusing anything past {@link MAX_BODY_BYTES}. */
function readBody(request: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

function send(
  response: http.ServerResponse,
  status: number,
  payload: unknown,
  headers: Record<string, string> = {}
): void {
  const merged: Record<string, string> = {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': `content-type, if-none-match, ${ENVIRONMENT_TOKEN_HEADER}`,
    ...headers,
  };
  if (payload === null || status === 304) {
    response.writeHead(status, merged);
    response.end();
    return;
  }
  // A stream is handed to the client as it arrives rather than serialised.
  if (payload instanceof ReadableStream) {
    response.writeHead(status, merged);
    Readable.fromWeb(payload as Parameters<typeof Readable.fromWeb>[0]).pipe(response);
    return;
  }
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    ...merged,
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  response.end(body);
}

async function handleRequest(
  incoming: http.IncomingMessage,
  response: http.ServerResponse,
  environmentToken?: string
): Promise<void> {
  const requestTarget = incoming.url ?? '/';
  const method = incoming.method ?? 'GET';

  if (
    !requestTarget.startsWith('/') ||
    requestTarget.length > MAX_REQUEST_TARGET_CHARS
  ) {
    const invalid = fail(400, 'INVALID_REQUEST', 'invalid request target');
    send(response, invalid.status, invalid.body);
    return;
  }

  let url: URL;
  try {
    // The Host header is untrusted request data and is not needed to route this
    // service. A fixed base prevents malformed Host values from reaching the
    // URL constructor and terminating the process through an unhandled reject.
    url = new URL(requestTarget, 'http://rockygpt-data.local');
  } catch {
    const invalid = fail(400, 'INVALID_REQUEST', 'invalid request target');
    send(response, invalid.status, invalid.body);
    return;
  }

  if (url.searchParams.size > MAX_QUERY_PARAMETERS) {
    const invalid = fail(400, 'INVALID_REQUEST', 'too many query parameters');
    send(response, invalid.status, invalid.body);
    return;
  }

  // Browsers ask before a cross-origin read; native clients never do.
  if (method === 'OPTIONS') {
    send(response, 204, null, { 'access-control-allow-methods': 'GET, POST, OPTIONS' });
    return;
  }

  if (url.pathname !== '/health' && url.pathname !== '/readiness' &&
      !environmentAccessAllowed(incoming, environmentToken)) {
    send(response, 401, {
      error: { code: 'UNAUTHORIZED', message: 'Service authorization required.', retryable: false },
    });
    return;
  }

  const handler =
    ROUTES[`${method} ${url.pathname}`] ??
    (method === 'GET' && /^\/v1\/data\/[^/]+$/.test(url.pathname) ? getArtifact : undefined);

  if (!handler) {
    send(response, 404, fail(404, 'NOT_FOUND', `No route for ${method} ${url.pathname}`).body);
    return;
  }

  // Long-lived handlers need to know about a premature disconnect. The
  // request's `close` event also fires after an ordinary completed request on
  // modern Node versions, so using it directly would abort healthy handlers.
  const disconnected = new AbortController();
  incoming.once('aborted', () => disconnected.abort());
  response.once('close', () => {
    if (!response.writableEnded) disconnected.abort();
  });

  const request: ApiRequest = {
    method,
    url,
    headers: new Headers(incoming.headers as Record<string, string>),
    signal: disconnected.signal,
  };

  if (method !== 'GET' && method !== 'HEAD') {
    try {
      const raw = await readBody(incoming);
      request.body = raw ? JSON.parse(raw) : undefined;
    } catch {
      const invalid = fail(400, 'INVALID_REQUEST', 'invalid JSON body');
      send(response, invalid.status, invalid.body);
      return;
    }
  }

  try {
    const result = await handler(request);
    send(response, result.status, result.body, result.headers);
  } catch (error) {
    console.error(`${method} ${url.pathname} failed:`, error);
    const unavailable = fail(503, 'UNAVAILABLE', 'Campus data is unavailable.', true);
    send(response, unavailable.status, unavailable.body);
  }
}

/** Creates an unstarted server so integration tests can bind an ephemeral port. */
export function createDataServer(env: NodeJS.ProcessEnv = process.env): http.Server {
  const service = http.createServer((incoming, response) => {
    void handleRequest(incoming, response, env.STAGING_SERVICE_TOKEN).catch((error) => {
      // This is the final process boundary. No malformed request or unexpected
      // route bug is allowed to become an unhandled rejection that exits Node.
      console.error('Unhandled data request failure:', error);
      if (response.headersSent || response.destroyed) {
        response.destroy();
        return;
      }
      const unavailable = fail(503, 'UNAVAILABLE', 'Campus data is unavailable.', true);
      send(response, unavailable.status, unavailable.body);
    });
  });
  service.headersTimeout = 10_000;
  service.requestTimeout = 20_000;
  service.keepAliveTimeout = 5_000;
  service.maxRequestsPerSocket = 100;
  service.on('clientError', (_error, socket) => {
    if (socket.writable) {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    }
  });
  return service;
}

export const server = createDataServer();

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log(`rockygpt-data listening on http://${HOST}:${PORT}`);
  });
}
