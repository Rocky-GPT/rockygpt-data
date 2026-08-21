/**
 * @module api/server
 * The HTTP service for campus data.
 *
 * The web app used to read this package directly, which made it both a client
 * and a server: every route that served a menu or a directory listing was a
 * Next.js handler importing the repository layer. Nothing else could reach that
 * data — a native client, or anything not written in TypeScript, had no way in.
 *
 * Behind HTTP the web app becomes one client among several, and a second one,
 * in whatever language, is an ordinary thing to build rather than a rewrite.
 *
 * Campus data is public and read-mostly, so responses are cacheable and
 * cross-origin reads are allowed. Nothing here writes.
 */

import 'dotenv/config';
import http from 'node:http';
import { Readable } from 'node:stream';
import { getArtifact } from './routes/artifacts';
import { getHealth, getReadiness } from './routes/health';
import { getDataExplorer, getEntityRegistry, getScrapeStatus } from './routes/dev';
import { getDiningHours } from './routes/dining-hours';
import { postFeedback } from './routes/feedback';
import { getLogs } from './routes/logs';
import { postLogFeedback } from './routes/logs-feedback';
import { getLogsStream } from './routes/logs-stream';
import { getDirectory } from './routes/directory';
import { getMap } from './routes/map';
import { getMenu } from './routes/menu';
import { getMenuBrowse } from './routes/menu-browse';
import { getShuttle } from './routes/shuttle';
import { fail, type ApiHandler, type ApiRequest } from './http';

const PORT = Number(process.env.DATA_PORT || 8100);
const HOST = process.env.DATA_HOST || '127.0.0.1';

/** A whole request body of JSON, with room to spare; larger than this is junk. */
const MAX_BODY_BYTES = 256 * 1024;

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
  'POST /v1/feedback': postFeedback,
  'GET /v1/logs': getLogs,
  'POST /v1/logs/feedback': postLogFeedback,
  'GET /v1/logs/stream': getLogsStream,
  'GET /v1/dev/entity-registry': getEntityRegistry,
  'GET /v1/dev/scrape-status': getScrapeStatus,
  'GET /v1/dev/data-explorer': getDataExplorer,
};

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
    'access-control-allow-headers': 'content-type, if-none-match',
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

export const server = http.createServer((incoming, response) => {
  void (async () => {
    const url = new URL(incoming.url ?? '/', `http://${incoming.headers.host ?? 'localhost'}`);
    const method = incoming.method ?? 'GET';

    // Browsers ask before a cross-origin read; native clients never do.
    if (method === 'OPTIONS') {
      send(response, 204, null, { 'access-control-allow-methods': 'GET, OPTIONS' });
      return;
    }

    const handler =
      ROUTES[`${method} ${url.pathname}`] ??
      (method === 'GET' && url.pathname.startsWith('/v1/data/') ? getArtifact : undefined);

    if (!handler) {
      send(response, 404, fail(404, 'NOT_FOUND', `No route for ${method} ${url.pathname}`).body);
      return;
    }

    // Long-lived handlers need to know when the client disconnects.
    const disconnected = new AbortController();
    incoming.on('close', () => disconnected.abort());

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
  })();
});

server.listen(PORT, HOST, () => {
  console.log(`rockygpt-data listening on http://${HOST}:${PORT}`);
});
