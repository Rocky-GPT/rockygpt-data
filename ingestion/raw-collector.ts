import fs from 'node:fs';
import { load } from 'cheerio';
import pLimit from 'p-limit';
import { fetchWithPolicy } from './http-client';
import { writeJsonFile, writeRawProvenance } from './pipeline-utils';
import { type RawDatasetV1, type RawPageV1, validateRawDatasetV1 } from './raw-types';

const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_ATTEMPTS = 2;
const DEFAULT_DETAIL_CONCURRENCY = 8;
const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

const DOCUMENT_EXTENSIONS = new Set([
  '.pdf',
  '.doc',
  '.docx',
  '.xls',
  '.xlsx',
  '.ppt',
  '.pptx',
  '.csv',
  '.txt',
]);

export interface RawCollectorOptions {
  dataset: string;
  seedUrls: string[];
  outputPath: string;
  allowedHost?: string;
  allowedHosts?: string[];
  timeoutMs?: number;
  attempts?: number;
  detailConcurrency?: number;
  maxDetailPages?: number;
  detailUrlFilter?: (url: URL) => boolean;
  minimumPages?: number;
  minimumSuccessfulPages?: number;
  minimumSeedSuccessRate?: number;
  minimumDetailSuccessRate?: number;
  minimumPreviousPageRatio?: number;
}

interface BuildRawPageFromHtmlOptions {
  url: string;
  html: string;
  sourceType: 'seed' | 'detail';
  fetchedAt?: string;
  statusCode?: number | null;
  allowedHost: string;
}

interface FetchHtmlResult {
  url: string;
  statusCode: number | null;
  html: string;
}

const CHALLENGE_PAGE_PATTERNS = [
  /\bhuman verification\b/i,
  /\bverify (?:that )?you are human\b/i,
  /\baws waf\b/i,
  /\brequest could not be satisfied\b/i,
  /\battention required\b[\s\S]{0,80}\bcloudflare\b/i,
  /\benable javascript and cookies to continue\b/i,
];

function cleanText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

export function isLikelyChallengeHtml(html: string): boolean {
  if (!html) return false;
  const sample = html.slice(0, 250_000);
  return CHALLENGE_PAGE_PATTERNS.some((pattern) => pattern.test(sample));
}

function normalizeUrl(raw: string): string {
  const parsed = new URL(raw);
  parsed.hash = '';
  return parsed.toString();
}

function resolveHttpUrl(rawHref: string, baseUrl: string): string | null {
  if (!rawHref) return null;
  const lowered = rawHref.toLowerCase();
  if (lowered.startsWith('mailto:') || lowered.startsWith('tel:') || lowered.startsWith('javascript:')) {
    return null;
  }

  try {
    const resolved = new URL(rawHref, baseUrl);
    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') {
      return null;
    }
    return normalizeUrl(resolved.toString());
  } catch {
    return null;
  }
}

function extensionFromUrl(url: string): string {
  try {
    const { pathname } = new URL(url);
    const lastDot = pathname.lastIndexOf('.');
    if (lastDot === -1) return '';
    return pathname.slice(lastDot).toLowerCase();
  } catch {
    return '';
  }
}

function sameHost(url: string, host: string): boolean {
  try {
    return urlHost(url) === host.toLowerCase();
  } catch {
    return false;
  }
}

function asSortedArray(values: Set<string>): string[] {
  return Array.from(values).sort((a, b) => a.localeCompare(b));
}

function isLikelyDocument(url: string): boolean {
  return DOCUMENT_EXTENSIONS.has(extensionFromUrl(url));
}

function extractSections($: ReturnType<typeof load>): RawPageV1['sections'] {
  const sections: RawPageV1['sections'] = [];

  $('h1, h2, h3, h4').each((_, element) => {
    const heading = cleanText($(element).text());
    if (!heading) return;

    const textParts: string[] = [];
    let sibling = $(element).next();
    while (sibling.length > 0 && textParts.length < 6) {
      if (sibling.is('h1, h2, h3, h4')) break;
      const candidates = sibling.is('p, li')
        ? sibling
        : sibling.find('p, li').slice(0, 3);
      candidates.each((__, candidate) => {
        const text = cleanText($(candidate).text());
        if (text && !textParts.includes(text)) textParts.push(text);
      });
      sibling = sibling.next();
    }

    const text = cleanText(textParts.join(' ')).slice(0, 2000);
    if (!text) return;

    sections.push({ heading, text });
  });

  if (sections.length === 0) {
    const fallback = cleanText(
      $('main, article, #content-block, [role="main"]').first().text() || $('body').text()
    ).slice(0, 2000);
    if (fallback) {
      sections.push({ heading: 'content', text: fallback });
    }
  }

  return sections.slice(0, 100);
}

