import path from 'path';
import * as vm from 'node:vm';
import { load } from 'cheerio';
import pLimit from 'p-limit';
import { fetchWithPolicy } from './http-client';
import { writeJsonFile, writeRawProvenance } from './pipeline-utils';
import { assertRawCollectionCandidate, buildRawPageFromHtml } from './raw-collector';
import type { RawDatasetV1, RawPageV1 } from './raw-types';
import type {
  ProgramPayloadEntryV1,
  ProgramPayloadExtractionStatus,
  ProgramsPayloadRawV1,
} from './programs-payload-types';

const CATALOG_ORIGIN = 'https://catalog.ramapo.edu';
const CATALOG_HOST = 'catalog.ramapo.edu';
const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

const PROGRAMS_SEED_URL = `${CATALOG_ORIGIN}/programs`;
const A_TO_Z_MAJORS_URL = `${CATALOG_ORIGIN}/quicklinks/atozmajors`;
const DEPARTMENTS_SEED_URL = `${CATALOG_ORIGIN}/departments`;

const PROGRAMS_RAW_OUTPUT_PATH = path.join(process.cwd(), 'data', 'raw', 'programs.raw.json');
const PROGRAMS_PAYLOAD_OUTPUT_PATH = path.join(process.cwd(), 'data', 'raw', 'programs-payload.raw.json');

const DEFAULT_CONCURRENCY = 8;
const DEFAULT_TIMEOUT_MS = 20000;
const DEFAULT_ATTEMPTS = 2;
const DEFAULT_MAX_PROGRAM_URLS = 1000;
const DEFAULT_MAX_DEPARTMENT_IDS = 500;
const DEFAULT_INCLUDE_DEPARTMENT_TABS = true;
const DEFAULT_NUXT_VM_TIMEOUT_MS = 3000;

interface FetchHtmlResult {
  requestedUrl: string;
  url: string;
  statusCode: number | null;
  html: string;
  fetchedAt: string;
}

interface DiscoveryResult {
  seedUrls: string[];
  programUrls: string[];
  departmentUrls: string[];
  prefetchedByUrl: Map<string, FetchHtmlResult>;
}

interface CollectionOptions {
  concurrency: number;
  timeoutMs: number;
  attempts: number;
  maxProgramUrls: number;
  maxDepartmentIds: number;
  includeDepartmentTabs: boolean;
  cookie?: string;
  userAgent: string;
}

interface ProgramPayloadParseResult {
  extractionStatus: ProgramPayloadExtractionStatus;
  extractionError?: string;
  school?: string;
  activeCatalog?: string;
  program?: Record<string, unknown>;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  const normalized = value.trim().toLowerCase();
  if (normalized === '1' || normalized === 'true' || normalized === 'yes') return true;
  if (normalized === '0' || normalized === 'false' || normalized === 'no') return false;
  return fallback;
}

