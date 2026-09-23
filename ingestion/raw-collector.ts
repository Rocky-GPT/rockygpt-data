import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { load } from 'cheerio';
import type { AnyNode } from 'domhandler';
import pLimit from 'p-limit';
import { fetchWithPolicy } from './http-client';
import { writeJsonFile, writeRawProvenance } from './pipeline-utils';
import { type RawDatasetV1, type RawPageV1, validateRawDatasetV1 } from './raw-types';

const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_ATTEMPTS = 2;
const DEFAULT_DETAIL_CONCURRENCY = 8;
const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
const SECTION_HEADINGS = 'h1, h2, h3, h4, h5, h6, summary, [role="heading"], .collapsableTitle';

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
  /** Opt-in source retention for bounded policy/service crawls, never detail feeds by default. */
  retainSourceHtml?: boolean;
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
  contentType: string;
}

export interface RawSourceCaptureV1 {
  schemaVersion: 1;
  dataset: string;
  generatedAt: string;
  pages: Array<FetchHtmlResult & { requestedUrl: string; sourceType: 'seed' | 'detail'; fetchedAt: string; contentHash: string }>;
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

function resolveHttpUrl(rawHref: string, baseUrl: string, preserveFragment = false): string | null {
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
    return preserveFragment ? resolved.toString() : normalizeUrl(resolved.toString());
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

/** Keep a source label next to its destination, including section anchors. */
function textWithLinks($: ReturnType<typeof load>, element: AnyNode, baseUrl: string): string {
  const copy = $(element).clone();
  copy.find('a[href]').addBack('a[href]').each((_, anchor) => {
    const link = $(anchor);
    const resolved = resolveHttpUrl(link.attr('href') || '', baseUrl, true);
    if (!resolved) return;
    const label = cleanText(link.text()) || cleanText(link.attr('aria-label') || link.attr('title')
      || link.find('img[alt]').first().attr('alt') || '');
    link.text(label && label !== resolved ? `${label} (${resolved})` : resolved);
  });
  return cleanText(copy.text());
}

function extractSections($: ReturnType<typeof load>, baseUrl: string, initialHeading: string): RawPageV1['sections'] {
  const sections: RawPageV1['sections'] = [];
  let heading = cleanText($('h1').first().text()) || initialHeading || 'Overview';
  let parts: string[] = [];
  const flush = () => {
    if (parts.length) sections.push({ heading, text: parts.join(' ') });
    parts = [];
  };
  // Walk in document order, including tables and nested content wrappers.
  // Never clip a policy at a paragraph/character count: later chunks bound reads.
  $(`#content-block, ${SECTION_HEADINGS}, p, li, table, a[href]`).each((_, element) => {
    const node = $(element);
    if (node.is('#content-block')) {
      // Ramapo's main column follows a sidebar with headings such as "Related
      // Resources". Those headings do not describe the subsequent page body.
      flush();
      heading = initialHeading || 'Overview';
      return;
    }
    if (node.is(SECTION_HEADINGS)) {
      flush();
      heading = textWithLinks($, element, baseUrl) || heading;
      return;
    }
    if (node.parents('li, table').length) return;
    // An anchor already represented in a text block must not become a duplicate
    // section entry. Standalone buttons/links still need their own retained text.
    if (node.is('a') && node.parents(`p, ${SECTION_HEADINGS}`).length) return;
    const text = node.is('table')
      ? node.find('tr').toArray().map((row) => $(row).find('th, td').toArray()
        .map((cell) => textWithLinks($, cell, baseUrl)).join(' | ')).join('; ')
      : textWithLinks($, element, baseUrl);
    if (text && !parts.includes(text)) parts.push(text);
  });
  flush();
  if (!sections.length) {
    const region = $('main, article, #content-block, [role="main"]').first();
    const element = region[0] || $('body')[0];
    const text = element ? textWithLinks($, element, baseUrl) : '';
    if (text) sections.push({ heading, text });
  }
  return sections;
}

function extractLists($: ReturnType<typeof load>, baseUrl: string): RawPageV1['lists'] {
  const lists: string[][] = [];

  $('ul, ol').each((_, element) => {
    const items = $(element)
      .find('li')
      .toArray()
      .map((item) => textWithLinks($, item, baseUrl))
      .filter(Boolean);

    if (items.length > 0) {
      lists.push(items);
    }
  });

  return lists;
}

function extractTables($: ReturnType<typeof load>, baseUrl: string): RawPageV1['tables'] {
  const tables: RawPageV1['tables'] = [];

  $('table').each((_, tableElement) => {
    const table = $(tableElement);

    let headers = table
      .find('thead th')
      .toArray()
      .map((cell) => textWithLinks($, cell, baseUrl))
      .filter(Boolean);

    const rows = table
      .find('tbody tr')
      .toArray()
      .map((row) =>
        $(row)
          .find('th, td')
          .toArray()
          .map((cell) => textWithLinks($, cell, baseUrl))
      )
      .filter((row) => row.some(Boolean));

    if (headers.length === 0 && rows.length > 0) {
      headers = rows[0];
    }

    if (headers.length > 0 || rows.length > 0) {
      tables.push({ headers, rows });
    }
  });

  return tables;
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

  const document = load(options.html);
  document('script, style, noscript, template, svg, nav, footer, [role="navigation"]').remove();
  document('header').not('main header, article header, [role="main"] header').remove();
  const initialHeading = document('h1').toArray().map(element => cleanText(document(element).text())).find(Boolean) || '';
  const title = cleanText(document('title').first().text()) || initialHeading || null;
  // Site-wide links outside the declared content region are not page evidence.
  // Retain the document fallback for pages that do not declare such a region.
  const region = document('main, #content-block, article, [role="main"]').first();
  const $ = region.length ? load(region.html() || '') : document;
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

  // The site's WordPress sidebar menu is not marked up as <nav>. Its links are
  // useful crawl discovery above, but should not be asserted as page prose.
  $('#left-nav-ul, ul.subnav, #breadcrumbs').remove();

  return {
    url: normalizeUrl(options.url),
    sourceType: options.sourceType,
    fetchedAt: options.fetchedAt || new Date().toISOString(),
    statusCode: options.statusCode === undefined ? 200 : options.statusCode,
    title,
    links: asSortedArray(links),
    externalLinks: asSortedArray(externalLinks),
    sections: extractSections($, options.url, initialHeading),
    lists: extractLists($, options.url),
    tables: extractTables($, options.url),
    contacts: extractContacts($),
    documents: extractDocuments($, options.url),
  };
}

function buildEmptyPage(url: string, sourceType: 'seed' | 'detail', statusCode: number | null, fetchedAt?: string): RawPageV1 {
  return {
    url: normalizeUrl(url),
    sourceType,
    fetchedAt: fetchedAt || new Date().toISOString(),
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

/** Reparse retained sources without network access, writes or newer collection times. */
export function replayRawSourceCapture(capture: RawSourceCaptureV1): RawDatasetV1 {
  if (capture.schemaVersion !== 1) throw new Error('Unsupported raw source capture schema version');
  const pages = capture.pages.map(source => {
    if (createHash('sha256').update(source.html).digest('hex') !== source.contentHash) {
      throw new Error(`Source capture content hash mismatch: ${source.requestedUrl}`);
    }
    return source.html ? buildRawPageFromHtml({url:source.url,html:source.html,sourceType:source.sourceType,
      fetchedAt:source.fetchedAt,statusCode:source.statusCode,allowedHost:urlHost(source.url)})
      : buildEmptyPage(source.url,source.sourceType,source.statusCode,source.fetchedAt);
  });
  const pagesFetched = pages.filter(successfulPage).length;
  return {version:'1.0',dataset:capture.dataset,collectedAt:capture.generatedAt,
    seedUrls:normalizeSeedUrls(capture.pages.filter(source => source.sourceType === 'seed').map(source => source.requestedUrl)),
    stats:{pagesFetched,pagesFailed:pages.length-pagesFetched,
      externalLinksSeen:new Set(pages.flatMap(page => page.externalLinks)).size},pages};
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
      contentType: response.headers.get('content-type') || '',
    };
  } catch {
    return { url, statusCode: null, html: '', contentType: '' };
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
      const previousCount = previous.pages.filter(successfulPage).length;
      const floor = Math.ceil(previousCount * options.minimumPreviousPageRatio);
      if (previousCount > 0 && successfulPages.length < floor) {
        throw new Error(
          `${dataset.dataset}: successful page count dropped from ${previousCount} to ${successfulPages.length}; minimum allowed is ${floor}.`
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
  const seenUrls = new Set<string>(normalizedSeedUrls);
  const detailCandidates: string[] = [];
  const sourcePages: RawSourceCaptureV1['pages'] = [];
  async function fetchSource(url: string, sourceType: 'seed' | 'detail'): Promise<FetchHtmlResult & { fetchedAt: string }> {
    const fetched = await fetchHtmlWithRetry(url, timeoutMs, attempts);
    const fetchedAt = new Date().toISOString();
    if (options.retainSourceHtml) sourcePages.push({ ...fetched, requestedUrl: url, sourceType,
      fetchedAt, contentHash: createHash('sha256').update(fetched.html).digest('hex') });
    return { ...fetched, fetchedAt };
  }

  try {
    for (const seedUrl of normalizedSeedUrls) {
      const fetched = await fetchSource(seedUrl, 'seed');
      const seedPage = fetched.html
        ? buildRawPageFromHtml({
            url: fetched.url,
            html: fetched.html,
            sourceType: 'seed',
            fetchedAt: fetched.fetchedAt,
            statusCode: fetched.statusCode,
            allowedHost: urlHost(fetched.url),
          })
        : buildEmptyPage(fetched.url, 'seed', fetched.statusCode, fetched.fetchedAt);

      pages.push(seedPage);
      seenUrls.add(seedPage.url);

      seedPage.links.forEach((link) => {
        if (seenUrls.has(link)) return;
        if (!allowedHosts.has(urlHost(link))) return;
        // Documents remain in the page's documents list. The HTML collector
        // cannot parse them; requesting them as HTML creates spurious failed
        // pages and can crowd real detail pages out of the bounded crawl.
        if (isLikelyDocument(link)) return;
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

    const detailResults = await Promise.allSettled(
      uniqueDetails.map((detailUrl) =>
        detailFetchLimit(async () => {
          const fetched = await fetchSource(detailUrl, 'detail');
          if (!fetched.html) {
            return buildEmptyPage(fetched.url, 'detail', fetched.statusCode, fetched.fetchedAt);
          }
          return buildRawPageFromHtml({
            url: fetched.url,
            html: fetched.html,
            sourceType: 'detail',
            fetchedAt: fetched.fetchedAt,
            statusCode: fetched.statusCode,
            allowedHost: urlHost(fetched.url),
          });
        })
      )
    );

    // Await every in-flight request before persisting captures in finally.
    const failedDetail = detailResults.find(result => result.status === 'rejected');
    if (failedDetail?.status === 'rejected') throw failedDetail.reason;
    const detailPages = detailResults.flatMap(result => result.status === 'fulfilled' ? [result.value] : []);

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
      fetchedAt: dataset.collectedAt,
    }, path.dirname(options.outputPath));
    return dataset;
  } finally {
    // Keep the original pages even if parsing or a coverage gate fails. The
    // parsed JSON alone cannot reveal content that the parser silently omitted.
    if (options.retainSourceHtml) {
      const payload: RawSourceCaptureV1 = { schemaVersion: 1, dataset: options.dataset,
        generatedAt: new Date().toISOString(), pages: sourcePages };
      const rawDir = path.dirname(options.outputPath);
      writeJsonFile(path.join(rawDir, `${options.dataset}-sources.raw.json`), payload);
      const oldestFetch = sourcePages.map(page => page.fetchedAt).sort()[0];
      writeRawProvenance(`${options.dataset}-sources`, { sourceUrl: normalizedSeedUrls[0],
        recordCount: sourcePages.length, payload, fetchedAt: oldestFetch || payload.generatedAt }, rawDir);
    }
  }
}