function extractLists($: ReturnType<typeof load>): RawPageV1['lists'] {
  const lists: string[][] = [];

  $('ul, ol').each((_, element) => {
    const items = $(element)
      .find('li')
      .slice(0, 30)
      .toArray()
      .map((item) => cleanText($(item).text()))
      .filter(Boolean);

    if (items.length > 0) {
      lists.push(items);
    }
  });

  return lists.slice(0, 100);
}

function extractTables($: ReturnType<typeof load>): RawPageV1['tables'] {
  const tables: RawPageV1['tables'] = [];

  $('table').each((_, tableElement) => {
    const table = $(tableElement);

    let headers = table
      .find('thead th')
      .toArray()
      .map((cell) => cleanText($(cell).text()))
      .filter(Boolean);

    const rows = table
      .find('tbody tr')
      .toArray()
      .map((row) =>
        $(row)
          .find('th, td')
          .toArray()
          .map((cell) => cleanText($(cell).text()))
      )
      .filter((row) => row.some(Boolean));

    if (headers.length === 0 && rows.length > 0) {
      headers = rows[0];
    }

    if (headers.length > 0 || rows.length > 0) {
      tables.push({ headers, rows: rows.slice(0, 50) });
    }
  });

  return tables.slice(0, 20);
}

function extractContacts($: ReturnType<typeof load>): RawPageV1['contacts'] {
  const contactsMap = new Map<string, RawPageV1['contacts'][number]>();

  $('a[href^="mailto:"]').each((_, element) => {
    const href = $(element).attr('href') || '';
    const email = href.replace(/^mailto:/i, '').split('?')[0].trim();
    if (!email) return;

    const name = cleanText($(element).text()) || undefined;
    const office = cleanText($(element).closest('p, li, td, div').first().find('strong').first().text()) || undefined;

    contactsMap.set(`email:${email.toLowerCase()}`, {
      email,
      name,
      office,
    });
  });

  $('a[href^="tel:"]').each((_, element) => {
    const href = $(element).attr('href') || '';
    const phone = href.replace(/^tel:/i, '').trim();
    if (!phone) return;

    const name = cleanText($(element).text()) || undefined;
    const key = `phone:${phone}`;
    const existing = contactsMap.get(key);

    contactsMap.set(key, {
      ...existing,
      phone,
      name: existing?.name ?? name,
    });
  });

  return Array.from(contactsMap.values());
}

function extractDocuments($: ReturnType<typeof load>, baseUrl: string): RawPageV1['documents'] {
  const documentsMap = new Map<string, RawPageV1['documents'][number]>();

  $('a[href]').each((_, element) => {
    const href = $(element).attr('href');
    if (!href) return;

    const resolved = resolveHttpUrl(href, baseUrl);
    if (!resolved) return;
    if (!isLikelyDocument(resolved)) return;

    const label = cleanText($(element).text()) || 'document';
    documentsMap.set(resolved, { label, url: resolved });
  });

  return Array.from(documentsMap.values());
}

export function buildRawPageFromHtml(options: BuildRawPageFromHtmlOptions): RawPageV1 {
  if (isLikelyChallengeHtml(options.html)) {
    throw new Error(`${options.url}: received a bot challenge or human-verification page.`);
  }

  const $ = load(options.html);
  $('script, style, noscript, template, svg, nav, footer, [role="navigation"]').remove();
  $('header').not('main header, article header, [role="main"] header').remove();
  const links = new Set<string>();
  const externalLinks = new Set<string>();

  $('a[href]').each((_, element) => {
    const href = $(element).attr('href');
    if (!href) return;

    const resolved = resolveHttpUrl(href, options.url);
    if (!resolved) return;

    if (sameHost(resolved, options.allowedHost)) {
      links.add(resolved);
    } else {
      externalLinks.add(resolved);
    }
  });

  const title = cleanText($('title').first().text()) || cleanText($('h1').first().text()) || null;

  return {
    url: normalizeUrl(options.url),
    sourceType: options.sourceType,
    fetchedAt: options.fetchedAt || new Date().toISOString(),
    statusCode: options.statusCode ?? 200,
    title,
    links: asSortedArray(links),
    externalLinks: asSortedArray(externalLinks),
    sections: extractSections($),
    lists: extractLists($),
    tables: extractTables($),
    contacts: extractContacts($),
    documents: extractDocuments($, options.url),
  };
}

