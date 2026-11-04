import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import pLimit from 'p-limit';
import { load } from 'cheerio';
import { chromium, type BrowserContext } from 'playwright';
import { assertRawCollectionCandidate } from './raw-collector';
import { buildArchwayEventDetailPage } from './archway-event-detail';
import { fetchWithPolicy } from './http-client';
import { assertSiteFetchAllowed, noteSiteDownloads, paceRamapoRequest, RAMAPO_CONCURRENCY } from './site-guard';
import { ARCHWAY_FEED_INDEX_URL, fetchCalendarFeedEvents } from './archway-calendar-feeds';
import {
  assertCollectionCount,
  isRawOnlyMode,
  runGeneratorScript,
  writeJsonFile,
  writeRawProvenance,
} from './pipeline-utils';
import { type RawDatasetV1, type RawPageV1, validateRawDatasetV1 } from './raw-types';
import { validateArchwayEvents, type ArchwayEvent } from './schema';
import { sanitizeEventDescription } from './event-description';
import { publishedFoodSignal } from './event-food';
import { publicPath } from '../src/paths';
import { canonicalArchwayEventUrl } from '../src/archway-event-url';

const ARCHWAY_URL = 'https://archway.ramapo.edu/events';
const RAW_JSON_PATH = path.join(process.cwd(), 'data', 'raw', 'events.raw.json');
const DETAIL_RAW_JSON_PATH = path.join(process.cwd(), 'data', 'raw', 'events-detail.raw.json');
const SIGNAL_RAW_JSON_PATH = path.join(process.cwd(), 'data', 'raw', 'events-signals.raw.json');
const PUBLIC_JSON_PATH = publicPath('data', 'events.json');
const RAG_JSON_PATH = path.join(process.cwd(), 'data', 'normalized', 'events.json');
const MARKDOWN_GENERATOR_PATH = path.join(__dirname, 'generate-events-md.ts');

export type EventDetailSignal = {
  offersFreeFood?: boolean;
  foodCategory?: 'food' | 'snacks';
  description?: string;
};

type EventDetailScrapeResult = {
  dataset: RawDatasetV1;
  signalByUrl: Map<string, EventDetailSignal>;
};

type EventSignalRawRecord = {
  url: string;
  offersFreeFood?: boolean;
  foodCategory?: 'food' | 'snacks';
  description?: string;
};

type EventSignalRawDataset = {
  version: '1.0';
  dataset: 'events-signals';
  collectedAt: string;
  signalCount: number;
  signals: EventSignalRawRecord[];
};

function parseDetailLimit(rawValue: string | undefined, fallback: number): number {
  if (!rawValue) return fallback;
  const parsed = Number.parseInt(rawValue, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

export function normalizeEventUrlForLookup(rawUrl: string): string {
  const eventUrl = canonicalArchwayEventUrl(rawUrl);
  if (eventUrl) return eventUrl;
  try {
    const parsed = new URL(rawUrl);
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return rawUrl;
  }
}

function normalizeText(value: string | undefined | null): string | undefined {
  if (!value) return undefined;
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized || undefined;
}

function extractNarrativeTextFromHtmlSnippet(snippet: string): string | undefined {
  const $ = load(`<div>${snippet}</div>`);

  const paragraphText = normalizeText(
    $('p')
      .toArray()
      .map((paragraph) => $(paragraph).text())
      .join(' ')
  );
  if (paragraphText) {
    return paragraphText;
  }

  return normalizeText($.text());
}

function extractEmbeddedEventDescriptions(rawHtml: string): string[] {
  const descriptionRegex = /"description"\s*:\s*"((?:\\.|[^"\\])*)"/g;
  const descriptions = new Set<string>();

  let match: RegExpExecArray | null = null;
  while ((match = descriptionRegex.exec(rawHtml)) !== null) {
    const rawDescription = match[1];
    let decoded = '';
    try {
      decoded = JSON.parse(`"${rawDescription}"`) as string;
    } catch {
      continue;
    }

    const narrative = extractNarrativeTextFromHtmlSnippet(decoded);
    if (narrative) {
      descriptions.add(narrative);
    }
  }

  return Array.from(descriptions);
}

function isTruthyEnv(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes';
}

function shouldForceLiveScrape(): boolean {
  return isTruthyEnv(process.env.EVENTS_FORCE_SCRAPE) || isTruthyEnv(process.env.ARCHWAY_FORCE_SCRAPE);
}

function shouldUseRawCache(): boolean {
  if (shouldForceLiveScrape()) {
    return false;
  }
  return !isTruthyEnv(process.env.EVENTS_DISABLE_RAW_CACHE);
}

