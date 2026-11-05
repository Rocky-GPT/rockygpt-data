import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { load } from 'cheerio';
import { assertRawCollectionCandidate } from './raw-collector';
import { noteSiteDownloads } from './site-guard';
import { ARCHWAY_FEED_INDEX_URL, calendarFilePages, fetchCalendarFeedEvents } from './archway-calendar-feeds';
import { addAppFacts } from './archway-app-events';
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
    // Every event goes out with readable text only, whether or not a page or entry added to it.
    const description = sanitizeEventDescription(event.description);
    const readable = { ...event, description };
    if (!description) delete readable.description;
    if (!event.url) return readable;
    const details = signalByUrl.get(normalizeEventUrlForLookup(event.url));
    if (!details) return readable;
    return {
      ...event,
      description: sanitizeEventDescription(details.description) ?? description,
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
  // An event without a signal from its own captured page (every event since the pages became a
  // browser app) takes its food note and description from its own calendar entry.
  const fromListing = listingEventSignals(listing);
  const merged = new Map([...fromListing, ...signals]);
  return validateArchwayEvents(applyDetailSignalsToEvents(listing, merged));
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
  // A capture counts when its pages are the calendar files (since November 5, 2026), or event
  // pages read with their Hosted By block.
  const captured = cachedDetails.pages.filter(page => page.statusCode === 200 &&
    (Array.isArray(page.archwayOrganizers) || page.url.startsWith('https://archway.ramapo.edu/ical/')));
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
    // Compared with the last capture's calendar files only: until November 5, 2026 the capture
    // held one page per event, a different count of a different thing.
    comparablePreviousPage: (page) => page.url.startsWith('https://archway.ramapo.edu/ical/'),
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
 * What an event's own calendar entry says about food, and its description: the entry is the
 * occurrence's captured source text since Archway's event pages became a browser app.
 */
export function listingEventSignals(events: readonly ArchwayEvent[]): Map<string, EventDetailSignal> {
  const signals = new Map<string, EventDetailSignal>();
  for (const event of events) {
    if (!event.url) continue;
    const description = sanitizeEventDescription(event.description);
    const signal: EventDetailSignal = {
      ...publishedFoodSignal(`${event.title}\n${event.description ?? ''}`),
      ...(description ? { description } : {}),
    };
    if (hasEventSignal(signal)) signals.set(normalizeEventUrlForLookup(event.url), signal);
  }
  return signals;
}

/** Tonight's calendar files as the capture behind the events (events-detail.raw.json). */
export function calendarFileDataset(pages: RawPageV1[], collectedAt = new Date().toISOString()): RawDatasetV1 {
  return {
    version: '1.0',
    dataset: 'events-detail',
    collectedAt,
    seedUrls: [ARCHWAY_FEED_INDEX_URL],
    stats: { pagesFetched: pages.length, pagesFailed: 0, externalLinksSeen: 0 },
    pages,
  };
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

  // The list comes from the groups' calendar files (archway-calendar-feeds.ts), never from
  // /mobile_ws/, which Archway's robots.txt disallows (Dan, November 3, 2026). The event pages
  // are not read: since November 5, 2026 they are an app that fills itself in the browser, and
  // any other reader gets the same empty shell. The app's own list (about six requests) adds the
  // ticket line and the place; everything else comes from the files' own entries.
  console.log("Reading Archway's group calendar files...");
  const feed = await fetchCalendarFeedEvents(readPreviousRawEvents());
  if (!feed.events.length) {
    throw new Error("Archway's group calendar files hold no upcoming events.");
  }
  const { files } = feed;
  // The ticket line and the place as Archway's events app gives them (archway-app-events.ts).
  const { events } = await addAppFacts(feed.events);
  const result: EventDetailScrapeResult = {
    dataset: calendarFileDataset(calendarFilePages(files, events)),
    signalByUrl: listingEventSignals(events),
  };
  noteSiteDownloads(`Event pages: none downloaded (Archway's event pages are a browser app now); ` +
    `${events.length} events from ${result.dataset.pages.length} calendar files.`);
  writeEventRawArtifacts(events, result, ARCHWAY_FEED_INDEX_URL);
  console.log(`Saved ${events.length} Archway events to ${RAW_JSON_PATH}`);
  if (isRawOnlyMode()) {
    console.log('RAW_ONLY enabled: skipping normalization and context generation.');
    return;
  }
  writeNormalizedEventArtifacts(events, result.signalByUrl, 'Archway group calendar files');
}

if (process.argv[1]?.endsWith('archway-events.ts')) {
  fetchArchwayEvents().catch((error: unknown) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}