function buildEmptyPage(url: string, sourceType: 'seed' | 'detail', statusCode: number | null): RawPageV1 {
  return {
    url: normalizeUrl(url),
    sourceType,
    fetchedAt: new Date().toISOString(),
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

async function fetchHtmlWithRetry(
  url: string,
  timeoutMs: number,
  attempts: number
): Promise<FetchHtmlResult> {
  try {
    const response = await fetchWithPolicy(
      url,
      {
        headers: {
          'User-Agent': DEFAULT_USER_AGENT,
          Accept: 'text/html,application/xhtml+xml',
        },
      },
      {
        timeoutMs,
        attempts,
        expectedContentTypes: ['text/html', 'application/xhtml+xml'],
      }
    );
    return {
      url: response.url || url,
      statusCode: response.status,
      html: response.text(),
    };
  } catch {
    return { url, statusCode: null, html: '' };
  }
}

function normalizeSeedUrls(seedUrls: string[]): string[] {
  return Array.from(new Set(seedUrls.map((url) => normalizeUrl(url))));
}

function configuredAllowedHosts(options: RawCollectorOptions): Set<string> {
  const hosts = new Set(
    [...(options.allowedHosts ?? []), ...(options.allowedHost ? [options.allowedHost] : [])]
      .map((host) => host.trim().toLowerCase())
      .filter(Boolean)
  );
  if (hosts.size === 0) {
    throw new Error(`${options.dataset}: at least one allowed host is required`);
  }
  return hosts;
}

function urlHost(url: string): string {
  return new URL(url).host.toLowerCase();
}

function successfulPage(page: RawPageV1): boolean {
  return page.statusCode !== null && page.statusCode >= 200 && page.statusCode < 400;
}

export function assertRawCollectionCandidate(
  dataset: RawDatasetV1,
  options: Pick<
    RawCollectorOptions,
    | 'outputPath'
    | 'minimumPages'
    | 'minimumSuccessfulPages'
    | 'minimumSeedSuccessRate'
    | 'minimumDetailSuccessRate'
    | 'minimumPreviousPageRatio'
  >
): void {
  if (dataset.pages.length < (options.minimumPages ?? 1)) {
    throw new Error(
      `${dataset.dataset}: collected ${dataset.pages.length} pages; expected at least ${options.minimumPages ?? 1}.`
    );
  }

  const successfulPages = dataset.pages.filter(successfulPage);
  if (
    options.minimumSuccessfulPages !== undefined &&
    successfulPages.length < options.minimumSuccessfulPages
  ) {
    throw new Error(
      `${dataset.dataset}: collected ${successfulPages.length} successful pages; expected at least ${options.minimumSuccessfulPages}.`
    );
  }

  if (options.minimumSeedSuccessRate !== undefined) {
    const seedPages = dataset.pages.filter((page) => page.sourceType === 'seed');
    const rate =
      dataset.seedUrls.length === 0
        ? 1
        : seedPages.filter(successfulPage).length / dataset.seedUrls.length;
    if (rate < options.minimumSeedSuccessRate) {
      throw new Error(
        `${dataset.dataset}: seed success rate ${(rate * 100).toFixed(1)}% is below ${(options.minimumSeedSuccessRate * 100).toFixed(0)}%.`
      );
    }
  }

  if (options.minimumDetailSuccessRate !== undefined) {
    const detailPages = dataset.pages.filter((page) => page.sourceType === 'detail');
    const rate =
      detailPages.length === 0
        ? 0
        : detailPages.filter(successfulPage).length / detailPages.length;
    if (rate < options.minimumDetailSuccessRate) {
      throw new Error(
        `${dataset.dataset}: detail success rate ${(rate * 100).toFixed(1)}% is below ${(options.minimumDetailSuccessRate * 100).toFixed(0)}%.`
      );
    }
  }

  if (
    options.minimumPreviousPageRatio !== undefined &&
    fs.existsSync(options.outputPath)
  ) {
    try {
      const previous = validateRawDatasetV1(
        JSON.parse(fs.readFileSync(options.outputPath, 'utf8')) as unknown
      );
      const floor = Math.ceil(previous.pages.length * options.minimumPreviousPageRatio);
      if (previous.pages.length > 0 && dataset.pages.length < floor) {
        throw new Error(
          `${dataset.dataset}: page count dropped from ${previous.pages.length} to ${dataset.pages.length}; minimum allowed is ${floor}.`
        );
      }
    } catch (error) {
      if (error instanceof Error && /page count dropped/.test(error.message)) throw error;
      console.warn(
        `${dataset.dataset}: previous raw dataset could not be used for regression comparison.`
      );
    }
  }
}

export async function collectRawDataset(options: RawCollectorOptions): Promise<RawDatasetV1> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const attempts = options.attempts ?? DEFAULT_ATTEMPTS;
  const detailConcurrency = options.detailConcurrency ?? DEFAULT_DETAIL_CONCURRENCY;
  const maxDetailPages = options.maxDetailPages ?? 200;
  const allowedHosts = configuredAllowedHosts(options);

  const normalizedSeedUrls = normalizeSeedUrls(options.seedUrls);
  const disallowedSeed = normalizedSeedUrls.find((url) => !allowedHosts.has(urlHost(url)));
  if (disallowedSeed) {
    throw new Error(
      `${options.dataset}: seed URL uses a host outside the allowlist (${disallowedSeed})`
    );
  }

  const pages: RawPageV1[] = [];
  const seenUrls = new Set<string>();
  const detailCandidates: string[] = [];

  for (const seedUrl of normalizedSeedUrls) {
    const fetched = await fetchHtmlWithRetry(seedUrl, timeoutMs, attempts);
    const seedPage = fetched.html
      ? buildRawPageFromHtml({
          url: fetched.url,
          html: fetched.html,
          sourceType: 'seed',
          statusCode: fetched.statusCode,
          allowedHost: urlHost(fetched.url),
        })
      : buildEmptyPage(fetched.url, 'seed', fetched.statusCode);

    pages.push(seedPage);
    seenUrls.add(seedPage.url);

    seedPage.links.forEach((link) => {
      if (seenUrls.has(link)) return;
      if (!allowedHosts.has(urlHost(link))) return;
      if (options.detailUrlFilter) {
        try {
          if (!options.detailUrlFilter(new URL(link))) {
            return;
          }
        } catch {
          return;
        }
      }
      detailCandidates.push(link);
      seenUrls.add(link);
    });
  }

  const uniqueDetails = Array.from(new Set(detailCandidates)).slice(0, maxDetailPages);
  const detailFetchLimit = pLimit(detailConcurrency);

  const detailPages = await Promise.all(
    uniqueDetails.map((detailUrl) =>
      detailFetchLimit(async () => {
        const fetched = await fetchHtmlWithRetry(detailUrl, timeoutMs, attempts);
        if (!fetched.html) {
          return buildEmptyPage(fetched.url, 'detail', fetched.statusCode);
        }
        return buildRawPageFromHtml({
          url: fetched.url,
          html: fetched.html,
          sourceType: 'detail',
          statusCode: fetched.statusCode,
          allowedHost: urlHost(fetched.url),
        });
      })
    )
  );

  pages.push(...detailPages);

  const externalLinksSeen = new Set<string>();
  pages.forEach((page) => {
    page.externalLinks.forEach((link) => externalLinksSeen.add(link));
  });

  const pagesFetched = pages.filter(
    (page) => page.statusCode !== null && page.statusCode >= 200 && page.statusCode < 400
  ).length;

  const dataset: RawDatasetV1 = {
    version: '1.0',
    dataset: options.dataset,
    collectedAt: new Date().toISOString(),
    seedUrls: normalizedSeedUrls,
    stats: {
      pagesFetched,
      pagesFailed: pages.length - pagesFetched,
      externalLinksSeen: externalLinksSeen.size,
    },
    pages,
  };

  assertRawCollectionCandidate(dataset, options);
  writeJsonFile(options.outputPath, dataset);
  // PROB-002: record source-native provenance so the publish gate can verify
  // this source was actually collected (covers the six core static sources
  // that share this collector: safety, transportation, directory, housing,
  // health, counseling).
  writeRawProvenance(options.dataset, {
    sourceUrl: normalizedSeedUrls[0],
    recordCount: pages.length,
    payload: dataset,
  });
  return dataset;
}
