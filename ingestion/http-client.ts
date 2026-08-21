import pLimit from 'p-limit';

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_ATTEMPTS = 3;
const DEFAULT_MAX_RESPONSE_BYTES = 12 * 1024 * 1024;
const DEFAULT_PER_HOST_CONCURRENCY = 8;
const DEFAULT_BACKOFF_MS = 400;
const MAX_BACKOFF_MS = 30_000;
const DEFAULT_USER_AGENT =
  'RockyGPTDataCollector/1.0 (Ramapo College public-data refresh)';
const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
const IDEMPOTENT_METHODS = new Set(['GET', 'HEAD', 'OPTIONS', 'PUT', 'DELETE']);

const hostLimiters = new Map<string, ReturnType<typeof pLimit>>();

export interface HttpPolicyOptions {
  timeoutMs?: number;
  attempts?: number;
  maxResponseBytes?: number;
  perHostConcurrency?: number;
  backoffBaseMs?: number;
  expectedContentTypes?: string[];
  retryNonIdempotent?: boolean;
  userAgent?: string;
  etag?: string;
  lastModified?: string;
}

export interface CollectedHttpResponse {
  ok: boolean;
  status: number;
  statusText: string;
  url: string;
  headers: Headers;
  body: Uint8Array;
  text(): string;
  json<T = unknown>(): T;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

function limiterFor(url: URL, concurrency: number): ReturnType<typeof pLimit> {
  const key = `${url.protocol}//${url.host}`;
  let limiter = hostLimiters.get(key);
  if (!limiter) {
    limiter = pLimit(concurrency);
    hostLimiters.set(key, limiter);
  }
  return limiter;
}

function retryAfterMs(headers: Headers): number | null {
  const raw = headers.get('retry-after');
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(MAX_BACKOFF_MS, seconds * 1000);
  }
  const timestamp = Date.parse(raw);
  if (!Number.isFinite(timestamp)) return null;
  return Math.min(MAX_BACKOFF_MS, Math.max(0, timestamp - Date.now()));
}

function backoffMs(attempt: number, baseMs: number, headers?: Headers): number {
  const retryAfter = headers ? retryAfterMs(headers) : null;
  if (retryAfter !== null) return retryAfter;
  const exponential = Math.min(MAX_BACKOFF_MS, baseMs * 2 ** Math.max(0, attempt - 1));
  const jitter = Math.floor(Math.random() * Math.max(1, Math.floor(baseMs / 2)));
  return Math.min(MAX_BACKOFF_MS, exponential + jitter);
}

async function wait(ms: number): Promise<void> {
  if (ms <= 0) return;
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function readBoundedBody(response: Response, maximumBytes: number): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      length += value.byteLength;
      if (length > maximumBytes) {
        await reader.cancel();
        throw new Error(
          `Response exceeded the ${maximumBytes}-byte collection limit (${response.url}).`
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function collectedResponse(response: Response, body: Uint8Array): CollectedHttpResponse {
  return {
    ok: response.ok,
    status: response.status,
    statusText: response.statusText,
    url: response.url,
    headers: response.headers,
    body,
    text: () => new TextDecoder().decode(body),
    json: <T = unknown>() => JSON.parse(new TextDecoder().decode(body)) as T,
  };
}

function validateContentType(
  response: CollectedHttpResponse,
  expectedContentTypes: string[]
): void {
  if (!response.ok || response.status === 204 || response.status === 304) return;
  if (!expectedContentTypes.length) return;
  const actual = response.headers.get('content-type')?.toLowerCase() || '';
  if (!expectedContentTypes.some((expected) => actual.includes(expected.toLowerCase()))) {
    throw new Error(
      `Unexpected content type "${actual || 'missing'}" for ${response.url}; expected ${expectedContentTypes.join(' or ')}.`
    );
  }
}

async function requestOnce(
  url: URL,
  init: RequestInit,
  policy: Required<
    Pick<
      HttpPolicyOptions,
      'timeoutMs' | 'maxResponseBytes' | 'perHostConcurrency' | 'userAgent'
    >
  > &
    Pick<HttpPolicyOptions, 'etag' | 'lastModified'>
): Promise<CollectedHttpResponse> {
  const limiter = limiterFor(url, policy.perHostConcurrency);
  return limiter(async () => {
    const controller = new AbortController();
    const externalSignal = init.signal;
    const abortFromExternal = () => controller.abort(externalSignal?.reason);
    if (externalSignal) {
      if (externalSignal.aborted) abortFromExternal();
      else externalSignal.addEventListener('abort', abortFromExternal, { once: true });
    }
    const timeout = setTimeout(
      () => controller.abort(new Error(`Request timed out after ${policy.timeoutMs}ms.`)),
      policy.timeoutMs
    );
    const headers = new Headers(init.headers);
    if (!headers.has('user-agent')) headers.set('user-agent', policy.userAgent);
    if (policy.etag && !headers.has('if-none-match')) {
      headers.set('if-none-match', policy.etag);
    }
    if (policy.lastModified && !headers.has('if-modified-since')) {
      headers.set('if-modified-since', policy.lastModified);
    }

    try {
      const response = await fetch(url, {
        ...init,
        headers,
        signal: controller.signal,
      });
      const body = await readBoundedBody(response, policy.maxResponseBytes);
      return collectedResponse(response, body);
    } finally {
      clearTimeout(timeout);
      externalSignal?.removeEventListener('abort', abortFromExternal);
    }
  });
}

export async function fetchWithPolicy(
  input: string | URL,
  init: RequestInit = {},
  options: HttpPolicyOptions = {}
): Promise<CollectedHttpResponse> {
  const url = input instanceof URL ? input : new URL(input);
  const timeoutMs = positiveInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS);
  const attempts = positiveInteger(options.attempts, DEFAULT_ATTEMPTS);
  const maxResponseBytes = positiveInteger(
    options.maxResponseBytes,
    DEFAULT_MAX_RESPONSE_BYTES
  );
  const perHostConcurrency = positiveInteger(
    options.perHostConcurrency,
    DEFAULT_PER_HOST_CONCURRENCY
  );
  const backoffBaseMs = positiveInteger(options.backoffBaseMs, DEFAULT_BACKOFF_MS);
  const expectedContentTypes = options.expectedContentTypes || [];
  const method = (init.method || 'GET').toUpperCase();
  const mayRetryMethod =
    IDEMPOTENT_METHODS.has(method) || options.retryNonIdempotent === true;
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await requestOnce(url, init, {
        timeoutMs,
        maxResponseBytes,
        perHostConcurrency,
        userAgent: options.userAgent || DEFAULT_USER_AGENT,
        etag: options.etag,
        lastModified: options.lastModified,
      });
      const shouldRetry =
        mayRetryMethod && RETRYABLE_STATUSES.has(response.status) && attempt < attempts;
      if (shouldRetry) {
        await wait(backoffMs(attempt, backoffBaseMs, response.headers));
        continue;
      }
      validateContentType(response, expectedContentTypes);
      return response;
    } catch (error) {
      lastError = error;
      if (!mayRetryMethod || attempt >= attempts || init.signal?.aborted) {
        break;
      }
      await wait(backoffMs(attempt, backoffBaseMs));
    }
  }

  const message = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`HTTP collection failed for ${method} ${url.toString()}: ${message}`);
}