function getCollectionOptionsFromEnv(): CollectionOptions {
  const cookieRaw = process.env.PROGRAMS_RAW_COOKIE?.trim();
  const cookie = cookieRaw ? cookieRaw.replace(/[\r\n]+/g, '') : undefined;
  const userAgent = process.env.PROGRAMS_RAW_USER_AGENT?.trim() || DEFAULT_USER_AGENT;

  return {
    concurrency: parsePositiveInt(process.env.PROGRAMS_RAW_CONCURRENCY, DEFAULT_CONCURRENCY),
    timeoutMs: parsePositiveInt(process.env.PROGRAMS_RAW_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
    attempts: parsePositiveInt(process.env.PROGRAMS_RAW_ATTEMPTS, DEFAULT_ATTEMPTS),
    maxProgramUrls: parsePositiveInt(process.env.PROGRAMS_RAW_MAX_PROGRAM_URLS, DEFAULT_MAX_PROGRAM_URLS),
    maxDepartmentIds: parsePositiveInt(process.env.PROGRAMS_RAW_MAX_DEPARTMENT_IDS, DEFAULT_MAX_DEPARTMENT_IDS),
    includeDepartmentTabs: parseBoolean(
      process.env.PROGRAMS_RAW_INCLUDE_DEPARTMENT_TABS,
      DEFAULT_INCLUDE_DEPARTMENT_TABS
    ),
    cookie,
    userAgent,
  };
}

function canonicalizeUrl(raw: string): string {
  const parsed = new URL(raw);
  parsed.hash = '';
  if (parsed.pathname.length > 1 && parsed.pathname.endsWith('/')) {
    parsed.pathname = parsed.pathname.slice(0, -1);
  }
  return parsed.toString();
}

function isCatalogHost(url: URL): boolean {
  return url.host === CATALOG_HOST;
}

function toCatalogUrl(rawHref: string, baseUrl: string): string | null {
  if (!rawHref) return null;
  const lowered = rawHref.toLowerCase();
  if (lowered.startsWith('mailto:') || lowered.startsWith('tel:') || lowered.startsWith('javascript:')) {
    return null;
  }

  try {
    const resolved = new URL(rawHref, baseUrl);
    if ((resolved.protocol !== 'http:' && resolved.protocol !== 'https:') || !isCatalogHost(resolved)) {
      return null;
    }
    return canonicalizeUrl(resolved.toString());
  } catch {
    return null;
  }
}

function extractCatalogAnchorUrls(html: string, baseUrl: string): string[] {
  const $ = load(html);
  const urls = new Set<string>();
  $('a[href]').each((_, element) => {
    const href = $(element).attr('href') || '';
    const normalized = toCatalogUrl(href, baseUrl);
    if (normalized) urls.add(normalized);
  });
  return Array.from(urls).sort((a, b) => a.localeCompare(b));
}

export function parseProgramDetailUrlsFromAtoZHtml(html: string): string[] {
  const urls = extractCatalogAnchorUrls(html, A_TO_Z_MAJORS_URL);
  return urls
    .filter((url) => {
      const parsed = new URL(url);
      return /^\/programs\/[^/]+$/.test(parsed.pathname);
    })
    .sort((a, b) => a.localeCompare(b));
}

export function parseDepartmentIdsFromDepartmentsHtml(html: string): string[] {
  const urls = extractCatalogAnchorUrls(html, DEPARTMENTS_SEED_URL);
  const ids = new Set<string>();
  urls.forEach((url) => {
    const parsed = new URL(url);
    const match = parsed.pathname.match(/^\/departments\/([0-9a-f-]{36})\/overview$/i);
    if (match) {
      ids.add(match[1].toLowerCase());
    }
  });
  return Array.from(ids).sort((a, b) => a.localeCompare(b));
}

export function parseCourseCodesFromDepartmentCoursesHtml(html: string): string[] {
  const matches = html.match(/\b[A-Z]{4}\d{3}[A-Z]?\b/g) || [];
  return Array.from(new Set(matches)).sort((a, b) => a.localeCompare(b));
}

export function extractNuxtExpressionFromHtml(html: string): string | null {
  const markerMatch = /window\.__NUXT__\s*=\s*/.exec(html);
  if (!markerMatch || markerMatch.index === undefined) return null;
  const expressionStart = markerMatch.index + markerMatch[0].length;
  const scriptEnd = html.indexOf('</script>', expressionStart);
  if (scriptEnd === -1) return null;
  return html
    .slice(expressionStart, scriptEnd)
    .trim()
    .replace(/;$/, '');
}

function extractSchoolFromHtml(html: string): string | undefined {
  const match = html.match(/school:"([^"]+)"/);
  return match ? match[1] : undefined;
}

function extractActiveCatalogFromHtml(html: string): string | undefined {
  const match = html.match(/activeCatalog:"([^"]+)"/);
  return match ? match[1] : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function extractProgramFromNuxt(nuxtValue: unknown): Record<string, unknown> | null {
  if (!isRecord(nuxtValue) || !Array.isArray(nuxtValue.data)) {
    return null;
  }

  for (const entry of nuxtValue.data) {
    if (!isRecord(entry) || !isRecord(entry.program)) continue;
    return entry.program;
  }

  return null;
}

function evaluateNuxtExpression(expression: string, timeoutMs: number): unknown {
  const sandbox: { window: { __NUXT__?: unknown } } = { window: {} };
  vm.createContext(sandbox);
  vm.runInContext(`window.__NUXT__ = ${expression};`, sandbox, { timeout: timeoutMs });
  return sandbox.window.__NUXT__;
}