function hasEventSignal(signal: EventDetailSignal | undefined): boolean {
  if (!signal) return false;
  return (
    signal.offersFreeFood !== undefined ||
    signal.foodCategory !== undefined ||
    Boolean(normalizeText(signal.description))
  );
}

function serializeEventSignalMap(signalByUrl: Map<string, EventDetailSignal>): EventSignalRawDataset {
  const signals: EventSignalRawRecord[] = Array.from(signalByUrl.entries())
    .map(([url, signal]) => {
      const normalizedDescription = sanitizeEventDescription(normalizeText(signal.description));
      const record: EventSignalRawRecord = { url };
      if (signal.offersFreeFood !== undefined) {
        record.offersFreeFood = signal.offersFreeFood;
      }
      if (signal.foodCategory) {
        record.foodCategory = signal.foodCategory;
      }
      if (normalizedDescription) {
        record.description = normalizedDescription;
      }
      return record;
    })
    .filter((record) => hasEventSignal(record));

  return {
    version: '1.0',
    dataset: 'events-signals',
    collectedAt: new Date().toISOString(),
    signalCount: signals.length,
    signals,
  };
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function readEventSignalMapFromRawFile(signalFilePath: string): Map<string, EventDetailSignal> {
  if (!fs.existsSync(signalFilePath)) {
    return new Map<string, EventDetailSignal>();
  }

  const parsed = JSON.parse(fs.readFileSync(signalFilePath, 'utf-8')) as unknown;
  if (!isObjectRecord(parsed) || parsed.dataset !== 'events-signals' || !Array.isArray(parsed.signals)) {
    throw new Error(`Invalid events signal raw dataset: ${signalFilePath}`);
  }

  const signalByUrl = new Map<string, EventDetailSignal>();
  parsed.signals.forEach((entry) => {
    if (!isObjectRecord(entry)) return;
    const url = typeof entry.url === 'string' ? normalizeEventUrlForLookup(entry.url) : '';
    if (!url) return;

    const signal: EventDetailSignal = {};
    if (typeof entry.offersFreeFood === 'boolean') {
      signal.offersFreeFood = entry.offersFreeFood;
    }
    if (entry.foodCategory === 'food' || entry.foodCategory === 'snacks') {
      signal.foodCategory = entry.foodCategory;
    }
    if (typeof entry.description === 'string') {
      const description = sanitizeEventDescription(normalizeText(entry.description));
      if (description) {
        signal.description = description;
      }
    }

    if (hasEventSignal(signal)) {
      signalByUrl.set(url, signal);
    }
  });

  return signalByUrl;
}

function collectRawPageSignalText(page: RawPageV1): string {
  const tableText = page.tables
    .flatMap((table) => [...table.headers, ...table.rows.flat()])
    .filter((value) => Boolean(value));
  const sectionText = page.sections.flatMap((section) => [section.heading, section.text]);

  // A ticket-price field ending in FREE beside a repeated heading such as
  // "Pizza in Hut" must never become the source assertion "FREE Pizza".
  return [page.title ?? '', ...sectionText, ...tableText]
    .map((value) => normalizeText(value)).filter(Boolean).join('\n');
}

function collectRawPageDescription(page: RawPageV1): string | undefined {
  const candidates = page.sections
    .map((section) => normalizeText(section.text))
    .filter((text): text is string => Boolean(text))
    .filter((text) => text.length > 20)
    .filter((text) => !/\bby\s+[a-z0-9\s&.'-]+$/i.test(text));

  if (candidates.length === 0) {
    return undefined;
  }

  return [...candidates].sort((a, b) => b.length - a.length)[0];
}

export function extractEventDetailSignalFromRawPage(page: RawPageV1): EventDetailSignal {
  const text = collectRawPageSignalText(page);
  if (!text) {
    return {};
  }

  const description = collectRawPageDescription(page);
  return {
    ...publishedFoodSignal(text),
    description,
  };
}

function buildSignalMapFromDetailRawDataset(dataset: RawDatasetV1): Map<string, EventDetailSignal> {
  const signalByUrl = new Map<string, EventDetailSignal>();
  dataset.pages.forEach((page) => {
    if (page.sourceType !== 'detail' || !page.url) {
      return;
    }

    const signal = extractEventDetailSignalFromRawPage(page);
    if (!hasEventSignal(signal)) {
      return;
    }

    signalByUrl.set(normalizeEventUrlForLookup(page.url), signal);
  });

  return signalByUrl;
}

export function applyDetailSignalsToEvents(
  events: ArchwayEvent[],
  signalByUrl: Map<string, EventDetailSignal>
): ArchwayEvent[] {
  return events.map((event) => {
    if (!event.url) return event;
    const details = signalByUrl.get(normalizeEventUrlForLookup(event.url));
    if (!details) return event;
    return {
      ...event,
      description:
        sanitizeEventDescription(details.description) ??
        sanitizeEventDescription(event.description),
      offersFreeFood:
        details.offersFreeFood !== undefined ? details.offersFreeFood : event.offersFreeFood,
      foodCategory: details.foodCategory || event.foodCategory,
    };
  });
}

/** Re-evaluate old derived flags against this occurrence's captured source text. */
export function rebuildEventSignals(
  dataset: RawDatasetV1,
  cachedSignals: Map<string, EventDetailSignal> = new Map()
): Map<string, EventDetailSignal> {
  const signals = new Map<string, EventDetailSignal>();
  for (const page of dataset.pages) {
    if (page.sourceType !== 'detail' || page.statusCode === null || page.statusCode < 200 || page.statusCode >= 300) continue;
    const url = normalizeEventUrlForLookup(page.url);
    const description = sanitizeEventDescription(cachedSignals.get(url)?.description)
      ?? sanitizeEventDescription(collectRawPageDescription(page));
    signals.set(url, {
      ...publishedFoodSignal(`${collectRawPageSignalText(page)}\n${description ?? ''}`),
      ...(description ? { description } : {}),
    });
  }
  return signals;
}

/** Deterministic rebuild without writing captures, normalized files, or provenance. */
export function rebuildEventsFromRaw(
  rawEvents: ArchwayEvent[],
  details: RawDatasetV1,
  cachedSignals: Map<string, EventDetailSignal> = new Map()
): ArchwayEvent[] {
  return normalizeEventsWithSignals(rawEvents, rebuildEventSignals(details, cachedSignals));
}

function normalizeEventsWithSignals(rawEvents: ArchwayEvent[], signals: Map<string, EventDetailSignal>): ArchwayEvent[] {
  const listing = rawEvents.map(event => {
    // These fields were historically derived by this collector, including in
    // some old caches. Only the current occurrence's evidence may restore them.
    const clean = { ...event };
    delete clean.offersFreeFood;
    delete clean.foodCategory;
    return clean;
  });
  return validateArchwayEvents(applyDetailSignalsToEvents(listing, signals));
}

function buildSignalMapFromEvents(events: ArchwayEvent[]): Map<string, EventDetailSignal> {
  const signalByUrl = new Map<string, EventDetailSignal>();
  events.forEach((event) => {
    if (!event.url) {
      return;
    }

    const signal: EventDetailSignal = {};
    if (event.offersFreeFood !== undefined) {
      signal.offersFreeFood = event.offersFreeFood;
    }
    if (event.foodCategory) {
      signal.foodCategory = event.foodCategory;
    }
    const description = sanitizeEventDescription(event.description);
    if (description) {
      signal.description = description;
    }

    if (hasEventSignal(signal)) {
      signalByUrl.set(normalizeEventUrlForLookup(event.url), signal);
    }
  });

  return signalByUrl;
}

function writeNormalizedEventArtifacts(
  rawEvents: ArchwayEvent[],
  signalByUrl: Map<string, EventDetailSignal>,
  sourceLabel: string
): void {
  const normalizedEvents = normalizeEventsWithSignals(rawEvents, signalByUrl);
  assertEventDescriptionCoverage(normalizedEvents);

  writeJsonFile(PUBLIC_JSON_PATH, normalizedEvents);
  writeJsonFile(RAG_JSON_PATH, normalizedEvents);

  const detailFoodFlags = Array.from(signalByUrl.values()).filter(
    (signal) => signal.offersFreeFood !== undefined
  ).length;
  const detailDescriptions = Array.from(signalByUrl.values()).filter(
    (signal) => Boolean(signal.description)
  ).length;

  console.log(
    `Saved normalized events from ${sourceLabel} to ${PUBLIC_JSON_PATH} and ${RAG_JSON_PATH} (${detailFoodFlags} detail food flags, ${detailDescriptions} detail descriptions)`
  );

  runGeneratorScript(MARKDOWN_GENERATOR_PATH);
}

function tryBuildFromRawCache(): boolean {
  if (!shouldUseRawCache()) {
    return false;
  }

  if (!fs.existsSync(RAW_JSON_PATH)) {
    return false;
  }

  // Upgrade old caches that predate scoped organizer capture. In particular,
  // login responses once counted as HTTP-200 detail successes. Rebuilding only
  // listing text would perpetuate missing relationships indefinitely.
  if (!fs.existsSync(DETAIL_RAW_JSON_PATH)) return false;
  const cachedDetails = validateRawDatasetV1(JSON.parse(fs.readFileSync(DETAIL_RAW_JSON_PATH, 'utf8')));
  const captured = cachedDetails.pages.filter(page => page.statusCode === 200 && Array.isArray(page.archwayOrganizers));
  if (!captured.length || captured.length / Math.max(1, cachedDetails.pages.length) < 0.3) return false;

  console.log(`Using raw cache from ${RAW_JSON_PATH} (set EVENTS_FORCE_SCRAPE=1 to refresh live).`);

  const rawEvents = validateArchwayEvents(JSON.parse(fs.readFileSync(RAW_JSON_PATH, 'utf-8')));

  if (isRawOnlyMode()) {
    console.log('RAW_ONLY enabled: raw cache already present, skipping live scrape.');
    return true;
  }

  let signalByUrl = new Map<string, EventDetailSignal>();
  const hasSignalRaw = fs.existsSync(SIGNAL_RAW_JSON_PATH);

  if (hasSignalRaw) {
    signalByUrl = readEventSignalMapFromRawFile(SIGNAL_RAW_JSON_PATH);
    console.log(
      `Loaded ${signalByUrl.size} cached event detail signals from ${SIGNAL_RAW_JSON_PATH}`
    );
  } else if (fs.existsSync(PUBLIC_JSON_PATH)) {
    const existingNormalizedEvents = validateArchwayEvents(
      JSON.parse(fs.readFileSync(PUBLIC_JSON_PATH, 'utf-8'))
    );
    signalByUrl = buildSignalMapFromEvents(existingNormalizedEvents);
    console.log(
      `Seeded ${signalByUrl.size} event detail signals from existing ${PUBLIC_JSON_PATH}`
    );
  }

  if (signalByUrl.size === 0 && fs.existsSync(DETAIL_RAW_JSON_PATH)) {
    const detailRawInput = JSON.parse(fs.readFileSync(DETAIL_RAW_JSON_PATH, 'utf-8')) as unknown;
    const detailDataset = validateRawDatasetV1(detailRawInput);
    signalByUrl = buildSignalMapFromDetailRawDataset(detailDataset);
    console.log(
      `Derived ${signalByUrl.size} event detail signals from ${DETAIL_RAW_JSON_PATH}`
    );
  }

  // Older signal caches used keyword guesses and copied flags between dates.
  // Preserve their captured descriptions, but never reuse those derived flags.
  signalByUrl = rebuildEventSignals(cachedDetails, signalByUrl);

  if (signalByUrl.size === 0) {
    console.log('No detail raw/signal raw file found; rebuilding normalized events from list raw only.');
  } else if (!hasSignalRaw) {
    writeJsonFile(SIGNAL_RAW_JSON_PATH, serializeEventSignalMap(signalByUrl));
    console.log(`Saved raw-cached event detail signals to ${SIGNAL_RAW_JSON_PATH}`);
  }

  writeNormalizedEventArtifacts(rawEvents, signalByUrl, 'raw cache');
  return true;
}

export function extractEventDetailSignalFromHtml(html: string): EventDetailSignal {
  if (!html) return {};

  const $ = load(html);
  const detailDescription = normalizeText(
    $('meta[name="description"]').attr('content') ||
      $('meta[property="og:description"]').attr('content') ||
      $('meta[name="twitter:description"]').attr('content')
  );
  const detailTitle = normalizeText($('title').first().text());
  const embeddedDescriptions = extractEmbeddedEventDescriptions(html);
  const embeddedDescription = embeddedDescriptions.sort((a, b) => b.length - a.length)[0];

  $('script, style, noscript').remove();
  const text = normalizeText($('body').text()) || '';

  const servingFoodPattern =
    /(?:do you plan on serving food\??|serving food\??)\s*[:\-]?\s*(true|false|yes|no)/i;
  const servingMatch = text.match(servingFoodPattern);
  const candidateDescriptionText = [detailTitle, detailDescription, ...embeddedDescriptions]
    .filter(Boolean)
    .join('\n');

  return {
    ...publishedFoodSignal(`${candidateDescriptionText}\n${servingMatch?.[0] ?? ''}`),
    description: sanitizeEventDescription(embeddedDescription || detailDescription),
  };
}

/**
 * How long a downloaded event page is reused while its listing row stays the same. The listing
 * (title, date, time, place, host, tags) is read every night; the page adds the description and
 * the food note, which can change without the listing changing, so a page is downloaded again at
 * least this often. Most events stay listed for weeks, so this cuts the ~240 pages a night to the
 * new, changed and older-than-this ones (Dan, November 2, 2026: read Ramapo's sites less).
 */
export const EVENT_DETAIL_REUSE_HOURS = 72;

/** Last night's event pages, kept to stand in for tonight's when nothing about the event changed. */
export interface PreviousEventDetails {
  events: ArchwayEvent[];
  pages: RawPageV1[];
  signalByUrl: Map<string, EventDetailSignal>;
}

/**
 * An event's listing row as compared night to night, without the collection times it carries and
 * in a fixed key order: a saved event comes back from validateArchwayEvents in its own order.
 */
function listingFingerprint(event: ArchwayEvent): string {
  return JSON.stringify(event, (key, value: unknown) => {
    if (key === 'collectedAt') return undefined;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
  });
}

/**
 * The event pages tonight's run can reuse from last night's capture instead of downloading, by
 * lookup URL: the event is listed exactly as before, its page was read successfully, and that
 * page is younger than EVENT_DETAIL_REUSE_HOURS. Last night's events were saved with their
 * pages' facts added (withDetailPageFacts), so tonight's listing gets the same pages' facts
 * before the two are compared; compared bare, no event ever matched (0 of 195 reused, November 4).
 * The page's place stands in for the file's, so an event that only changes place keeps last
 * night's page until it is EVENT_DETAIL_REUSE_HOURS old.
 */
export function reusableEventDetails(
  events: readonly ArchwayEvent[],
  previous: PreviousEventDetails | null,
  now = new Date(),
  maxAgeHours = EVENT_DETAIL_REUSE_HOURS
): Map<string, { page: RawPageV1; signal?: EventDetailSignal }> {
  const reusable = new Map<string, { page: RawPageV1; signal?: EventDetailSignal }>();
  if (!previous) return reusable;
  const listedBefore = new Map<string, Set<string>>();
  for (const event of previous.events) {
    if (!event.url) continue;
    const key = normalizeEventUrlForLookup(event.url);
    listedBefore.set(key, new Set([...listedBefore.get(key) ?? [], listingFingerprint(event)]));
  }
  const pageByUrl = new Map(previous.pages.map((page) => [normalizeEventUrlForLookup(page.url), page]));
  const listedTonight = new Map<string, string[]>();
  for (const event of withDetailPageFacts([...events], previous)) {
    if (!event.url) continue;
    const key = normalizeEventUrlForLookup(event.url);
    listedTonight.set(key, [...listedTonight.get(key) ?? [], listingFingerprint(event)]);
  }
  for (const [key, fingerprints] of listedTonight) {
    const before = listedBefore.get(key);
    if (!before || !fingerprints.every((fingerprint) => before.has(fingerprint))) continue;
    const page = pageByUrl.get(key);
    if (!page || page.statusCode !== 200) continue;
    const ageHours = (now.getTime() - Date.parse(page.fetchedAt)) / 3_600_000;
    if (!(ageHours >= 0 && ageHours < maxAgeHours)) continue;
    const signal = previous.signalByUrl.get(key);
    reusable.set(key, { page, ...(signal ? { signal } : {}) });
  }
  return reusable;
}

/** Last night's listing, event pages and their signals, or null when any of them is missing or unreadable. */
function readPreviousEventDetails(): PreviousEventDetails | null {
  try {
    return {
      events: validateArchwayEvents(JSON.parse(fs.readFileSync(RAW_JSON_PATH, 'utf8'))),
      pages: validateRawDatasetV1(JSON.parse(fs.readFileSync(DETAIL_RAW_JSON_PATH, 'utf8'))).pages,
      signalByUrl: readEventSignalMapFromRawFile(SIGNAL_RAW_JSON_PATH),
    };
  } catch {
    return null;
  }
}

/**
 * The event pages to download tonight and the ones reused from last night, with the reused
 * pages' signals already in signalByUrl.
 */
function planEventDetails(events: ArchwayEvent[], detailUrls: string[], signalByUrl: Map<string, EventDetailSignal>) {
  const reusable = reusableEventDetails(events, readPreviousEventDetails());
  const reused = new Map<string, RawPageV1>();
  for (const url of detailUrls) {
    const kept = reusable.get(normalizeEventUrlForLookup(url));
    if (!kept) continue;
    reused.set(url, kept.page);
    if (kept.signal) signalByUrl.set(normalizeEventUrlForLookup(url), kept.signal);
  }
  noteSiteDownloads(`Event pages: ${reused.size} of ${detailUrls.length} reused from the last capture ` +
    `(listed the same, read under ${EVENT_DETAIL_REUSE_HOURS}h ago); ${detailUrls.length - reused.size} to download.`);
  return reused;
}

function failedDetailPage(url: string, statusCode: number | null = null): RawPageV1 {
  return {
    url,
    sourceType: 'detail',
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

function buildEventDetailScrapeResult(
  pages: RawPageV1[],
  signalByUrl: Map<string, EventDetailSignal>
): EventDetailScrapeResult {
  const externalLinksSeen = new Set<string>();
  pages.forEach((page) => {
    page.externalLinks.forEach((link) => externalLinksSeen.add(link));
  });
  const pagesFetched = pages.filter(
    (page) => page.statusCode !== null && page.statusCode >= 200 && page.statusCode < 400
  ).length;
  return {
    dataset: {
      version: '1.0',
      dataset: 'events-detail',
      collectedAt: new Date().toISOString(),
      seedUrls: [ARCHWAY_URL],
      stats: {
        pagesFetched,
        pagesFailed: pages.length - pagesFetched,
        externalLinksSeen: externalLinksSeen.size,
      },
      pages,
    },
    signalByUrl,
  };
}

export async function scrapePublicEventDetailRaw(
  events: ArchwayEvent[]
): Promise<EventDetailScrapeResult> {
  const detailLimit = parseDetailLimit(process.env.ARCHWAY_EVENT_DETAIL_LIMIT, events.length);
  const detailUrls = Array.from(
    new Set(events.map((event) => event.url).filter((url): url is string => Boolean(url)))
  ).slice(0, detailLimit);
  const limit = pLimit(RAMAPO_CONCURRENCY);
  const signalByUrl = new Map<string, EventDetailSignal>();
  const reused = planEventDetails(events, detailUrls, signalByUrl);
  const pages = await Promise.all(
    detailUrls.map((url) => reused.get(url) ??
      limit(async () => {
        try {
          const response = await fetchWithPolicy(
            url,
            { headers: { Accept: 'text/html,application/xhtml+xml' } },
            {
              timeoutMs: 15_000,
              expectedContentTypes: ['text/html', 'application/xhtml+xml'],
              perHostConcurrency: RAMAPO_CONCURRENCY,
            }
          );
          const finalPath = new URL(response.url || url).pathname.toLowerCase();
          if (
            !response.ok ||
            finalPath.startsWith('/home_login') ||
            finalPath.startsWith('/login_only')
          ) {
            return failedDetailPage(url, response.ok ? null : response.status);
          }
          const html = response.text();
          if (!html) return failedDetailPage(url);
          const page = buildArchwayEventDetailPage({ requestedUrl: url, url: response.url || url, html, statusCode: response.status });
          const signal = extractEventDetailSignalFromHtml(html);
          if (hasEventSignal(signal)) {
            signalByUrl.set(normalizeEventUrlForLookup(url), signal);
          }
          return page;
        } catch {
          return failedDetailPage(url);
        }
      })
    )
  );
  return buildEventDetailScrapeResult(pages, signalByUrl);
}

async function scrapeEventDetailRaw(
  context: BrowserContext,
  events: ArchwayEvent[]
): Promise<EventDetailScrapeResult> {
  const detailLimit = parseDetailLimit(process.env.ARCHWAY_EVENT_DETAIL_LIMIT, events.length);
  const detailUrls = Array.from(
    new Set(events.map((event) => event.url).filter((url): url is string => Boolean(url)))
  ).slice(0, detailLimit);

  const limit = pLimit(RAMAPO_CONCURRENCY);
  const signalByUrl = new Map<string, EventDetailSignal>();
  const reused = planEventDetails(events, detailUrls, signalByUrl);
  const pages = await Promise.all(
    detailUrls.map((url) => reused.get(url) ??
      limit(async () => {
        try {
          await paceRamapoRequest(url);
          const response = await context.request.get(url, { timeout: 15000 });
          const statusCode = response.status();
          const html = await response.text();

          if (!html) {
            return failedDetailPage(url);
          }

          const page = buildArchwayEventDetailPage({ requestedUrl: url, url: response.url(), html, statusCode });

          const eventDetailSignal = extractEventDetailSignalFromHtml(html);
          if (
            eventDetailSignal.offersFreeFood !== undefined ||
            eventDetailSignal.foodCategory ||
            eventDetailSignal.description
          ) {
            signalByUrl.set(normalizeEventUrlForLookup(url), eventDetailSignal);
          }

          return page;
        } catch {
          return failedDetailPage(url);
        }
      })
    )
  );

  return buildEventDetailScrapeResult(pages, signalByUrl);
}

export function assertEventDescriptionCoverage(events: ArchwayEvent[]): void {
  const eventsWithUrls = events.filter((event) => Boolean(event.url));
  if (eventsWithUrls.length === 0) return;

  const descriptions = eventsWithUrls.filter((event) =>
    Boolean(sanitizeEventDescription(event.description))
  ).length;
  const minimumDescriptions = Math.min(
    3,
    Math.max(1, Math.ceil(eventsWithUrls.length * 0.05))
  );
  if (descriptions < minimumDescriptions) {
    throw new Error(
      `Archway event enrichment produced ${descriptions} usable descriptions for ` +
        `${eventsWithUrls.length} linked events; expected at least ${minimumDescriptions}.`
    );
  }
}

function validateEventDetailArtifacts(
  result: EventDetailScrapeResult,
  rawEvents: ArchwayEvent[]
): EventSignalRawDataset {
  assertRawCollectionCandidate(result.dataset, {
    outputPath: DETAIL_RAW_JSON_PATH,
    minimumPages: 1,
    minimumSuccessfulPages: 1,
    minimumDetailSuccessRate: 0.3,
    minimumPreviousPageRatio: 0.2,
  });
  const signalDataset = serializeEventSignalMap(result.signalByUrl);
  assertEventDescriptionCoverage(applyDetailSignalsToEvents(rawEvents, result.signalByUrl));
  return signalDataset;
}

function writeEventRawArtifacts(
  rawEvents: ArchwayEvent[],
  result: EventDetailScrapeResult,
  sourceUrl: string
): void {
  assertCollectionCount({
    dataset: 'Archway events',
    count: rawEvents.length,
    minimum: 1,
    previousFilePath: RAW_JSON_PATH,
    minimumPreviousRatio: 0.2,
  });
  const signalDataset = validateEventDetailArtifacts(result, rawEvents);

  // Validate the complete listing + enrichment candidate before replacing
  // any last-known-good raw input or advancing any provenance timestamp.
  writeJsonFile(RAW_JSON_PATH, rawEvents);
  writeRawProvenance('events', {
    sourceUrl,
    recordCount: rawEvents.length,
    payload: rawEvents,
  });
  writeJsonFile(DETAIL_RAW_JSON_PATH, result.dataset);
  writeRawProvenance('events-detail', {
    sourceUrl,
    recordCount: result.dataset.pages.length,
    payload: result.dataset,
  });
  writeJsonFile(SIGNAL_RAW_JSON_PATH, signalDataset);
  writeRawProvenance('events-signals', {
    sourceUrl,
    recordCount: result.signalByUrl.size,
    payload: signalDataset,
  });
}

/** The last capture's events, so a normal day reads only the groups that had events. */
function readPreviousRawEvents(): ArchwayEvent[] | null {
  try {
    if (!fs.existsSync(RAW_JSON_PATH)) return null;
    return validateArchwayEvents(JSON.parse(fs.readFileSync(RAW_JSON_PATH, 'utf-8')));
  } catch {
    return null;
  }
}

/**
 * The ticket line an event page shows beside its date ("Oct 30 FREE", "Nov 7 $5 - $10"). The
 * calendar files carry no price, and the old listing's "FREE" is what the Brain says as tickets.
 */
export function ticketStatusFromDetailPage(page: RawPageV1): string | undefined {
  for (const section of page.sections) {
    const text = normalizeText(section.text);
    const match = text?.match(
      /^[A-Z][a-z]{2}\s+\d{1,2}(?:\s*[-–]\s*(?:[A-Z][a-z]{2}\s+)?\d{1,2})?\s+(FREE|\$\s?\d[\d.,]*(?:\s*[-–]\s*\$\s?\d[\d.,]*)?)$/
    );
    if (match) return match[1];
  }
  return undefined;
}

/** The event page's own "Where" line, which the old listing showed as the event's place. */
export function whereFromDetailPage(page: RawPageV1): string | undefined {
  const where = page.sections.find((section) => /^where$/i.test(normalizeText(section.heading) ?? ''));
  const text = normalizeText(where?.text);
  return text && text !== '-' ? text : undefined;
}

/**
 * What the event pages add to the calendar files' entries: the ticket line, and the place as the
 * page words it. The files spell some places differently ("and" for "&"), write "undefined" for
 * none and hide private and online places behind sign-in, where the page says which it is.
 */
export function withDetailPageFacts(events: ArchwayEvent[], details: Pick<RawDatasetV1, 'pages'>): ArchwayEvent[] {
  const facts = new Map<string, { ticket?: string; where?: string }>();
  for (const page of details.pages) {
    if (page.sourceType !== 'detail' || page.statusCode !== 200) continue;
    facts.set(normalizeEventUrlForLookup(page.url), {
      ticket: ticketStatusFromDetailPage(page), where: whereFromDetailPage(page),
    });
  }
  return events.map((event) => {
    const found = event.url ? facts.get(normalizeEventUrlForLookup(event.url)) : undefined;
    if (!found) return event;
    return {
      ...event,
      ...(found.ticket && !event.ticketStatus ? { ticketStatus: found.ticket } : {}),
      ...(found.where ? { location: found.where } : {}),
    };
  });
}

async function fetchArchwayEvents() {
  try {
    if (tryBuildFromRawCache()) {
      return;
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`Raw cache rebuild failed (${message}). Falling back to live scrape.`);
  }

  const username = process.env.ARCHWAY_USERNAME;
  const password = process.env.ARCHWAY_PASSWORD;
  // The list comes from the groups' calendar files (archway-calendar-feeds.ts), never from
  // /mobile_ws/, which Archway's robots.txt disallows (Dan, November 3, 2026). There is no
  // browser fallback for the list: the /events page fills itself from that same address.
  console.log("Reading Archway's group calendar files...");
  const publicEvents = await fetchCalendarFeedEvents(readPreviousRawEvents());
  if (!publicEvents.length) {
    throw new Error("Archway's group calendar files hold no upcoming events.");
  }

  if (!username || !password) {
    console.log('Archway credentials are unavailable; publishing the calendar files with public event pages.');
    const detailResult = await scrapePublicEventDetailRaw(publicEvents);
    const events = withDetailPageFacts(publicEvents, detailResult.dataset);
    writeEventRawArtifacts(events, detailResult, ARCHWAY_FEED_INDEX_URL);
    console.log(`Saved ${events.length} Archway events to ${RAW_JSON_PATH}`);
    if (isRawOnlyMode()) {
      console.log('RAW_ONLY enabled: skipping normalization and context generation.');
      return;
    }
    writeNormalizedEventArtifacts(
      events,
      detailResult.signalByUrl,
      'Archway group calendar files + public detail pages'
    );
    return;
  }

  assertSiteFetchAllowed(ARCHWAY_URL);
  console.log('Launching a browser only for authenticated event-detail enrichment...');
  const browser = await chromium.launch({ headless: true });

  try {
    const context = await browser.newContext();
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', {
        get: () => undefined,
      });
    });

    const page = await context.newPage();
    console.log('Logging in to Archway...');
    await page.goto('https://archway.ramapo.edu/login_only');

    try {
      // Find the card containing "Archway Login" and click it
      const ssoOption = page.locator('div').filter({ hasText: /^Archway LoginClick below to login$/ }).first();
      await ssoOption.waitFor({ state: 'visible', timeout: 5000 });
      await ssoOption.click();
    } catch {
      console.log('Already on SSO page or Archway login button not found, continuing...');
    }

    await page.waitForSelector('#j_username', { timeout: 10000 });
    await page.fill('#j_username', username);
    await page.fill('#j_password', password);

    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle' }),
      page.click('button[type="submit"]'),
    ]);

    console.log(`Login successful; enriching ${publicEvents.length} events from the calendar files.`);

    console.log('Scraping event detail pages for raw dataset...');
    const detailResult = await scrapeEventDetailRaw(context, publicEvents);
    const detailDataset = detailResult.dataset;
    const rawEvents = withDetailPageFacts(publicEvents, detailDataset);
    writeEventRawArtifacts(rawEvents, detailResult, ARCHWAY_FEED_INDEX_URL);
    console.log(`Saved raw events to ${RAW_JSON_PATH}`);
    console.log(
      `Saved event detail raw to ${DETAIL_RAW_JSON_PATH} (${detailDataset.pages.length} pages)`
    );
    console.log(
      `Saved event detail signals to ${SIGNAL_RAW_JSON_PATH} (${detailResult.signalByUrl.size} URLs)`
    );

    if (isRawOnlyMode()) {
      console.log('RAW_ONLY enabled: skipping normalization and context generation.');
      return;
    }
    writeNormalizedEventArtifacts(rawEvents, detailResult.signalByUrl, 'calendar files + authenticated enrichment');
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('Error fetching Archway events:', message);
    throw error;
  } finally {
    await browser.close();
  }
}

if (process.argv[1]?.endsWith('archway-events.ts')) {
  fetchArchwayEvents().catch((error: unknown) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}
