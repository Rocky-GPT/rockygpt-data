import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import { load } from 'cheerio';
import type { AnyNode } from 'domhandler';
import { DEFAULT_USER_AGENT, fetchWithPolicy, UnexpectedContentTypeError } from './http-client';
import { limit } from './limit';
import { noteSiteDownloads, SiteFetchBlockedError } from './site-guard';
import { writeJsonFile, writeRawProvenance } from './pipeline-utils';
import { type RawDatasetV1, type RawPageV1, validateRawDatasetV1 } from './raw-types';

const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_ATTEMPTS = 2;
const DEFAULT_DETAIL_CONCURRENCY = 8;
const SECTION_HEADINGS = 'h1, h2, h3, h4, h5, h6, summary, [role="heading"], .collapsableTitle';
/** A WordPress FAQ accordion's question line; its answer is the rest of its item. */
const FAQ_QUESTION = '.accordions .item > .question';

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
  /**
   * The previous capture's pages that still count toward minimumPreviousPageRatio. A source that
   * narrows what it collects leaves out the pages it no longer collects, so the narrower capture
   * is not taken for a failed one.
   */
  comparablePreviousPage?: (page: RawPageV1) => boolean;
  /** Opt-in source retention for bounded policy/service crawls, never detail feeds by default. */
  retainSourceHtml?: boolean;
  /** Keep retained HTML gzip-compressed, so a capture of thousands of pages stays small enough to read back. */
  compressSourceHtml?: boolean;
  /** Start each request at least this long after the previous one, so a large crawl reads the site gently. */
  requestIntervalMs?: number;
  /**
   * When the site's own sitemap says a page was last edited (WordPress lists each page's edit
   * time), or undefined. With retainSourceHtml, a page the last capture downloaded after that time
   * is reused without a request: Ramapo's pages send no validators, so this is the one way to know
   * a page has not changed without downloading it (11-16).
   */
  listedEditedAt?: (url: string) => string | undefined;
  /**
   * Nights between downloads of a page its sitemap says nobody edited, in case a part shared from
   * elsewhere (a sidebar, a list of posts) changed without an edit to the page.
   */
  listedReuseDays?: number;
  /**
   * Nights between downloads of a page no sitemap gives an edit time for (with retainSourceHtml).
   * Without it, such a page is downloaded on every collection.
   */
  undatedReuseDays?: number;
  /**
   * Nights between asks of a page that last answered "not found" (404 or 410) or was not a page at
   * all (an image or file at an address without an extension), with retainSourceHtml. Such a page
   * has nothing to read, so it is asked again only once a cycle, on its own night, in case it came
   * back. Without it, such a page is asked on every collection.
   */
  deadReuseDays?: number;
  /**
   * Other collectors' captures whose pages this one takes without a request: a successful page that
   * capture confirmed current within maxAgeHours (its fetchedAt). Two collectors that read the same
   * page then ask the site for it once (11-18: the reviewed contact pages are office pages).
   */
  sharedCaptures?: ReadonlyArray<{ path: string; maxAgeHours: number }>;
}

/** Nights between downloads of a page its sitemap says nobody edited (listedReuseDays), by default. */
export const LISTED_REUSE_DAYS = 28;

const DAY_MS = 86_400_000;
const nightOf = (time: number) => Math.floor(time / DAY_MS);

/** A page's own night in a cycle of `nights`, from its address, so a cycle's downloads spread evenly over its nights. */
export function ownNight(url: string, nights: number): number {
  return createHash('sha256').update(url).digest().readUInt32BE(0) % nights;
}

/**
 * Whether tonight's collection reuses a page's last download without a request. A page its sitemap
 * says was edited after that download is downloaded. Any other page is downloaded again once a
 * cycle, on its own night, so a cycle's downloads do not all fall on one night: every
 * `listedReuseDays` nights when the sitemap gives an edit time, every `undatedReuseDays` when none
 * does (no such cycle: downloaded every time). A page whose last download is a whole cycle old (a run
 * missed its night) is downloaded whatever the night.
 */
export function reuseTonight(page: { url: string; editedAt?: string; downloadedAt?: string }, now: number,
  listedReuseDays: number, undatedReuseDays?: number): boolean {
  const downloaded = page.downloadedAt ? Date.parse(page.downloadedAt) : NaN;
  if (!Number.isFinite(downloaded)) return false;
  const edited = page.editedAt ? Date.parse(page.editedAt) : NaN;
  if (Number.isFinite(edited) && edited >= downloaded) return false;
  const cycle = Number.isFinite(edited) ? listedReuseDays : undatedReuseDays;
  if (!cycle || cycle < 1 || now - downloaded >= cycle * DAY_MS) return false;
  const tonight = nightOf(now);
  return !(tonight % cycle === ownNight(page.url, cycle) && nightOf(downloaded) < tonight);
}