export function parseProgramPayloadFromHtml(
  html: string,
  vmTimeoutMs = DEFAULT_NUXT_VM_TIMEOUT_MS
): ProgramPayloadParseResult {
  if (!html) {
    return { extractionStatus: 'missing-html' };
  }

  const result: ProgramPayloadParseResult = {
    extractionStatus: 'missing-nuxt',
  };

  const school = extractSchoolFromHtml(html);
  if (school) {
    result.school = school;
  }

  const activeCatalog = extractActiveCatalogFromHtml(html);
  if (activeCatalog) {
    result.activeCatalog = activeCatalog;
  }

  const nuxtExpression = extractNuxtExpressionFromHtml(html);
  if (!nuxtExpression) {
    return result;
  }

  let nuxtValue: unknown;
  try {
    nuxtValue = evaluateNuxtExpression(nuxtExpression, vmTimeoutMs);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ...result,
      extractionStatus: 'eval-error',
      extractionError: message.slice(0, 400),
    };
  }

  const programPayload = extractProgramFromNuxt(nuxtValue);
  if (!programPayload) {
    return {
      ...result,
      extractionStatus: 'missing-program',
    };
  }

  return {
    ...result,
    extractionStatus: 'ok',
    program: programPayload,
  };
}

function setPrefetchedResult(map: Map<string, FetchHtmlResult>, result: FetchHtmlResult): void {
  map.set(canonicalizeUrl(result.requestedUrl), result);
  map.set(canonicalizeUrl(result.url), result);
}

async function fetchHtmlWithRetry(
  requestedUrl: string,
  timeoutMs: number,
  attempts: number,
  userAgent: string,
  cookie?: string
): Promise<FetchHtmlResult> {
  const normalizedRequested = canonicalizeUrl(requestedUrl);
  try {
    const response = await fetchWithPolicy(
      normalizedRequested,
      {
        headers: {
          'User-Agent': userAgent,
          Accept: 'text/html,application/xhtml+xml',
          ...(cookie ? { Cookie: cookie } : {}),
        },
      },
      {
        timeoutMs,
        attempts,
        expectedContentTypes: ['text/html', 'application/xhtml+xml'],
        perHostConcurrency: DEFAULT_CONCURRENCY,
      }
    );
    return {
      requestedUrl: normalizedRequested,
      url: canonicalizeUrl(response.url || normalizedRequested),
      statusCode: response.status,
      html: response.text(),
      fetchedAt: new Date().toISOString(),
    };
  } catch {
    return {
      requestedUrl: normalizedRequested,
      url: normalizedRequested,
      statusCode: null,
      html: '',
      fetchedAt: new Date().toISOString(),
    };
  }
}

function buildFailedRawPage(
  url: string,
  sourceType: 'seed' | 'detail',
  statusCode: number | null,
  fetchedAt: string
): RawPageV1 {
  return {
    url: canonicalizeUrl(url),
    sourceType,
    fetchedAt,
    statusCode,
    title: null,
    links: [],
    externalLinks: [],
    sections: [],
    lists: [],
    tables: [],
    contacts: [],
    documents: [],
  };
}

export function parseCourseCodesFromCatalogApiPayload(payload: unknown): string[] {
  let entries: unknown[] = [];
  if (Array.isArray(payload)) {
    entries = payload;
  } else if (isRecord(payload)) {
    if (Array.isArray(payload.data)) entries = payload.data;
    else if (Array.isArray(payload.results)) entries = payload.results;
    else if (Array.isArray(payload.courses)) entries = payload.courses;
  }

  const codes = new Set<string>();
  entries.forEach((entry) => {
    if (!isRecord(entry) || typeof entry.code !== 'string') return;
    const status = typeof entry.status === 'string' ? entry.status.toLowerCase() : '';
    if (status && status !== 'active') return;
    const code = entry.code.replace(/\s+/g, '').toUpperCase();
    if (/^[A-Z]{2,6}\d{3}[A-Z]?$/.test(code)) codes.add(code);
  });
  return Array.from(codes).sort((a, b) => a.localeCompare(b));
}

