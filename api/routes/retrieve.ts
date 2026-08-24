/** Bounded document retrieval for Hybrid V1. Retrieved text is untrusted data. */

import type {
  RetrieveAppliedFilters,
  RetrieveRequest,
  RetrieveResponse,
  WireEvidence,
  WireRetrievedChunk,
} from '../contract';
import { getRepositoryV2 } from '../../src/data-v2/repositories/index';
import type { EvidenceItem } from '../../src/data-v2/types';
import { fail, ok, type ApiHandler } from '../http';

const DEFAULT_TOP_K = 5;
const MAX_TOP_K = 20;
const MAX_QUERY_LENGTH = 500;
const MAX_DOMAINS = 8;
const REQUEST_KEYS = new Set(['query', 'domains', 'topK']);
const DOMAIN_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
const V2_HEADERS = { 'Cache-Control': 'no-store' };
const RETRIEVAL_ORDERING = [
  { field: 'score', direction: 'desc' as const },
  { field: 'chunkId', direction: 'asc' as const },
];

interface ParsedRetrieve {
  request: RetrieveRequest;
  filters: RetrieveAppliedFilters;
  topK: number;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseRequest(body: unknown): ParsedRetrieve | string {
  if (!isObject(body)) return 'Request body must be a JSON object.';
  const unknown = Object.keys(body).find((key) => !REQUEST_KEYS.has(key));
  if (unknown) return `Unknown request property: \`${unknown}\`.`;
  if (typeof body.query !== 'string') return '`query` must be a string.';
  const query = body.query.trim();
  if (!query || query.length > MAX_QUERY_LENGTH) {
    return `\`query\` must contain 1 to ${MAX_QUERY_LENGTH} characters.`;
  }

  let domains: string[] = [];
  if (body.domains !== undefined) {
    if (!Array.isArray(body.domains) || body.domains.length > MAX_DOMAINS) {
      return `\`domains\` must be an array of at most ${MAX_DOMAINS} domain identifiers.`;
    }
    if (!body.domains.every((value) => typeof value === 'string' && DOMAIN_PATTERN.test(value))) {
      return '`domains` entries must be lowercase domain identifiers.';
    }
    domains = [...new Set(body.domains as string[])].sort();
  }

  let topK = DEFAULT_TOP_K;
  if (body.topK !== undefined) {
    if (!Number.isInteger(body.topK) || (body.topK as number) < 1 || (body.topK as number) > MAX_TOP_K) {
      return `\`topK\` must be an integer from 1 to ${MAX_TOP_K}.`;
    }
    topK = body.topK as number;
  }

  const request: RetrieveRequest = {
    query,
    ...(domains.length > 0 ? { domains } : {}),
    ...(body.topK === undefined ? {} : { topK }),
  };
  return { request, filters: { query, domains }, topK };
}

function evidenceId(item: EvidenceItem): string {
  return `chunk:${item.id}`;
}

function toEvidence(item: EvidenceItem): WireEvidence {
  return {
    evidenceId: evidenceId(item),
    sourceId: item.sourceId,
    title: item.title,
    url: item.url,
    collectedAt: item.collectedAt,
  };
}

function toRecord(item: EvidenceItem): WireRetrievedChunk {
  return {
    chunkId: item.id,
    documentId: item.documentId,
    content: item.content,
    contentTrust: 'untrusted',
    domain: item.domain,
    trustTier: item.trustTier,
    score: item.score,
    evidenceIds: [evidenceId(item)],
  };
}

export const postRetrieve: ApiHandler = async (apiRequest) => {
  const parsed = parseRequest(apiRequest.body);
  if (typeof parsed === 'string') return fail(400, 'INVALID_REQUEST', parsed);

  const repository = getRepositoryV2();
  const dataset = await repository.getDatasetContext();
  const pinned = repository.withDataset(dataset);
  // One look-ahead row is enough to declare truncation without loading an
  // unbounded corpus into the service process.
  let matches: EvidenceItem[];
  try {
    matches = await pinned.searchDocuments(parsed.request.query, {
      domains: parsed.filters.domains,
      limit: parsed.topK + 1,
    });
  } catch {
    const unavailable: RetrieveResponse = {
      outcome: 'unavailable',
      records: [],
      completeness: {
        state: 'unknown',
        returned: 0,
        limit: parsed.topK,
        truncated: false,
        reason: 'dependency_unavailable',
      },
      appliedFilters: parsed.filters,
      ordering: RETRIEVAL_ORDERING,
      dataset,
      indexVersion: dataset.version,
      evidence: [],
      safeErrorCode: 'DOCUMENT_RETRIEVAL_UNAVAILABLE',
    };
    return {
      status: 503,
      body: unavailable,
      headers: { ...V2_HEADERS, 'X-RockyGPT-Release': dataset.version },
    };
  }
  const ordered = [...matches].sort(
    (left, right) => right.score - left.score || left.id.localeCompare(right.id)
  );
  const truncated = ordered.length > parsed.topK;
  const selected = ordered.slice(0, parsed.topK);
  const records = selected.map(toRecord);
  const body: RetrieveResponse = {
    outcome: records.length > 0 ? 'success' : 'no_match',
    records,
    completeness: {
      state: truncated ? 'partial' : 'complete',
      returned: records.length,
      ...(!truncated ? { matched: records.length } : {}),
      limit: parsed.topK,
      truncated,
      ...(truncated ? { reason: 'top_k' } : {}),
    },
    appliedFilters: parsed.filters,
    ordering: RETRIEVAL_ORDERING,
    dataset,
    indexVersion: dataset.version,
    evidence: selected.map(toEvidence),
  };
  return ok(body, { ...V2_HEADERS, 'X-RockyGPT-Release': dataset.version });
};
