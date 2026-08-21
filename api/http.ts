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
}

/** What a handler returns. */
export interface ApiResponse {
  status: number;
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