async function discoverUrls(options: CollectionOptions): Promise<DiscoveryResult> {
  const seedUrls = [PROGRAMS_SEED_URL, A_TO_Z_MAJORS_URL, DEPARTMENTS_SEED_URL].map(canonicalizeUrl);
  const prefetchedByUrl = new Map<string, FetchHtmlResult>();

  const [programsSeed, aToZSeed, departmentsSeed] = await Promise.all([
    fetchHtmlWithRetry(PROGRAMS_SEED_URL, options.timeoutMs, options.attempts, options.userAgent, options.cookie),
    fetchHtmlWithRetry(A_TO_Z_MAJORS_URL, options.timeoutMs, options.attempts, options.userAgent, options.cookie),
    fetchHtmlWithRetry(
      DEPARTMENTS_SEED_URL,
      options.timeoutMs,
      options.attempts,
      options.userAgent,
      options.cookie
    ),
  ]);
  setPrefetchedResult(prefetchedByUrl, programsSeed);
  setPrefetchedResult(prefetchedByUrl, aToZSeed);
  setPrefetchedResult(prefetchedByUrl, departmentsSeed);

  const aToZProgramUrls = parseProgramDetailUrlsFromAtoZHtml(aToZSeed.html);
  const programsPageProgramUrls = parseProgramDetailUrlsFromAtoZHtml(programsSeed.html);

  // Current Coursedog program API codes are not public catalog route slugs.
  // Only crawl program URLs explicitly published by the catalog HTML.
  const discoveredProgramUrls = Array.from(new Set([...aToZProgramUrls, ...programsPageProgramUrls]))
    .sort((a, b) => a.localeCompare(b))
    .slice(0, options.maxProgramUrls);
  const departmentIds = parseDepartmentIdsFromDepartmentsHtml(departmentsSeed.html).slice(0, options.maxDepartmentIds);

  const departmentUrls = new Set<string>();
  departmentIds.forEach((departmentId) => {
    departmentUrls.add(canonicalizeUrl(`${CATALOG_ORIGIN}/departments/${departmentId}/overview`));
    departmentUrls.add(canonicalizeUrl(`${CATALOG_ORIGIN}/departments/${departmentId}/courses`));
    if (options.includeDepartmentTabs) {
      departmentUrls.add(canonicalizeUrl(`${CATALOG_ORIGIN}/departments/${departmentId}/programs`));
      departmentUrls.add(canonicalizeUrl(`${CATALOG_ORIGIN}/departments/${departmentId}/faculty`));
    }
  });

  return {
    seedUrls,
    programUrls: discoveredProgramUrls,
    departmentUrls: Array.from(departmentUrls).sort((a, b) => a.localeCompare(b)),
    prefetchedByUrl,
  };
}

function buildProgramsPayloadDataset(
  programUrls: string[],
  pageByUrl: Map<string, RawPageV1>,
  htmlByUrl: Map<string, string>
): ProgramsPayloadRawV1 {
  const vmTimeoutMs = parsePositiveInt(process.env.PROGRAMS_RAW_NUXT_VM_TIMEOUT_MS, DEFAULT_NUXT_VM_TIMEOUT_MS);
  const entries: ProgramPayloadEntryV1[] = [];
  let payloadsExtracted = 0;

  programUrls.forEach((programUrl) => {
    const page = pageByUrl.get(programUrl);
    const html = htmlByUrl.get(programUrl) || '';
    const parsedPayload = parseProgramPayloadFromHtml(html, vmTimeoutMs);
    const entry: ProgramPayloadEntryV1 = {
      url: programUrl,
      fetchedAt: page?.fetchedAt || new Date().toISOString(),
      statusCode: page?.statusCode ?? null,
      title: page?.title ?? null,
      extractionStatus: parsedPayload.extractionStatus,
    };

    if (parsedPayload.school) {
      entry.school = parsedPayload.school;
    }
    if (parsedPayload.activeCatalog) {
      entry.activeCatalog = parsedPayload.activeCatalog;
    }
    if (parsedPayload.extractionError) {
      entry.extractionError = parsedPayload.extractionError;
    }
    if (parsedPayload.program) {
      entry.program = parsedPayload.program;
      payloadsExtracted += 1;
    }

    entries.push(entry);
  });

  const pagesProcessed = entries.length;
  const extractionFailed = pagesProcessed - payloadsExtracted;
  const payloadParseSuccessRate = pagesProcessed > 0 ? payloadsExtracted / pagesProcessed : 0;

  return {
    version: '1.0',
    dataset: 'programs-payload',
    collectedAt: new Date().toISOString(),
    seedUrls: [PROGRAMS_SEED_URL, A_TO_Z_MAJORS_URL, DEPARTMENTS_SEED_URL],
    stats: {
      pagesProcessed,
      payloadsExtracted,
      extractionFailed,
      payloadParseSuccessRate,
    },
    entries,
  };
}

