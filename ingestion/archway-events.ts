import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import pLimit from 'p-limit';
import { load } from 'cheerio';
import { chromium, type BrowserContext, type Page } from 'playwright';
import { assertRawCollectionCandidate, buildRawPageFromHtml } from './raw-collector';
import { fetchWithPolicy } from './http-client';
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
import { publicPath } from '../src/paths';

const ARCHWAY_URL = 'https://archway.ramapo.edu/events';
const ARCHWAY_PUBLIC_EVENTS_URL = 'https://archway.ramapo.edu/home/events/';
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

type PublicListingRow = Record<string, unknown> & {
  fields?: string;
  counter?: string;
};

function listingField(row: PublicListingRow, field: string): string | undefined {
  const fields = (row.fields ?? '').split(',').filter(Boolean);
  const index = fields.indexOf(field);
  if (index < 0) return undefined;
  const value = row[`p${index}`];
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function htmlText(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return normalizeText(load(`<div>${value}</div>`)('div').text());
}

function publicListingEvent(row: PublicListingRow): ArchwayEvent | null {
  if (listingField(row, 'displayType') !== 'event') return null;
  const title = htmlText(listingField(row, 'eventName'));
  const datesHtml = listingField(row, 'eventDates');
  if (!title || !datesHtml) return null;
  const dateParts = load(`<div>${datesHtml}</div>`)('p')
    .toArray()
    .map((part) => htmlText(load(`<div>${datesHtml}</div>`)(part).html() ?? undefined))
    .filter((part): part is string => Boolean(part));
  const date = dateParts[0];
  if (!date) return null;
  const times = (dateParts[1] ?? '')
    .split(/\s*[–—-]\s*/)
    .map((part) => part.trim())
    .filter(Boolean);
  const relativeUrl = listingField(row, 'eventUrl');
  const relativeImage = listingField(row, 'eventPicture');
  const tags = load(`<div>${listingField(row, 'eventTags') ?? ''}</div>`)('.label')
    .toArray()
    .map((tag) => htmlText(load(`<div>${listingField(row, 'eventTags') ?? ''}</div>`)(tag).html() ?? undefined))
    .filter((tag): tag is string => Boolean(tag));
  const event: ArchwayEvent = {
    title,
    date,
    ...(times[0] ? { time: times[0] } : {}),
    ...(times[1] ? { endTime: times[1] } : {}),
    ...(htmlText(listingField(row, 'clubName'))
      ? { organizer: htmlText(listingField(row, 'clubName')) }
      : {}),
    ...(htmlText(listingField(row, 'eventLocation'))
      ? { location: htmlText(listingField(row, 'eventLocation')) }
      : {}),
    ...(relativeUrl
      ? { url: new URL(relativeUrl, 'https://archway.ramapo.edu').toString() }
      : {}),
    ...(relativeImage
      ? { imageUrl: new URL(relativeImage, 'https://archway.ramapo.edu').toString() }
      : {}),
    ...(htmlText(listingField(row, 'eventPriceRange'))
      ? { ticketStatus: htmlText(listingField(row, 'eventPriceRange')) }
      : {}),
    ...(tags.length ? { tags } : {}),
  };
  return event;
}

async function fetchPublicArchwayEvents(): Promise<ArchwayEvent[]> {
  const cookies = new Map<string, string>();
  const updateCookies = (response: { headers: Headers }) => {
    const headersWithCookies = response.headers as Headers & {
      getSetCookie?: () => string[];
    };
    const combined = response.headers.get('set-cookie');
    const setCookies =
      headersWithCookies.getSetCookie?.() || (combined ? [combined] : []);
    for (const cookie of setCookies) {
      const pair = cookie.split(';')[0];
      const separator = pair.indexOf('=');
      if (separator > 0) cookies.set(pair.slice(0, separator), pair.slice(separator + 1));
    }
  };
  const cookieHeader = () =>
    [...cookies.entries()].map(([name, value]) => `${name}=${value}`).join('; ');

  let response = await fetchWithPolicy(
    ARCHWAY_PUBLIC_EVENTS_URL,
    { redirect: 'manual' },
    { expectedContentTypes: ['text/html', 'application/xhtml+xml'] }
  );
  updateCookies(response);
  const location = response.headers.get('location');
  if (!location) throw new Error('Public Archway events page did not establish a session.');
  response = await fetchWithPolicy(
    new URL(location, ARCHWAY_PUBLIC_EVENTS_URL),
    { headers: { cookie: cookieHeader() } },
    { expectedContentTypes: ['text/html', 'application/xhtml+xml'] }
  );
  updateCookies(response);
  if (!response.ok) throw new Error(`Public Archway events page returned HTTP ${response.status}.`);
  response.text();

  const events: ArchwayEvent[] = [];
  let total = 0;
  const maximumEvents = 5_000;
  for (
    let range = 0;
    (range <= total || range === 0) && range < maximumEvents;
    range += 40
  ) {
    const endpoint = new URL('/mobile_ws/v17/mobile_events_list', ARCHWAY_PUBLIC_EVENTS_URL);
    endpoint.searchParams.set('range', String(range));
    endpoint.searchParams.set('limit', '40');
    endpoint.searchParams.set('order', '');
    endpoint.searchParams.set('search_word', '');
    const listing = await fetchWithPolicy(
      endpoint,
      {
        headers: {
          cookie: cookieHeader(),
          referer: 'https://archway.ramapo.edu/events',
        },
      },
      // CampusGroups serves this JSON body with text/html in production.
      { expectedContentTypes: ['application/json', 'text/html'] }
    );
    if (!listing.ok) throw new Error(`Public Archway listing returned HTTP ${listing.status}.`);
    const rows = listing.json<PublicListingRow[]>();
    if (rows.length === 0) break;
    total = Math.max(total, ...rows.map((row) => Number(row.counter) || 0));
    if (total > maximumEvents) {
      throw new Error(`Public Archway listing reported an implausible total of ${total} events.`);
    }
    events.push(...rows.map(publicListingEvent).filter((event): event is ArchwayEvent => Boolean(event)));
    if (total === 0) break;
  }
  const unique = events.filter(
    (event, index, all) =>
      all.findIndex((candidate) =>
        candidate.title === event.title && candidate.date === event.date && candidate.time === event.time
      ) === index
  );
  return validateArchwayEvents(unique);
}

function parseDetailLimit(rawValue: string | undefined, fallback: number): number {
  if (!rawValue) return fallback;
  const parsed = Number.parseInt(rawValue, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

export function normalizeEventUrlForLookup(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    parsed.hash = '';
    if (
      parsed.host.toLowerCase() === 'archway.ramapo.edu' &&
      parsed.pathname.replace(/\/+$/, '').toLowerCase() === '/rsvp_boot'
    ) {
      const eventId = parsed.searchParams.get('id');
      parsed.search = '';
      if (eventId) parsed.searchParams.set('id', eventId);
    }
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

function classifyFoodCategory(text: string): 'food' | 'snacks' | null {
  const normalized = text.toLowerCase();
  if (!normalized) return null;

  if (
    /(?:do you plan on serving food\??|serving food\??)\s*[:\-]?\s*(true|yes)/i.test(normalized)
  ) {
    return 'food';
  }

  // Ignore non-serving contexts.
  if (/\b(food insecurity|food drive|food pantry|not serving food|no food)\b/i.test(normalized)) {
    return null;
  }

  if (/\bfree\s+food\b/i.test(normalized)) {
    return 'food';
  }

  if (/\bfood\s+(?:will be|is|are)?\s*(?:provided|served|available)\b/i.test(normalized)) {
    return 'food';
  }

  if (/\b(cookies?|snacks?|treats?|donuts?|bagels?|cupcakes?|brownies?|boba|refreshments?)\b/i.test(normalized)) {
    return 'snacks';
  }

  if (/\b(pizza|\bza\b|ice\s*cream|breakfast|brunch|lunch|dinner|meal|catering)\b/i.test(normalized)) {
    return 'food';
  }

  return null;
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

function readEventSignalMapFromRawFile(signalFilePath: string): Map<string, EventDetailSignal> {
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

  return normalizeText([page.title ?? '', ...sectionText, ...tableText].join(' ')) || '';
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

function extractEventDetailSignalFromRawPage(page: RawPageV1): EventDetailSignal {
  const text = collectRawPageSignalText(page);
  if (!text) {
    return {};
  }

  const servingFoodPattern =
    /(?:do you plan on serving food\??|serving food\??)\s*[:\-]?\s*(true|false|yes|no)/i;
  const servingMatch = text.match(servingFoodPattern);
  const isServingFood = servingMatch ? /^(true|yes)$/i.test(servingMatch[1]) : undefined;

  let offersFreeFood = isServingFood !== undefined ? isServingFood : undefined;
  let foodCategory: 'food' | 'snacks' | undefined = isServingFood ? 'food' : undefined;

  const detectedCategory = classifyFoodCategory(text);
  if (detectedCategory) {
    offersFreeFood = true;
    if (isServingFood !== true) {
      foodCategory = detectedCategory;
    }
  }

  const description = collectRawPageDescription(page);
  return {
    offersFreeFood,
    foodCategory,
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

function applyDetailSignalsToEvents(
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
  const eventsWithDetailSignals = applyDetailSignalsToEvents(rawEvents, signalByUrl);
  const eventsWithRecurringFoodSignals = propagateRecurringFoodSignals(eventsWithDetailSignals);
  const normalizedEvents = validateArchwayEvents(eventsWithRecurringFoodSignals);
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

  if (signalByUrl.size === 0) {
    console.log('No detail raw/signal raw file found; rebuilding normalized events from list raw only.');
  } else if (!hasSignalRaw) {
    writeJsonFile(SIGNAL_RAW_JSON_PATH, serializeEventSignalMap(signalByUrl));
    console.log(`Saved raw-cached event detail signals to ${SIGNAL_RAW_JSON_PATH}`);
  }

  writeNormalizedEventArtifacts(rawEvents, signalByUrl, 'raw cache');
  return true;
}

function normalizeSeriesValue(value: string | undefined): string {
  return (value ?? '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function buildRecurringSeriesKey(event: Pick<ArchwayEvent, 'title' | 'organizer'>): string {
  const title = normalizeSeriesValue(event.title);
  const organizer = normalizeSeriesValue(event.organizer);
  return `${title}::${organizer}`;
}

function propagateRecurringFoodSignals(events: ArchwayEvent[]): ArchwayEvent[] {
  const seriesCounts = new Map<string, number>();
  const seriesFoodSignal = new Map<string, 'food' | 'snacks'>();

  for (const event of events) {
    const key = buildRecurringSeriesKey(event);
    if (key === '::') {
      continue;
    }

    seriesCounts.set(key, (seriesCounts.get(key) ?? 0) + 1);

    const category = event.foodCategory || (event.offersFreeFood ? 'food' : undefined);
    if (!category) {
      continue;
    }

    const existing = seriesFoodSignal.get(key);
    if (!existing || (existing === 'snacks' && category === 'food')) {
      seriesFoodSignal.set(key, category);
    }
  }

  return events.map((event) => {
    if (event.foodCategory || event.offersFreeFood) {
      return event;
    }

    const key = buildRecurringSeriesKey(event);
    const count = seriesCounts.get(key) ?? 0;
    const propagatedCategory = seriesFoodSignal.get(key);
    if (!propagatedCategory || count < 2) {
      return event;
    }

    return {
      ...event,
      offersFreeFood: true,
      foodCategory: propagatedCategory,
    };
  });
}

function extractEventDetailSignalFromHtml(html: string): EventDetailSignal {
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
  const isServingFood = servingMatch ? /^(true|yes)$/i.test(servingMatch[1]) : undefined;
  let offersFreeFood = isServingFood !== undefined ? isServingFood : undefined;
  let foodCategory: 'food' | 'snacks' | undefined = isServingFood ? 'food' : undefined;

  const candidateDescriptionText = [detailTitle, detailDescription, ...embeddedDescriptions]
    .filter(Boolean)
    .join(' ');
  const descriptionCategory = classifyFoodCategory(candidateDescriptionText);
  if (descriptionCategory) {
    offersFreeFood = true;
    if (isServingFood !== true) {
      foodCategory = descriptionCategory;
    }
  }

  return {
    offersFreeFood,
    foodCategory,
    description: sanitizeEventDescription(embeddedDescription || detailDescription),
  };
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

async function scrapePublicEventDetailRaw(
  events: ArchwayEvent[]
): Promise<EventDetailScrapeResult> {
  const detailLimit = parseDetailLimit(process.env.ARCHWAY_EVENT_DETAIL_LIMIT, events.length);
  const detailUrls = Array.from(
    new Set(events.map((event) => event.url).filter((url): url is string => Boolean(url)))
  ).slice(0, detailLimit);
  const limit = pLimit(8);
  const signalByUrl = new Map<string, EventDetailSignal>();
  const pages = await Promise.all(
    detailUrls.map((url) =>
      limit(async () => {
        try {
          const response = await fetchWithPolicy(
            url,
            { headers: { Accept: 'text/html,application/xhtml+xml' } },
            {
              timeoutMs: 15_000,
              expectedContentTypes: ['text/html', 'application/xhtml+xml'],
              perHostConcurrency: 8,
            }
          );
          const finalPath = new URL(response.url || url).pathname.toLowerCase();
          if (
            !response.ok ||
            finalPath.startsWith('/home_login') ||
            finalPath.startsWith('/login_only')
          ) {
            return failedDetailPage(url, response.status);
          }
          const html = response.text();
          if (!html) return failedDetailPage(url, response.status);
          const signal = extractEventDetailSignalFromHtml(html);
          if (hasEventSignal(signal)) {
            signalByUrl.set(normalizeEventUrlForLookup(url), signal);
          }
          return buildRawPageFromHtml({
            url,
            html,
            sourceType: 'detail',
            statusCode: response.status,
            allowedHost: 'archway.ramapo.edu',
          });
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

  const limit = pLimit(8);
  const signalByUrl = new Map<string, EventDetailSignal>();
  const pages = await Promise.all(
    detailUrls.map((url) =>
      limit(async () => {
        try {
          const response = await context.request.get(url, { timeout: 15000 });
          const statusCode = response.status();
          const html = await response.text();

          if (!html) {
            return failedDetailPage(url);
          }

          const eventDetailSignal = extractEventDetailSignalFromHtml(html);
          if (
            eventDetailSignal.offersFreeFood !== undefined ||
            eventDetailSignal.foodCategory ||
            eventDetailSignal.description
          ) {
            signalByUrl.set(normalizeEventUrlForLookup(url), eventDetailSignal);
          }

          return buildRawPageFromHtml({
            url,
            html,
            sourceType: 'detail',
            statusCode,
            allowedHost: 'archway.ramapo.edu',
          });
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
  let publicEvents: ArchwayEvent[] | null = null;
  try {
    console.log('Fetching the official public Archway event listing...');
    publicEvents = await fetchPublicArchwayEvents();
    if (!publicEvents.length) {
      throw new Error('The public Archway listing returned no upcoming events.');
    }
  } catch (error: unknown) {
    if (!username || !password) throw error;
    console.warn(
      `Public Archway listing failed; authenticated browser listing will be used as a fallback. ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }

  if (!username || !password) {
    if (!publicEvents) throw new Error('Public Archway events are unavailable.');
    console.log('Archway credentials are unavailable; publishing the official public listing.');
    const detailResult = await scrapePublicEventDetailRaw(publicEvents);
    writeEventRawArtifacts(publicEvents, detailResult, ARCHWAY_PUBLIC_EVENTS_URL);
    console.log(`Saved ${publicEvents.length} public Archway events to ${RAW_JSON_PATH}`);
    if (isRawOnlyMode()) {
      console.log('RAW_ONLY enabled: skipping normalization and context generation.');
      return;
    }
    writeNormalizedEventArtifacts(
      publicEvents,
      detailResult.signalByUrl,
      'public Archway listing + public detail pages'
    );
    return;
  }

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

    let rawEvents = publicEvents;
    let sourceUrl = ARCHWAY_PUBLIC_EVENTS_URL;
    if (!rawEvents) {
      console.log('Login successful; loading the authenticated event listing fallback...');
      await page.goto(ARCHWAY_URL, { waitUntil: 'networkidle' });
      await scrollToLoadAll(page);
      rawEvents = validateArchwayEvents(await scrapeEvents(page));
      sourceUrl = ARCHWAY_URL;
    } else {
      console.log(
        `Login successful; enriching ${rawEvents.length} events from the public canonical listing.`
      );
    }

    console.log('Scraping event detail pages for raw dataset...');
    const detailResult = await scrapeEventDetailRaw(context, rawEvents);
    const detailDataset = detailResult.dataset;
    writeEventRawArtifacts(rawEvents, detailResult, sourceUrl);
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
    writeNormalizedEventArtifacts(rawEvents, detailResult.signalByUrl, 'public listing + authenticated enrichment');
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('Error fetching Archway events:', message);
    throw error;
  } finally {
    await browser.close();
  }
}

async function scrollToLoadAll(page: Page) {
  let previousCount = 0;
  let stagnantRounds = 0;
  const maxStagnantRounds = 3;

  for (let i = 0; i < 20; i += 1) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(2000);

    const currentCount = await page.locator('a[href*="/rsvp_boot?id="]').count();
    if (currentCount === previousCount) {
      stagnantRounds += 1;
      if (stagnantRounds >= maxStagnantRounds) {
        console.log(`Stopped scrolling after ${i + 1} rounds (no new events loaded)`);
        break;
      }
    } else {
      stagnantRounds = 0;
      console.log(`Loaded ${currentCount} events...`);
    }

    previousCount = currentCount;
  }
}

async function scrapeEvents(page: Page): Promise<ArchwayEvent[]> {
  return page.evaluate(() => {
    const eventElements = document.querySelectorAll('li.list-group-item[id^="event_"]');
    const scrapedEvents: ArchwayEvent[] = [];

    eventElements.forEach((el: Element) => {
      try {
        const titleEl = el.querySelector('h3.media-heading a');
        const title = titleEl?.textContent?.trim();
        const relativeUrl = titleEl?.getAttribute('href');
        const url = relativeUrl ? `https://archway.ramapo.edu${relativeUrl}` : undefined;
        if (!title) return;

        const imgEl = el.querySelector('.listing-element__preimg-block img');
        const relativeImageUrl = imgEl?.getAttribute('src');
        const imageUrl = relativeImageUrl ? `https://archway.ramapo.edu${relativeImageUrl}` : undefined;

        const dateIcon = el.querySelector('[aria-label="Event date"]');
        let dateText = '';
        let timeText = '';
        let endTimeText = '';

        if (dateIcon) {
          const dateTimeContainer = dateIcon.nextElementSibling;
          if (dateTimeContainer) {
            const paragraphs = dateTimeContainer.querySelectorAll('p');
            paragraphs.forEach((p: Element) => {
              const text = p.textContent?.trim() || '';
              if (text.match(/[A-Z][a-z]{2},\s+[A-Z][a-z]{2}\s+\d{1,2},\s+\d{4}/)) {
                dateText = text;
              }
              const timeMatch = text.match(/(\d{1,2}(?::\d{2})?\s+[AP]M)/g);
              if (timeMatch && timeMatch.length >= 1) {
                [timeText] = timeMatch;
                if (timeMatch.length >= 2) {
                  endTimeText = timeMatch[1];
                }
              }
            });
          }
        }

        const locationEl = el.querySelector('[aria-label="Event location"]');
        let location = locationEl?.textContent?.trim().replace(/\s+/g, ' ');
        if (location === '-' || !location) {
          location = undefined;
        }

        const descElements = el.querySelectorAll('p');
        let description = '';
        descElements.forEach((p: Element) => {
          const text = p.textContent?.trim() || '';
          if (
            text &&
            !text.match(/^[A-Z][a-z]{2},\s+[A-Z][a-z]{2}/) &&
            !text.match(/^\d{1,2}:\d{2}/) &&
            text.length > 20
          ) {
            description += `${text} `;
          }
        });
        description = description.trim();

        if (!timeText && description) {
          const descTimeMatch = description.match(/(\d{1,2}:\d{2}\s+[AP]M)/g);
          if (descTimeMatch && descTimeMatch.length >= 1) {
            [timeText] = descTimeMatch;
            if (descTimeMatch.length >= 2) {
              endTimeText = descTimeMatch[1];
            }
          }
        }

        const tagElements = el.querySelectorAll('.rsvp__event-tags .label-tag');
        const tags: string[] = [];
        tagElements.forEach((tag: Element) => {
          const tagText = tag.textContent?.trim();
          if (tagText) tags.push(tagText);
        });

        const organizerEl = el.querySelector('.listing-element__btn-block p.h6');
        const organizer = organizerEl?.textContent?.trim();
        const attendanceEl = el.querySelector('.event_display1');
        const attendance = attendanceEl?.textContent?.trim();
        const ticketEl = el.querySelector('.img-label');
        const ticketStatus = ticketEl?.textContent?.trim();

        scrapedEvents.push({
          title,
          date: dateText,
          time: timeText || undefined,
          endTime: endTimeText || undefined,
          location: location || undefined,
          organizer: organizer || undefined,
          description: description || undefined,
          url,
          imageUrl,
          tags: tags.length > 0 ? tags : undefined,
          attendance: attendance || undefined,
          ticketStatus: ticketStatus || undefined,
        });
      } catch (error) {
        console.error('Error parsing event:', error);
      }
    });

    return scrapedEvents;
  });
}

if (process.argv[1]?.endsWith('archway-events.ts')) {
  fetchArchwayEvents().catch((error: unknown) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}