export interface PacerClock {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

const REAL_CLOCK: PacerClock = {
  now: () => Date.now(),
  sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
};

/** Space request starts at least `intervalMs` apart, including across concurrent callers. */
export function createRequestPacer(intervalMs: number, clock: PacerClock = REAL_CLOCK): () => Promise<void> {
  let nextStart = -Infinity;
  return async () => {
    if (!(intervalMs > 0)) return;
    const start = Math.max(clock.now(), nextStart);
    nextStart = start + intervalMs;
    const wait = start - clock.now();
    if (wait > 0) await clock.sleep(wait);
  };
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
  /** The page's validators, sent back next time so an unchanged page is not downloaded again. */
  etag?: string;
  lastModified?: string;
  /**
   * The page is the last capture's, confirmed current at fetchedAt: the site answered 304 Not
   * Modified, or its sitemap said the page was not edited since it was downloaded.
   */
  unchanged?: boolean;
  /** For a page reused on its sitemap's word: when its HTML was last downloaded (else fetchedAt). */
  downloadedAt?: string;
  /** Why no page came back: 'not-html' when the address holds an image or a file, not a page. */
  failure?: 'not-html';
}

/** The last capture's copy of a page, sent as validators and reused when the site says it has not changed. */
export interface PreviousSourcePage {
  url: string;
  statusCode: number | null;
  html: string;
  contentType: string;
  etag?: string;
  lastModified?: string;
  /** When this HTML was downloaded: the capture's downloadedAt, else its fetchedAt. */
  downloadedAt?: string;
  failure?: 'not-html';
}

export interface RawSourceCaptureV1 {
  schemaVersion: 1;
  dataset: string;
  generatedAt: string;
  collectionSucceeded: boolean;
  pages: Array<FetchHtmlResult & { requestedUrl: string; sourceType: 'seed' | 'detail'; fetchedAt: string; contentHash: string;
    /** The page's HTML, gzip-compressed and base64-encoded; `html` is then empty. */
    htmlGzip?: string }>;
}

/** A retained page's original HTML, decompressed when the capture kept it compressed. */
export function sourceHtml(source: Pick<RawSourceCaptureV1['pages'][number], 'html' | 'htmlGzip'>): string {
  return source.htmlGzip ? gunzipSync(Buffer.from(source.htmlGzip, 'base64')).toString('utf8') : source.html;
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

// Challenge and block pages are small interstitials, a few kilobytes of markup and a script.
const CHALLENGE_PAGE_MAX_CHARS = 60_000;

/**
 * A bot challenge or block page names itself in its title or top headings, and is small.
 * The same words in an ordinary page's text are not one: a policy asking for "careful human
 * verification" of AI output is still the policy.
 */
export function isLikelyChallengeHtml(html: string): boolean {
  if (!html) return false;
  const sample = html.slice(0, 250_000);
  const headline = [...sample.matchAll(/<(title|h1|h2)\b[^>]*>([\s\S]*?)<\/\1>/gi)]
    .map((match) => match[2].replace(/<[^>]+>/g, ' '))
    .join(' ');
  const text = html.length <= CHALLENGE_PAGE_MAX_CHARS ? sample : headline;
  return CHALLENGE_PAGE_PATTERNS.some((pattern) => pattern.test(text));
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
  return cleanText(linkedCopy($, element, baseUrl).text());
}

/**
 * An element's text as its lines: each line break (<br>) starts a new line. A paragraph that opens
 * with a bold label over three or more lines ("<strong>Walk-in — No Appointment Required</strong>"
 * then a row per tutor) keeps that label on each row under it, so a row is never read under the
 * label before it (11-18 blind misses, root cause 9: a STEM Center walk-in row was said as
 * appointment-only once the schedule was one run-on line).
 */
function shapedText($: ReturnType<typeof load>, element: AnyNode, baseUrl: string): string {
  const copy = linkedCopy($, element, baseUrl);
  copy.find('br').replaceWith('\n');
  const lines = copy.text().split('\n').map(cleanText).filter(Boolean);
  const first = copy.contents().toArray().find(child => child.type !== 'text' || cleanText((child as unknown as { data?: string }).data || ''));
  const label = first && $(first).is('strong, b') ? cleanText($(first).text()) : '';
  if (label && lines.length >= 3 && lines[0] === label) {
    const name = label.replace(/[:\s]+$/, '');
    return lines.slice(1).map(line => `${name}: ${line}`).join('\n');
  }
  return lines.join('\n');
}

function linkedCopy($: ReturnType<typeof load>, element: AnyNode, baseUrl: string) {
  const copy = $(element).clone();
  copy.find('a[href]').addBack('a[href]').each((_, anchor) => {
    const link = $(anchor);
    const href = link.attr('href') || '';
    // Retain literal contact destinations beside their labels. A label and mailto
    // target can differ; discarding the target loses that original evidence.
    const contact = /^(?:mailto|tel|sms):/i.test(href) ? href.split('?')[0] : null;
    const resolved = contact || resolveHttpUrl(href, baseUrl, true);
    if (!resolved) return;
    const label = cleanText(link.text()) || cleanText(link.attr('aria-label') || link.attr('title')
      || link.find('img[alt]').first().attr('alt') || '');
    link.text(label && label !== resolved ? `${label} (${resolved})` : resolved);
  });
  return copy;
}

// A tab widget shows one panel at a time, and only the tab names what the panel is about:
// Ramapo's #tab-content panels carry their tab's name as a title ("Student Printing", "Faculty
// Printing"), ARIA panels name the tab that labels them, and Divi's panels follow their
// controls in order. The controls themselves are not page text.
const TAB_PANELS = '#tab-content .content[title], [role="tabpanel"], .et_pb_all_tabs > .et_pb_tab';
const TAB_CONTROLS = '#tabs, [role="tablist"], .et_pb_tabs_controls';

/** The tab panel an element sits in and its tab's name, if it sits in one. */
function tabPanel($: ReturnType<typeof load>, element: AnyNode): { node: AnyNode; label: string } | undefined {
  const panel = $(element).closest(TAB_PANELS);
  if (!panel.length) return undefined;
  const labelledBy = panel.attr('aria-labelledby');
  // A panel's title can hold markup, such as "<strong>Pre-Arrival</strong>".
  const label = cleanText((panel.attr('title') || '').replace(/<[^>]*>/g, ' '))
    || (labelledBy ? cleanText($(`[id="${labelledBy}"]`).first().text()) : '')
    || cleanText(panel.attr('aria-label') || '')
    || (panel.is('.et_pb_tab')
      ? cleanText(panel.closest('.et_pb_tabs').find('.et_pb_tabs_controls li').eq(panel.index('.et_pb_tab')).text())
      : '');
  return label ? { node: panel[0], label } : undefined;
}

const ACCORDION_LEVEL = 7;
const TOP_LINK = /^(?:back|return) to (?:the )?top$/i;

/**
 * The text directly in a tab panel before its first heading, which no paragraph holds: the
 * Student Printing tab opens "... to any swipe-to-release printer located in the Learning
 * Commons and Fishbowl" as bare text, so it was lost (09-29).
 */
function panelIntro($: ReturnType<typeof load>, panel: AnyNode): string {
  const texts: string[] = [];
  for (const child of $(panel).contents().toArray()) {
    if (child.type === 'text') {
      texts.push(cleanText((child as unknown as { data?: string }).data || ''));
      continue;
    }
    if ($(child).is(SECTION_HEADINGS) || $(child).find(SECTION_HEADINGS).length) break;
  }
  return cleanText(texts.join(' '));
}

/** A heading's level: h1 to h6 or its ARIA level; an accordion's title sits under the page's headings. */
function headingLevel(node: ReturnType<ReturnType<typeof load>>): number {
  const tag = /^h([1-6])$/i.exec(node.prop('tagName') || '');
  if (tag) return Number(tag[1]);
  if (!node.is('[role="heading"]')) return ACCORDION_LEVEL;
  const level = Number(node.attr('aria-level') || 2);
  return Number.isInteger(level) && level >= 1 && level <= 6 ? level : 2;
}

/**
 * The page's sections in document order, each under its heading. A section also keeps what it
 * sits under, outermost first: the headings above it and the tab of the panel it is in. "Printer
 * Locations" under Faculty Printing lists printers only faculty can use; without its parents it
 * read as every printer on campus (09-29). The page's h1 is its title, which is written anyway.
 */
/** The row with `shaped` (its blocks one per line) when that says more than its one-line field. */
function withShape<T extends Record<string, unknown>>(row: T, field: keyof T & string, blocks: string[]): T & { shaped?: string } {
  const shaped = blocks.join('\n');
  return shaped.includes('\n') || shaped !== row[field] ? { ...row, shaped } : row;
}

function extractSections($: ReturnType<typeof load>, baseUrl: string, initialHeading: string): RawPageV1['sections'] {
  const sections: RawPageV1['sections'] = [];
  let heading = cleanText($('h1').first().text()) || initialHeading || 'Overview';
  let parents: string[] = [];
  let parts: string[] = [];
  // The same blocks with their lines kept: one block per line, a table's rows and a paragraph's
  // line breaks as lines (shapedText). `text` stays one line for every reader of it.
  let shapedParts: string[] = [];
  // The headings open at this point, and the tab panel they belong to (none outside a panel).
  let open: Array<{ level: number; label: string; panel?: AnyNode }> = [];
  let panel: { node: AnyNode; label: string } | undefined;
  const labels = (entries = open) => entries.filter(entry => entry.level !== 1).map(entry => entry.label);
  // The FAQ items in the section being read (a WordPress accordion's question and its answer). The
  // section's own text is unchanged; its questions let a reader name the one asked.
  let questions: Array<{ question: string; answer: string[]; shaped: string[]; item: AnyNode }> = [];
  const flush = () => {
    const asked = questions.filter(entry => entry.answer.length)
      .map(entry => withShape({ question: entry.question, answer: entry.answer.join(' ') }, 'answer', entry.shaped));
    if (parts.length) sections.push(withShape({ heading, text: parts.join(' '), ...parents.length ? { parents } : {},
      ...asked.length ? { questions: asked } : {} }, 'text', shapedParts));
    parts = [];
    shapedParts = [];
    questions = [];
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
      parents = [];
      open = [];
      panel = undefined;
      return;
    }
    if (node.closest(TAB_CONTROLS).length) return;
    const inPanel = tabPanel($, element);
    if (inPanel?.node !== panel?.node) {
      // Each panel starts a section named by its tab, under the headings above the widget. After
      // the widget, the text continues under the heading that preceded it. An accordion's title
      // names only its own answer, so it titles no panel.
      flush();
      open = open.filter(entry => !entry.panel && entry.level < ACCORDION_LEVEL);
      panel = inPanel;
      if (panel) {
        parents = labels();
        heading = panel.label;
        open.push({ level: 0, label: panel.label, panel: panel.node });
        const intro = panelIntro($, panel.node);
        if (intro) {
          parts.push(intro);
          shapedParts.push(intro);
        }
      } else {
        heading = open.at(-1)?.label || initialHeading || 'Overview';
        parents = labels(open.slice(0, -1));
      }
    }
    if (node.is(SECTION_HEADINGS)) {
      flush();
      const text = textWithLinks($, element, baseUrl);
      // Residence Life's guide puts "return to top" links in h2s between its h3 sections.
      if (!text || TOP_LINK.test(cleanText(node.text()))) return;
      const level = headingLevel(node);
      // A heading closes the ones at its level or below in the same panel, never the panel's tab.
      while (open.length && open.at(-1)!.panel === panel?.node && open.at(-1)!.level >= level) open.pop();
      parents = labels();
      open.push({ level, label: text, panel: panel?.node });
      heading = text;
      return;
    }
    if (node.is(FAQ_QUESTION)) {
      const question = cleanText(node.text());
      const item = node.closest('.item')[0];
      if (question && item) questions.push({ question, answer: [], shaped: [], item });
    }
    if (node.parents('li, table').length) return;
    // An anchor already represented in a text block must not become a duplicate
    // section entry. Standalone buttons/links still need their own retained text.
    if (node.is('a') && node.parents(`p, ${SECTION_HEADINGS}`).length) return;
    const text = node.is('table')
      ? node.find('tr').toArray().map((row) => $(row).find('th, td').toArray()
        .map((cell) => textWithLinks($, cell, baseUrl)).join(' | ')).join('; ')
      : textWithLinks($, element, baseUrl);
    const shaped = node.is('table')
      ? node.find('tr').toArray().map((row) => $(row).find('th, td').toArray()
        .map((cell) => textWithLinks($, cell, baseUrl)).join(' | ')).join('\n')
      : shapedText($, element, baseUrl);
    if (text && !parts.includes(text)) {
      parts.push(text);
      shapedParts.push(shaped || text);
    }
    const asking = questions.at(-1);
    if (text && asking && !node.is(FAQ_QUESTION) && node.closest('.item')[0] === asking.item) {
      asking.answer.push(text);
      asking.shaped.push(shaped || text);
    }
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

const EMAIL_ADDRESS = /^[^\s@()]+@[^\s@()]+\.[^\s@()]+$/;

/** An address as written for comparing a link's text with its target: no case, spaces, %20, parentheses or trailing punctuation. */
function comparableEmail(value: string): string {
  return value.toLowerCase().replace(/%20/gi, '').replace(/[\s()]/g, '').replace(/[.,;:!?]+$/, '');
}

/**
 * Whether a mailto link shows one address and sends to another, such as "astuart@ramapo.edu"
 * linking to ltan@ramapo.edu. Neither address can then be trusted as the contact. Link text that
 * is not an address ("Email us", "graduate@ramapo.edu and we will help") is not a mismatch.
 */
export function isMismatchedMailto(text: string, email: string): boolean {
  const shown = text.replace(/%20/gi, '').replace(/[()]/g, '').replace(/[.,;:!?]+$/, '').trim();
  return EMAIL_ADDRESS.test(shown) && comparableEmail(shown) !== comparableEmail(email);
}

/**
 * Whether a tel link's number is a phone number: 10 US digits (11 with a leading 1) or an
 * extension, once percent-encoding is decoded. A browser's phone detection can link a
 * citation's page range, such as "tel:2641-2673", which is not a number to call.
 */
export function isPhoneNumber(raw: string): boolean {
  let value = raw;
  try {
    value = decodeURIComponent(raw);
  } catch {
    // Not valid percent-encoding: read it as written.
  }
  const digits = value.replace(/\D/g, '');
  return digits.length === 10 || (digits.length === 11 && digits.startsWith('1'))
    || /(?:\bext\.?|\bx)\s*\d+/i.test(value);
}

function extractContacts($: ReturnType<typeof load>): RawPageV1['contacts'] {
  const contactsMap = new Map<string, RawPageV1['contacts'][number]>();

  $('a[href^="mailto:"]').each((_, element) => {
    const href = $(element).attr('href') || '';
    const email = href.replace(/^mailto:/i, '').split('?')[0].trim();
    if (!email) return;

    const name = cleanText($(element).text()) || undefined;
    if (name && isMismatchedMailto(name, email)) return;
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
    if (!phone || !isPhoneNumber(phone)) return;

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

const ISO_DATE_YEAR = /^(\d{4})-\d{2}-\d{2}/;

/** A date shown without its year, such as "Tue, November 10" or "October 8 @ 1:15 pm", with the year after the date. */
export function withYear(text: string, year: string): string {
  if (/\b\d{4}\b/.test(text)) return text;
  const at = text.indexOf(' @ ');
  return at === -1 ? `${text.trimEnd()}, ${year}` : `${text.slice(0, at)}, ${year}${text.slice(at)}`;
}

/**
 * The Events Calendar leaves the year out of a date in the current year: "Date: Tue, November 10".
 * Its date elements keep the full date in their title (title="2026-11-10"), so the year is put
 * back into the text, and into the event header's start and end dates.
 */
function addEventCalendarYears($: ReturnType<typeof load>): void {
  $('abbr.tribe-events-abbr[title]').each((_, element) => {
    const node = $(element);
    const year = node.attr('title')?.match(ISO_DATE_YEAR)?.[1];
    if (year) node.text(withYear(cleanText(node.text()), year));
  });
  const yearOf = (selector: string) => $(selector).first().attr('title')?.match(ISO_DATE_YEAR)?.[1];
  const start = yearOf('abbr.tribe-events-start-date, abbr.tribe-events-start-datetime');
  const end = yearOf('abbr.tribe-events-end-date, abbr.tribe-events-end-datetime') ?? start;
  for (const [selector, year] of [['.tribe-event-date-start', start], ['.tribe-event-date-end', end]] as const) {
    if (year) $(`.tribe-events-schedule ${selector}`).each((_, element) => {
      $(element).text(withYear(cleanText($(element).text()), year));
    });
  }
}

export function buildRawPageFromHtml(options: BuildRawPageFromHtmlOptions): RawPageV1 {
  if (isLikelyChallengeHtml(options.html)) {
    throw new Error(`${options.url}: received a bot challenge or human-verification page.`);
  }

  const document = load(options.html);
  // Read before the scripts go: the date can sit in the page's JSON-LD.
  const modifiedAt = pageModifiedAt(document);
  document('script, style, noscript, template, svg, nav, footer, [role="navigation"]').remove();
  document('header').not('main header, article header, [role="main"] header').remove();
  addEventCalendarYears(document);
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

  const sections = extractSections($, options.url, initialHeading);
  // Potter Library's named research-help contact widget sits beside the article.
  // Keep that office-owned contact block without importing the site's navigation
  // or unrelated sidebar schedules into the article's evidence.
  const pageUrl = new URL(options.url);
  if (['ramapo.edu', 'www.ramapo.edu'].includes(pageUrl.hostname) && pageUrl.pathname.startsWith('/library/')) {
    document('.page_in_widget').each((_, element) => {
      const heading = cleanText(document(element).find('.widgettitle').first().text());
      if (heading !== 'Ask a Librarian' || sections.some(section => section.heading === heading)) return;
      const widget = load(document(element).html() || '');
      sections.push(...extractSections(widget, options.url, heading));
    });
  }

  return {
    url: normalizeUrl(options.url),
    sourceType: options.sourceType,
    fetchedAt: options.fetchedAt || new Date().toISOString(),
    statusCode: options.statusCode === undefined ? 200 : options.statusCode,
    title,
    links: asSortedArray(links),
    externalLinks: asSortedArray(externalLinks),
    sections,
    lists: extractLists($, options.url),
    tables: extractTables($, options.url),
    contacts: extractContacts($),
    documents: extractDocuments($, options.url),
    ...(modifiedAt ? { modifiedAt } : {}),
  };
}

const MODIFIED_META = ['meta[property="article:modified_time"]', 'meta[property="og:updated_time"]',
  'meta[itemprop="dateModified"]'];

/**
 * When the page says it was last changed, as an ISO time, or null. The college's WordPress pages
 * carry it in their SEO tags (article:modified_time, and dateModified in the JSON-LD): 2,382 of the
 * 2,706 office pages captured 10-25 did, from 2013 to 2026. A date that does not parse, or one
 * after the capture, is not taken.
 */
export function pageModifiedAt(document: ReturnType<typeof load>, now = Date.now()): string | null {
  const said: string[] = MODIFIED_META.map(selector => document(selector).first().attr('content') ?? '');
  document('script[type="application/ld+json"]').each((_, element) => {
    const found = /"dateModified"\s*:\s*"([^"]+)"/.exec(document(element).text());
    if (found) said.push(found[1]);
  });
  for (const value of said) {
    const time = Date.parse(value.trim());
    // A day's grace: the page's clock and the collector's may disagree.
    if (Number.isFinite(time) && time <= now + 86_400_000 && time > Date.UTC(1995, 0, 1)) {
      return new Date(time).toISOString();
    }
  }
  return null;
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
  if (capture.collectionSucceeded !== true) throw new Error('Source capture belongs to an incomplete or failed collection');
  const pages = capture.pages.map(source => {
    const html = sourceHtml(source);
    if (createHash('sha256').update(html).digest('hex') !== source.contentHash) {
      throw new Error(`Source capture content hash mismatch: ${source.requestedUrl}`);
    }
    return html ? buildRawPageFromHtml({url:source.url,html,sourceType:source.sourceType,
      fetchedAt:source.fetchedAt,statusCode:source.statusCode,allowedHost:urlHost(source.url)})
      : buildEmptyPage(source.url,source.sourceType,source.statusCode,source.fetchedAt);
  });
  const pagesFetched = pages.filter(successfulPage).length;
  return {version:'1.0',dataset:capture.dataset,collectedAt:capture.generatedAt,
    seedUrls:normalizeSeedUrls(capture.pages.filter(source => source.sourceType === 'seed').map(source => source.requestedUrl)),
    stats:{pagesFetched,pagesFailed:pages.length-pagesFetched,
      externalLinksSeen:new Set(pages.flatMap(page => page.externalLinks)).size},pages};
}

/**
 * The last capture's pages that can stand in for a fresh download, by requested URL: a successful
 * page with its HTML intact. It is reused when the site answers 304 to its validators, or when
 * the site's sitemap says it was not edited since it was downloaded. A missing or unreadable
 * capture gives none.
 */
export function previousSourcePages(capturePath: string): Map<string, PreviousSourcePage> {
  const pages = new Map<string, PreviousSourcePage>();
  let capture: RawSourceCaptureV1;
  try {
    capture = JSON.parse(fs.readFileSync(capturePath, 'utf8')) as RawSourceCaptureV1;
  } catch {
    return pages;
  }
  if (capture?.schemaVersion !== 1 || !Array.isArray(capture.pages)) return pages;
  for (const page of capture.pages) {
    if (page.statusCode === null || page.statusCode < 200 || page.statusCode >= 300) continue;
    let html: string;
    try {
      html = sourceHtml(page);
    } catch {
      continue;
    }
    if (!html || createHash('sha256').update(html).digest('hex') !== page.contentHash) continue;
    const downloadedAt = page.downloadedAt ?? page.fetchedAt;
    pages.set(page.requestedUrl, { url: page.url, statusCode: page.statusCode, html, contentType: page.contentType,
      ...(page.etag ? { etag: page.etag } : {}), ...(page.lastModified ? { lastModified: page.lastModified } : {}),
      ...(downloadedAt ? { downloadedAt } : {}) });
  }
  return pages;
}

/** Whether a captured page answered "not found", or was an image or a file, not a page. */
export function deadPage(page: { statusCode: number | null; failure?: string }): boolean {
  return page.statusCode === 404 || page.statusCode === 410 || (page.statusCode === null && page.failure === 'not-html');
}

/**
 * The last capture's pages that answered "not found" or were not a page (deadPage), by requested
 * URL, with when they were last asked. A missing or unreadable capture gives none.
 */
export function previousDeadPages(capturePath: string): Map<string, PreviousSourcePage> {
  const pages = new Map<string, PreviousSourcePage>();
  let capture: RawSourceCaptureV1;
  try {
    capture = JSON.parse(fs.readFileSync(capturePath, 'utf8')) as RawSourceCaptureV1;
  } catch {
    return pages;
  }
  if (capture?.schemaVersion !== 1 || !Array.isArray(capture.pages)) return pages;
  for (const page of capture.pages) {
    if (!deadPage(page)) continue;
    let html: string;
    try {
      html = sourceHtml(page);
    } catch {
      continue;
    }
    const downloadedAt = page.downloadedAt ?? page.fetchedAt;
    pages.set(page.requestedUrl, { url: page.url, statusCode: page.statusCode, html, contentType: page.contentType,
      ...(downloadedAt ? { downloadedAt } : {}), ...(page.failure ? { failure: page.failure } : {}) });
  }
  return pages;
}

/**
 * Other captures' successful pages confirmed current within their maxAgeHours of `now`, by
 * requested URL; the first capture listed wins. Missing or unreadable captures give none.
 */
export function sharedSourcePages(captures: ReadonlyArray<{ path: string; maxAgeHours: number }>, now: number):
  Map<string, PreviousSourcePage> {
  const pages = new Map<string, PreviousSourcePage>();
  for (const { path: capturePath, maxAgeHours } of captures) {
    let capture: RawSourceCaptureV1;
    try {
      capture = JSON.parse(fs.readFileSync(capturePath, 'utf8')) as RawSourceCaptureV1;
    } catch {
      continue;
    }
    if (capture?.schemaVersion !== 1 || !Array.isArray(capture.pages)) continue;
    for (const page of capture.pages) {
      if (pages.has(page.requestedUrl)) continue;
      if (page.statusCode === null || page.statusCode < 200 || page.statusCode >= 300) continue;
      const confirmed = Date.parse(page.fetchedAt);
      if (!Number.isFinite(confirmed) || now - confirmed > maxAgeHours * 3_600_000 || confirmed > now) continue;
      let html: string;
      try {
        html = sourceHtml(page);
      } catch {
        continue;
      }
      if (!html || createHash('sha256').update(html).digest('hex') !== page.contentHash) continue;
      const downloadedAt = page.downloadedAt ?? page.fetchedAt;
      pages.set(page.requestedUrl, { url: page.url, statusCode: page.statusCode, html, contentType: page.contentType,
        ...(downloadedAt ? { downloadedAt } : {}) });
    }
  }
  return pages;
}

/** Why tonight's collection asks the site for a page, for the run's note of what was read. */
export type DownloadReason = 'edited' | 'scheduled' | 'undated' | 'dead' | 'new';

/**
 * Why a page reuseTonight did not reuse is asked tonight: its sitemap says it was edited since the
 * last download, it is its night in its cycle (dated or undated), it was dead (deadPage) and is
 * asked again on its night, or there is no usable last copy (new, failed last time, or a source
 * that keeps none).
 */
export function downloadReason(previous: { downloadedAt?: string } | undefined, editedAt: string | undefined,
  dead: boolean): DownloadReason {
  if (dead) return 'dead';
  const downloaded = previous?.downloadedAt ? Date.parse(previous.downloadedAt) : NaN;
  if (!previous || !Number.isFinite(downloaded)) return 'new';
  const edited = editedAt ? Date.parse(editedAt) : NaN;
  if (Number.isFinite(edited)) return edited >= downloaded ? 'edited' : 'scheduled';
  return 'undated';
}

const DOWNLOAD_REASON_WORDS: Record<DownloadReason, string> = {
  edited: 'edited since the last download',
  scheduled: 'unedited, on their night to be downloaded again',
  undated: 'no edit date, on their night',
  dead: '"not found" or not a page, asked again on their night',
  new: 'no usable last copy',
};

/** The downloads of a collection by reason, as the run's note says them; reasons with none are left out. */
export function downloadReasonsLine(counts: Readonly<Partial<Record<DownloadReason, number>>>): string {
  const parts = (Object.keys(DOWNLOAD_REASON_WORDS) as DownloadReason[])
    .filter(reason => (counts[reason] ?? 0) > 0)
    .map(reason => `${counts[reason]} ${DOWNLOAD_REASON_WORDS[reason]}`);
  return parts.length ? parts.join(', ') : 'none';
}

async function fetchHtmlWithRetry(
  url: string,
  timeoutMs: number,
  attempts: number,
  previous?: PreviousSourcePage
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
        etag: previous?.etag,
        lastModified: previous?.lastModified,
      }
    );
    const etag = response.headers.get('etag') || undefined;
    const lastModified = response.headers.get('last-modified') || undefined;
    if (response.status === 304 && previous) {
      return {
        url: previous.url,
        statusCode: previous.statusCode,
        html: previous.html,
        contentType: previous.contentType,
        etag: etag ?? previous.etag,
        lastModified: lastModified ?? previous.lastModified,
        unchanged: true,
      };
    }
    return {
      url: response.url || url,
      statusCode: response.status,
      html: response.text(),
      contentType: response.headers.get('content-type') || '',
      ...(etag ? { etag } : {}),
      ...(lastModified ? { lastModified } : {}),
    };
  } catch (error) {
    if (error instanceof SiteFetchBlockedError) throw error;
    // Say why, so a failed collection names the page and the reason instead of only a count.
    console.warn(`${url}: no usable page (${error instanceof Error ? error.message : String(error)})`);
    return { url, statusCode: null, html: '', contentType: '',
      ...(error instanceof UnexpectedContentTypeError ? { failure: 'not-html' as const } : {}) };
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

/** The pages that did not count as successful, so the error says which ones to look at. */
function failedPagesNote(pages: RawPageV1[]): string {
  const failed = pages.filter(page => !successfulPage(page));
  if (failed.length === 0) return '';
  const shown = failed.slice(0, 20).map(page => `${page.url} (${page.statusCode ?? 'no response'})`);
  const more = failed.length > shown.length ? `, and ${failed.length - shown.length} more` : '';
  return ` Failed: ${shown.join(', ')}${more}.`;
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
    | 'comparablePreviousPage'
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
      `${dataset.dataset}: collected ${successfulPages.length} successful pages; expected at least ${options.minimumSuccessfulPages}.` +
        failedPagesNote(dataset.pages)
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
        `${dataset.dataset}: seed success rate ${(rate * 100).toFixed(1)}% is below ${(options.minimumSeedSuccessRate * 100).toFixed(0)}%.` +
          failedPagesNote(seedPages)
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
      const previousCount = previous.pages.filter(successfulPage)
        .filter(page => !options.comparablePreviousPage || options.comparablePreviousPage(page)).length;
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
  let collectionSucceeded = false;
  const pace = createRequestPacer(options.requestIntervalMs ?? 0);
  // A retained capture keeps each page's validators, so a page the site says has not changed since
  // the last capture is reused instead of downloaded again.
  const capturePath = path.join(path.dirname(options.outputPath), `${options.dataset}-sources.raw.json`);
  const previousPages = options.retainSourceHtml ? previousSourcePages(capturePath) : new Map<string, PreviousSourcePage>();
  const deadPages = options.retainSourceHtml && options.deadReuseDays
    ? previousDeadPages(capturePath) : new Map<string, PreviousSourcePage>();
  const sharedPages = options.retainSourceHtml && options.sharedCaptures?.length
    ? sharedSourcePages(options.sharedCaptures, Date.now()) : new Map<string, PreviousSourcePage>();
  let unchangedPages = 0;
  let reusedPages = 0;
  let sharedReused = 0;
  let deadReused = 0;
  const downloadReasons: Partial<Record<DownloadReason, number>> = {};
  const reuseDays = options.listedReuseDays ?? LISTED_REUSE_DAYS;
  async function fetchSource(url: string, sourceType: 'seed' | 'detail'): Promise<FetchHtmlResult & { fetchedAt: string }> {
    const previous = previousPages.get(url);
    const dead = previous ? undefined : deadPages.get(url);
    const shared = sharedPages.get(url);
    let fetched: FetchHtmlResult;
    const editedAt = options.listedEditedAt?.(url);
    const now = Date.now();
    if (previous && reuseTonight({ url, downloadedAt: previous.downloadedAt, ...(editedAt ? { editedAt } : {}) },
      now, reuseDays, options.undatedReuseDays)) {
      // Not edited since the last download, and not this page's night to be downloaded again: no request at all.
      fetched = { url: previous.url, statusCode: previous.statusCode, html: previous.html,
        contentType: previous.contentType, ...(previous.etag ? { etag: previous.etag } : {}),
        ...(previous.lastModified ? { lastModified: previous.lastModified } : {}),
        unchanged: true, downloadedAt: previous.downloadedAt };
      reusedPages += 1;
    } else if (shared) {
      // Another collector read this page and confirmed it current recently: its copy, no request.
      fetched = { url: shared.url, statusCode: shared.statusCode, html: shared.html, contentType: shared.contentType,
        unchanged: true, downloadedAt: shared.downloadedAt };
      sharedReused += 1;
    } else if (dead && reuseTonight({ url, downloadedAt: dead.downloadedAt }, now, reuseDays, options.deadReuseDays)) {
      // "Not found" or not a page last time, and not its night to be asked again: the same answer, no request.
      fetched = { url: dead.url, statusCode: dead.statusCode, html: dead.html, contentType: dead.contentType,
        downloadedAt: dead.downloadedAt, ...(dead.failure ? { failure: dead.failure } : {}) };
      deadReused += 1;
    } else {
      const reason = downloadReason(previous ?? dead, editedAt, Boolean(dead));
      downloadReasons[reason] = (downloadReasons[reason] ?? 0) + 1;
      await pace();
      fetched = await fetchHtmlWithRetry(url, timeoutMs, attempts, previous);
    }
    if (fetched.unchanged) unchangedPages += 1;
    const fetchedAt = new Date().toISOString();
    if (options.retainSourceHtml) {
      const contentHash = createHash('sha256').update(fetched.html).digest('hex');
      sourcePages.push(options.compressSourceHtml && fetched.html
        ? { ...fetched, html: '', htmlGzip: gzipSync(fetched.html).toString('base64'), requestedUrl: url, sourceType,
          fetchedAt, contentHash }
        : { ...fetched, requestedUrl: url, sourceType, fetchedAt, contentHash });
    }
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
    const detailFetchLimit = limit(detailConcurrency);

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
    collectionSucceeded = true;
    if (options.retainSourceHtml) {
      const asked = sourcePages.length - reusedPages - sharedReused - deadReused;
      noteSiteDownloads(`${options.dataset}: ${sourcePages.length} pages; ${asked} asked of the site ` +
        `(${downloadReasonsLine(downloadReasons)}); not asked: ${reusedPages} not edited since and not on their night` +
        (sharedReused ? `, ${sharedReused} taken from another collector's copy` : '') +
        (deadReused ? `, ${deadReused} "not found" or not a page last time` : '') +
        `; ${unchangedPages - reusedPages - sharedReused} asked but not changed (304).`);
    }
    return dataset;
  } finally {
    // Keep the original pages even if parsing or a coverage gate fails. The
    // parsed JSON alone cannot reveal content that the parser silently omitted.
    if (options.retainSourceHtml) {
      const payload: RawSourceCaptureV1 = { schemaVersion: 1, dataset: options.dataset,
        generatedAt: new Date().toISOString(), collectionSucceeded, pages: sourcePages };
      const rawDir = path.dirname(options.outputPath);
      writeJsonFile(path.join(rawDir, `${options.dataset}-sources.raw.json`), payload);
      const oldestFetch = sourcePages.map(page => page.fetchedAt).sort()[0];
      if (oldestFetch) writeRawProvenance(`${options.dataset}-sources`, { sourceUrl: normalizedSeedUrls[0],
        recordCount: sourcePages.length, payload, fetchedAt: oldestFetch }, rawDir);
    }
  }
}
