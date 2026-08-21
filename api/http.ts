/**
 * @module api/http
 * The small amount of plumbing every route in this service shares.
 *
 * Handlers are plain functions from a request to a response. They never touch
 * `node:http`, which keeps the campus-data logic testable without a socket and
 * keeps the framework choice from leaking into thirty route files.
 */

import type { ApiError } from './contract';

/** What a handler is given. */
export interface ApiRequest {
  method: string;
  /** Already parsed, so handlers read query parameters without re-parsing. */
  url: URL;
  headers: Headers;
  /** Present for methods that carry one, already JSON-parsed. */
  body?: unknown;
  /**
   * Aborts when the client goes away. A handler holding a connection open
   * must listen to this, or its subscriptions outlive the request.
   */
  signal: AbortSignal;
}

/** What a handler returns. */
export interface ApiResponse {
  status: number;
  /**
   * Serialised as JSON, unless it is a {@link ReadableStream}, which the
   * server pipes to the client instead. That is how a handler holds a
   * connection open without reaching for node:http itself.
   */
  body: unknown;
  headers?: Record<string, string>;
}

export type ApiHandler = (request: ApiRequest) => Promise<ApiResponse> | ApiResponse;

/** A successful response, optionally with cache directives. */
export function ok(body: unknown, headers?: Record<string, string>): ApiResponse {
  return { status: 200, body, headers };
}

/** A failure, in the one shape {@link ApiError} describes. */
export function fail(
  status: number,
  code: ApiError['error']['code'],
  message: string,
  retryable = false
): ApiResponse {
  return { status, body: { error: { code, message, retryable } } };
}

/**
 * Campus data is public and read-mostly, so responses are cacheable and every
 * origin may read them. A browser client and a native client are treated
 * alike, which is the point of putting this behind HTTP at all.
 */
export const PUBLIC_READ_HEADERS: Record<string, string> = {
  'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=3600',
};

/**
 * An open event stream. The caller keeps the connection and receives events
 * until it disconnects, so caching and buffering are both disabled.
 */
export function eventStream(stream: ReadableStream): ApiResponse {
  return {
    status: 200,
    body: stream,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  };
}