export async function collectProgramsRawDatasets(): Promise<{
  rawDataset: RawDatasetV1;
  payloadDataset: ProgramsPayloadRawV1;
}> {
  const options = getCollectionOptionsFromEnv();
  const discovery = await discoverUrls(options);

  const crawlTargetUrls = Array.from(
    new Set([
      ...discovery.seedUrls,
      ...discovery.programUrls,
      ...discovery.departmentUrls,
    ])
  ).sort((a, b) => a.localeCompare(b));

  const seedUrlSet = new Set(discovery.seedUrls.map(canonicalizeUrl));
  const htmlByUrl = new Map<string, string>();
  const pages: RawPageV1[] = [];
  const externalLinksSeen = new Set<string>();

  const crawlLimit = pLimit(options.concurrency);
  await Promise.all(
    crawlTargetUrls.map((targetUrl) =>
      crawlLimit(async () => {
        let fetched = discovery.prefetchedByUrl.get(targetUrl);
        if (!fetched) {
          fetched = await fetchHtmlWithRetry(
            targetUrl,
            options.timeoutMs,
            options.attempts,
            options.userAgent,
            options.cookie
          );
          setPrefetchedResult(discovery.prefetchedByUrl, fetched);
        }

        const sourceType: 'seed' | 'detail' = seedUrlSet.has(canonicalizeUrl(fetched.url)) ? 'seed' : 'detail';
        if (fetched.html) {
          const page = buildRawPageFromHtml({
            url: fetched.url,
            html: fetched.html,
            sourceType,
            fetchedAt: fetched.fetchedAt,
            statusCode: fetched.statusCode,
            allowedHost: CATALOG_HOST,
          });
          pages.push(page);
          htmlByUrl.set(canonicalizeUrl(page.url), fetched.html);
          page.externalLinks.forEach((link) => externalLinksSeen.add(link));
          return;
        }

        pages.push(buildFailedRawPage(fetched.url, sourceType, fetched.statusCode, fetched.fetchedAt));
      })
    )
  );

  const dedupedPages = new Map<string, RawPageV1>();
  pages.forEach((page) => {
    dedupedPages.set(canonicalizeUrl(page.url), page);
  });
  const uniquePages = Array.from(dedupedPages.values()).sort((a, b) => a.url.localeCompare(b.url));

  const pagesFetched = uniquePages.filter(
    (page) => page.statusCode !== null && page.statusCode >= 200 && page.statusCode < 400
  ).length;

  const rawDataset: RawDatasetV1 = {
    version: '1.0',
    dataset: 'programs',
    collectedAt: new Date().toISOString(),
    seedUrls: discovery.seedUrls,
    stats: {
      pagesFetched,
      pagesFailed: uniquePages.length - pagesFetched,
      externalLinksSeen: externalLinksSeen.size,
    },
    pages: uniquePages,
  };

  const pageByUrl = new Map(uniquePages.map((page) => [canonicalizeUrl(page.url), page]));
  const payloadDataset = buildProgramsPayloadDataset(
    discovery.programUrls.map(canonicalizeUrl),
    pageByUrl,
    htmlByUrl
  );

  assertRawCollectionCandidate(rawDataset, {
    outputPath: PROGRAMS_RAW_OUTPUT_PATH,
    minimumPages: 200,
    minimumSuccessfulPages: 200,
    minimumSeedSuccessRate: 1,
    minimumDetailSuccessRate: 0.75,
  });
  writeJsonFile(PROGRAMS_RAW_OUTPUT_PATH, rawDataset);
  writeJsonFile(PROGRAMS_PAYLOAD_OUTPUT_PATH, payloadDataset);
  writeRawProvenance('programs', { sourceUrl: PROGRAMS_SEED_URL, payload: rawDataset });

  return {
    rawDataset,
    payloadDataset,
  };
}

async function run() {
  console.log('Collecting catalog programs raw datasets...');
  const options = getCollectionOptionsFromEnv();
  console.log(
    `Settings: concurrency=${options.concurrency}, timeoutMs=${options.timeoutMs}, attempts=${options.attempts}, maxPrograms=${options.maxProgramUrls}, maxDepartments=${options.maxDepartmentIds}, includeDepartmentTabs=${options.includeDepartmentTabs}, cookieConfigured=${options.cookie ? 'true' : 'false'}, userAgentConfigured=${options.userAgent ? 'true' : 'false'}`
  );

  const { rawDataset, payloadDataset } = await collectProgramsRawDatasets();
  console.log(
    `Saved ${rawDataset.pages.length} pages to ${PROGRAMS_RAW_OUTPUT_PATH} (${rawDataset.stats.pagesFetched} fetched / ${rawDataset.stats.pagesFailed} failed)`
  );
  console.log(
    `Saved ${payloadDataset.entries.length} payload entries to ${PROGRAMS_PAYLOAD_OUTPUT_PATH} (success rate ${(payloadDataset.stats.payloadParseSuccessRate * 100).toFixed(1)}%)`
  );
}

if (process.argv[1]?.endsWith('programs-raw.ts')) {
  run().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error('Catalog programs raw collection failed:', message);
    process.exit(1);
  });
}
