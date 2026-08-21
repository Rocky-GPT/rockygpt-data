import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { load } from 'cheerio';
import pLimit from 'p-limit';
import { assertRawCollectionCandidate, buildRawPageFromHtml } from './raw-collector';
import { fetchWithPolicy } from './http-client';
import {
  assertCollectionCount,
  isRawOnlyMode,
  runGeneratorScript,
  writeJsonFile,
  writeRawProvenance,
} from './pipeline-utils';
import { type RawDatasetV1, type RawPageV1 } from './raw-types';
import { type ArchwayClub, validateArchwayClubs } from './schema';
import { publicPath } from '../src/paths';

const CLUBS_URL = 'https://archway.ramapo.edu/club_signup?view=all&';
const ARCHWAY_HOST = 'archway.ramapo.edu';
const RAW_JSON_PATH = path.join(process.cwd(), 'data', 'raw', 'clubs.raw.json');
const DETAIL_RAW_JSON_PATH = path.join(process.cwd(), 'data', 'raw', 'clubs-detail.raw.json');
const GROUPME_DIRECTORY_RAW_JSON_PATH = path.join(
  process.cwd(),
  'data',
  'raw',
  'groupme-directory.raw.json'
);
const PUBLIC_JSON_PATH = publicPath('data', 'clubs.json');
const RAG_JSON_PATH = path.join(process.cwd(), 'data', 'normalized', 'clubs.json');
const MARKDOWN_GENERATOR_PATH = path.join(__dirname, 'generate-clubs-md.ts');

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

const DEFAULT_CLUB_DETAIL_CONCURRENCY = 8;
const DEFAULT_CLUB_TIMEOUT_MS = 15000;
const DEFAULT_MAX_PAGES_PER_CLUB = 40;

const IGNORED_QUERY_KEYS = new Set(['TB_iframe', 'height', 'width', 'modal', 'embed', 'from']);
const GROUPME_URL_PATTERN = /https?:\/\/groupme\.com\/join_(?:group|community)\/\d+\/[A-Za-z0-9_-]{8}/gi;
const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const STANDARD_CLUB_TAB_PATHS = [
  'home',
  'events',
  'news',
  'leadership-team',
  'photos',
  'documents',
  'past-newsletters',
  'surveys-forms',
  'useful-links',
  'contact-us',
] as const;

type ClubSeedRecord = ArchwayClub & {
  clubId?: string;
  mission?: string;
  memberBenefits?: string;
  membershipInfo?: string;
  signupPrompt?: string;
  rawCardText?: string;
  sourceUrl: string;
};

type ClubScope = {
  clubKey: string;
  slugLower: string;
  seedUrls: string[];
};

type FetchedPage = {
  requestedUrl: string;
  finalUrl: string;
  statusCode: number | null;
  html: string;
};

type ClubSignal = {
  email?: string;
  instagramUrl?: string;
  groupmeUrls?: string[];
};

const IGNORED_CONTACT_EMAILS = new Set([
  // Generic footer email on many Archway org pages.
  'csi@ramapo.edu',
  // Existing ignore.
  'archway-support@ramapo.edu',
]);

type EmailCandidate = {
  email: string;
  occurrences: number;
  seenOnContactUs: boolean;
};

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

function isIgnoredContactEmail(email: string): boolean {
  const normalized = normalizeEmail(email);
  if (!normalized.includes('@')) return true;
  if (normalized.endsWith('@campusgroups.com')) return true;
  return IGNORED_CONTACT_EMAILS.has(normalized);
}

function scoreEmailCandidate(params: {
  clubName: string;
  clubSlugLower: string;
  candidate: EmailCandidate;
  globalSpread: number;
}): number {
  const { clubName, clubSlugLower, candidate, globalSpread } = params;
  const emailLower = normalizeEmail(candidate.email);
  if (isIgnoredContactEmail(emailLower)) return Number.NEGATIVE_INFINITY;

  const [localPart = '', domainPart = ''] = emailLower.split('@');
  let score = 0;

  if (domainPart === 'ramapo.edu') score += 1;
  if (candidate.seenOnContactUs) score += 8;
  score += Math.min(5, candidate.occurrences);

  const nameTokens = tokensForMatch(clubName);
  nameTokens.forEach((token) => {
    if (token && localPart.includes(token)) score += 2;
  });

  const slugToken = clubSlugLower.replace(/[^a-z0-9]/g, '');
  if (slugToken && localPart.includes(slugToken)) score += 3;

  // Penalize emails that appear across many different org slugs (usually footer/campus-wide addresses).
  if (globalSpread >= 30) score -= 80;
  else if (globalSpread >= 10) score -= 40;
  else if (globalSpread >= 5) score -= 20;
  else if (globalSpread === 1) score += 2;

  return score;
}

function pickBestEmailForClub(params: {
  clubName: string;
  clubSlugLower: string;
  candidates: Map<string, EmailCandidate>;
  globalSpreads: Map<string, number>;
}): string | undefined {
  const { clubName, clubSlugLower, candidates, globalSpreads } = params;
  let bestEmail: string | undefined;
  let bestScore = Number.NEGATIVE_INFINITY;

  Array.from(candidates.values()).forEach((candidate) => {
    const emailLower = normalizeEmail(candidate.email);
    const globalSpread = globalSpreads.get(emailLower) || 0;
    const score = scoreEmailCandidate({
      clubName,
      clubSlugLower,
      candidate,
      globalSpread,
    });

    if (score > bestScore) {
      bestScore = score;
      bestEmail = candidate.email;
    }
  });

  if (!bestEmail || bestScore < 6) return undefined;
  return bestEmail;
}

type GroupmeDirectoryGroup = {
  name?: string;
  description?: string;
  share_url?: string;
  members_count?: number;
};

type GroupmeDirectoryRaw = {
  directoryGroups?: {
    ok?: boolean;
    groups?: GroupmeDirectoryGroup[];
  };
};

function parsePositiveInt(rawValue: string | undefined, fallback: number): number {
  if (!rawValue) return fallback;
  const parsed = Number.parseInt(rawValue, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function cleanText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function sanitizeNarrativeText(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const withoutScriptTail = value.replace(/\$\("#club_[\s\S]*$/i, '');
  const normalized = cleanText(withoutScriptTail);
  if (!normalized) return undefined;
  if (/^(mission|membership benefits)$/i.test(normalized)) {
    return undefined;
  }
  return normalized || undefined;
}

function toAbsoluteUrl(rawHref: string | undefined, baseUrl: string): string | undefined {
  if (!rawHref) return undefined;
  const candidate = rawHref.trim();
  if (!candidate) return undefined;
  if (/^(javascript:|mailto:|tel:)/i.test(candidate)) return undefined;

  try {
    const resolved = new URL(candidate, baseUrl);
    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') {
      return undefined;
    }
    resolved.hash = '';
    return resolved.toString();
  } catch {
    return undefined;
  }
}

function toAbsoluteArchwayUrl(rawHref: string | undefined, baseUrl: string): string | undefined {
  const resolved = toAbsoluteUrl(rawHref, baseUrl);
  if (!resolved) return undefined;
  try {
    if (new URL(resolved).host !== ARCHWAY_HOST) return undefined;
  } catch {
    return undefined;
  }
  return resolved;
}

function extractGroupmeUrlsFromStrings(values: Array<string | undefined>): string[] {
  const urls = new Set<string>();
  values.forEach((value) => {
    if (!value) return;
    const matches = value.match(GROUPME_URL_PATTERN);
    if (!matches) return;
    matches.forEach((match) => urls.add(match));
  });
  return Array.from(urls).sort((a, b) => a.localeCompare(b));
}

function safeReadJsonFile<T>(filePath: string): T | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
  } catch {
    return null;
  }
}

function normalizeNameForMatch(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const GROUPME_MATCH_STOPWORDS = new Set([
  'a',
  'an',
  'and',
  'at',
  'for',
  'from',
  'in',
  'of',
  'on',
  'or',
  'the',
  'to',
  'with',
  'ramapo',
  'college',
  'rcnj',
  'club',
  'organization',
  'org',
  'team',
  'society',
  'association',
  'meeting',
  'general',
  'group',
  'official',
]);

function tokensForMatch(value: string): string[] {
  const normalized = normalizeNameForMatch(value);
  if (!normalized) return [];
  return normalized
    .split(' ')
    .map((token) => token.trim())
    .filter((token) => token.length >= 2 && !GROUPME_MATCH_STOPWORDS.has(token));
}

function scoreTokenOverlap(aTokens: string[], bTokens: string[]): { score: number; overlap: number } {
  if (aTokens.length === 0 || bTokens.length === 0) return { score: 0, overlap: 0 };
  const a = new Set(aTokens);
  const b = new Set(bTokens);
  let overlap = 0;
  a.forEach((token) => {
    if (b.has(token)) overlap += 1;
  });
  const denom = Math.max(a.size, b.size);
  return { score: denom === 0 ? 0 : overlap / denom, overlap };
}

function mergeGroupmeDirectoryLinks(clubs: ArchwayClub[]): ArchwayClub[] {
  const raw = safeReadJsonFile<GroupmeDirectoryRaw>(GROUPME_DIRECTORY_RAW_JSON_PATH);
  const groupsRaw = raw?.directoryGroups?.ok ? raw.directoryGroups.groups : undefined;
  if (!groupsRaw || groupsRaw.length === 0) return clubs;

  const groups = groupsRaw
    .map((group) => ({
      name: group.name?.trim() || '',
      shareUrl: group.share_url?.trim() || '',
      tokens: group.name ? tokensForMatch(group.name) : [],
      normalized: group.name ? normalizeNameForMatch(group.name) : '',
    }))
    .filter((group) => Boolean(group.name && group.shareUrl));

  if (groups.length === 0) return clubs;

  const nameByShareUrl = new Map<string, string>();
  groups.forEach((group) => {
    if (!group.shareUrl || !group.name) return;
    nameByShareUrl.set(group.shareUrl, group.name);
  });

  return clubs.map((club) => {
    const clubTokens = tokensForMatch(club.name);
    const clubNormalized = normalizeNameForMatch(club.name);

    let bestScore = 0;
    const candidates: Array<{ url: string; score: number }> = [];

    groups.forEach((group) => {
      if (!group.shareUrl) return;

      if (clubNormalized && group.normalized && clubNormalized === group.normalized) {
        candidates.push({ url: group.shareUrl, score: 1 });
        bestScore = 1;
        return;
      }

      const { score, overlap } = scoreTokenOverlap(clubTokens, group.tokens);
      if (overlap < 2) return;
      if (score < 0.85) return;

      candidates.push({ url: group.shareUrl, score });
      if (score > bestScore) bestScore = score;
    });

    if (candidates.length === 0) {
      return club;
    }

    candidates.sort((a, b) => b.score - a.score || a.url.localeCompare(b.url));
    const picked = candidates
      .filter((candidate) => candidate.score === 1 || (candidate.score >= 0.92 && candidate.score >= bestScore - 0.02))
      .slice(0, 3)
      .map((candidate) => candidate.url);

    const merged = Array.from(new Set([...(club.groupmeUrls || []), ...picked])).sort((a, b) =>
      a.localeCompare(b)
    );

    const groupmeGroups = merged
      .map((url) => {
        const name = nameByShareUrl.get(url);
        if (!name) return null;
        return { name, url };
      })
      .filter((entry): entry is { name: string; url: string } => entry !== null)
      .sort((a, b) => a.name.localeCompare(b.name) || a.url.localeCompare(b.url));

    return {
      ...club,
      groupmeUrls: merged.length > 0 ? merged : undefined,
      groupmeGroups: groupmeGroups.length > 0 ? groupmeGroups : undefined,
    };
  });
}

function extractEmailsFromStrings(values: Array<string | undefined>): string[] {
  const emails = new Set<string>();
  values.forEach((value) => {
    if (!value) return;
    const matches = value.match(EMAIL_PATTERN);
    if (!matches) return;
    matches.forEach((match) => {
      const normalized = match.trim().toLowerCase();
      if (!normalized.includes('@')) return;
      if (normalized.endsWith('.')) return;
      emails.add(normalized);
    });
  });
  return Array.from(emails).sort((a, b) => a.localeCompare(b));
}

function extractEmailsFromRawPage(page: RawPageV1): string[] {
  const values: string[] = [];

  values.push(page.url);
  values.push(...page.links);
  values.push(...page.externalLinks);

  page.sections.forEach((section) => {
    values.push(section.heading);
    values.push(section.text);
  });

  page.lists.forEach((list) => {
    list.forEach((item) => values.push(item));
  });

  page.tables.forEach((table) => {
    table.headers.forEach((header) => values.push(header));
    table.rows.forEach((row) => row.forEach((cell) => values.push(cell)));
  });

  page.documents.forEach((document) => {
    values.push(document.label);
    values.push(document.url);
  });

  page.contacts.forEach((contact) => {
    if (contact.email) values.push(contact.email);
  });

  return extractEmailsFromStrings(values);
}

function normalizeUrlForStorage(rawUrl: string): string {
  const parsed = new URL(rawUrl);
  parsed.hash = '';
  if (parsed.pathname.length > 1) {
    parsed.pathname = parsed.pathname.replace(/\/{2,}/g, '/');
  }
  return parsed.toString();
}

function buildUrlKey(rawUrl: string): string {
  const parsed = new URL(rawUrl);
  const normalizedPath = parsed.pathname.replace(/\/+$/g, '') || '/';
  const params = Array.from(parsed.searchParams.entries())
    .filter(([key, value]) => !IGNORED_QUERY_KEYS.has(key) && value.trim() !== '')
    .sort(([aKey, aValue], [bKey, bValue]) =>
      aKey === bKey ? aValue.localeCompare(bValue) : aKey.localeCompare(bKey)
    );
  const normalizedQuery =
    params.length === 0
      ? ''
      : `?${params.map(([key, value]) => `${key}=${value}`).join('&')}`;

  return `${parsed.host.toLowerCase()}${normalizedPath.toLowerCase()}${normalizedQuery}`;
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

function isArchwayOrganizationUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const segment = parsed.pathname.split('/').filter(Boolean)[0];
    if (!segment) return false;
    return parsed.host === ARCHWAY_HOST && !segment.toLowerCase().startsWith('club_signup');
  } catch {
    return false;
  }
}

function mergeClubSeedRecords(existing: ClubSeedRecord, incoming: ClubSeedRecord): ClubSeedRecord {
  const mergedGroupmeUrls = Array.from(
    new Set([...(existing.groupmeUrls || []), ...(incoming.groupmeUrls || [])])
  );

  return {
    ...existing,
    logoUrl: existing.logoUrl || incoming.logoUrl,
    email: existing.email || incoming.email,
    instagramUrl: existing.instagramUrl || incoming.instagramUrl,
    mission: existing.mission || incoming.mission,
    memberBenefits: existing.memberBenefits || incoming.memberBenefits,
    membershipInfo: existing.membershipInfo || incoming.membershipInfo,
    signupPrompt: existing.signupPrompt || incoming.signupPrompt,
    rawCardText: existing.rawCardText || incoming.rawCardText,
    clubId: existing.clubId || incoming.clubId,
    groupmeUrls: mergedGroupmeUrls.length > 0 ? mergedGroupmeUrls : undefined,
  };
}

function extractInitialClubs(html: string): ClubSeedRecord[] {
  const $ = load(html);
  const recordsByKey = new Map<string, ClubSeedRecord>();

  $('li.list-group-item').each((_, element) => {
    const container = $(element);
    if (container.attr('id') === 'list-group-item_header') {
      return;
    }

    const titleLink = container.find('h2 a[href]').first();
    const absoluteLinks = container
      .find('a[href]')
      .toArray()
      .map((anchor) => toAbsoluteUrl($(anchor).attr('href'), CLUBS_URL))
      .filter((href): href is string => Boolean(href));

    const archwayWebsiteUrl = absoluteLinks.find((href) => isArchwayOrganizationUrl(href));
    const fallbackWebsiteUrl = absoluteLinks.find((href) => {
      const host = new URL(href).host.toLowerCase();
      return !host.includes('groupme.com') && !host.includes('instagram.com');
    });
    const normalizedWebsiteUrl = archwayWebsiteUrl
      ? normalizeUrlForStorage(archwayWebsiteUrl)
      : fallbackWebsiteUrl
        ? normalizeUrlForStorage(fallbackWebsiteUrl)
        : undefined;

    const roleLabel = cleanText(container.find('[role="group"]').first().attr('aria-label') || '');
    const name = cleanText(titleLink.text()) || roleLabel;
    if (!name) {
      return;
    }

    const category = cleanText(container.find('.media-body p.h5.media-heading.grey-element').first().text()) || 'Other';

    const logoSrc = container.find('img').first().attr('src') || '';
    let logoUrl: string | undefined;
    if (logoSrc && !logoSrc.includes('default_club_logo')) {
      logoUrl = toAbsoluteArchwayUrl(logoSrc, CLUBS_URL);
    }

    const clubIdInput = container.find('input[name="clubs"]').first();
    let clubId = cleanText(clubIdInput.attr('value') || '') || undefined;
    if (!clubId) {
      const inputId = cleanText(clubIdInput.attr('id') || '');
      const match = inputId.match(/cb_club_(\d+)/i);
      if (match && match[1]) {
        clubId = match[1];
      }
    }
    if (!clubId) {
      // Some cards include the id in inline script text (e.g. "#club_46329").
      const rawText = cleanText(container.text());
      const match = rawText.match(/\bclub_(\d+)\b|\bcb_club_(\d+)\b|\bemail_restriction_(\d+)\b/i);
      const recovered = match ? match.slice(1).find((group) => Boolean(group)) : undefined;
      if (recovered) {
        clubId = recovered;
      }
    }
    if (!normalizedWebsiteUrl && !clubId) {
      return;
    }

    const clubKey = normalizedWebsiteUrl
      ? buildUrlKey(normalizedWebsiteUrl)
      : clubId
        ? `club-id:${clubId}`
        : `club-name:${name.toLowerCase()}`;
    const mission = sanitizeNarrativeText(
      container
        .find('p[id]')
        .toArray()
        .map((paragraph) => ({ id: $(paragraph).attr('id') || '', text: $(paragraph).text() }))
        .find((paragraph) => /^club_\d+$/i.test(paragraph.id))?.text
    );
    const memberBenefits = sanitizeNarrativeText(
      container
        .find('p[id]')
        .toArray()
        .map((paragraph) => ({ id: $(paragraph).attr('id') || '', text: $(paragraph).text() }))
        .find((paragraph) => /^club_whatwedo_\d+$/i.test(paragraph.id))?.text
    );

    const membershipInfo = cleanText(container.find('.desc-block').first().text()) || undefined;
    const signupPrompt = cleanText(container.find('span.visually-hidden').first().text()) || undefined;
    const emailHref = container.find('a[href^="mailto:"]').first().attr('href');
    const email = emailHref ? cleanText(emailHref.replace(/^mailto:/i, '').split('?')[0]) : undefined;

    const rawCardText = cleanText(container.text()) || undefined;
    const groupmeUrls = extractGroupmeUrlsFromStrings([rawCardText, ...absoluteLinks]);

    const record: ClubSeedRecord = {
      name,
      category,
      websiteUrl: normalizedWebsiteUrl,
      logoUrl,
      email: email && email.includes('@') ? email : undefined,
      mission,
      memberBenefits,
      membershipInfo,
      signupPrompt,
      clubId,
      groupmeUrls: groupmeUrls.length > 0 ? groupmeUrls : undefined,
      rawCardText,
      sourceUrl: CLUBS_URL,
    };

    const existing = recordsByKey.get(clubKey);
    recordsByKey.set(clubKey, existing ? mergeClubSeedRecords(existing, record) : record);
  });

  return Array.from(recordsByKey.values()).sort((a, b) => a.name.localeCompare(b.name));
}

function buildClubScope(club: ClubSeedRecord): ClubScope | undefined {
  if (!club.websiteUrl) return undefined;

  try {
    const parsed = new URL(club.websiteUrl);
    if (parsed.host !== ARCHWAY_HOST) return undefined;

    const slug = parsed.pathname.split('/').filter(Boolean)[0];
    if (!slug) return undefined;

    const slugLower = slug.toLowerCase();
    const lowerBase = `${parsed.origin}/${slugLower}/`;
    const originalBase = `${parsed.origin}/${slug}/`;

    const seedUrls = new Set<string>([
      normalizeUrlForStorage(club.websiteUrl),
      normalizeUrlForStorage(lowerBase),
      normalizeUrlForStorage(originalBase),
      normalizeUrlForStorage(`${originalBase}club_signup`),
    ]);

    STANDARD_CLUB_TAB_PATHS.forEach((tabPath) => {
      seedUrls.add(normalizeUrlForStorage(`${lowerBase}${tabPath}/`));
    });

    return {
      clubKey: buildUrlKey(club.websiteUrl),
      slugLower,
      seedUrls: Array.from(seedUrls),
    };
  } catch {
    return undefined;
  }
}

function isUrlWithinClubScope(rawUrl: string, scope: ClubScope): boolean {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.host !== ARCHWAY_HOST) return false;

    const normalizedPath = (parsed.pathname.replace(/\/+$/g, '') || '/').toLowerCase();
    const prefix = `/${scope.slugLower}`;
    return normalizedPath === prefix || normalizedPath.startsWith(`${prefix}/`);
  } catch {
    return false;
  }
}

function looksLikeLoginRedirect(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    const path = parsed.pathname.toLowerCase();
    return (
      path.startsWith('/home_login') ||
      path.startsWith('/login_only') ||
      path.startsWith('/password_boot')
    );
  } catch {
    return false;
  }
}

async function fetchPublicPage(url: string, timeoutMs: number): Promise<FetchedPage> {
  try {
    const response = await fetchWithPolicy(
      url,
      {
        headers: {
          'User-Agent': DEFAULT_USER_AGENT,
          Accept: 'text/html,application/xhtml+xml',
        },
        credentials: 'omit',
        redirect: 'follow',
      },
      {
        timeoutMs,
        expectedContentTypes: ['text/html', 'application/xhtml+xml'],
        perHostConcurrency: DEFAULT_CLUB_DETAIL_CONCURRENCY,
      }
    );
    const html = response.text();
    const finalUrl = normalizeUrlForStorage(response.url || url);
    return {
      requestedUrl: normalizeUrlForStorage(url),
      finalUrl,
      statusCode: response.status,
      html,
    };
  } catch {
    return {
      requestedUrl: normalizeUrlForStorage(url),
      finalUrl: normalizeUrlForStorage(url),
      statusCode: null,
      html: '',
    };
  }
}

function scoreRawPage(page: RawPageV1): number {
  const fetchedScore =
    page.statusCode !== null && page.statusCode >= 200 && page.statusCode < 400 ? 100 : 0;
  return (
    fetchedScore +
    page.sections.length * 3 +
    page.tables.length * 4 +
    page.lists.length * 2 +
    page.contacts.length * 5 +
    page.documents.length
  );
}

function dedupeRawPages(pages: RawPageV1[]): RawPageV1[] {
  const pageByKey = new Map<string, RawPageV1>();

  pages.forEach((page) => {
    const key = buildUrlKey(page.url);
    const existing = pageByKey.get(key);
    if (!existing || scoreRawPage(page) > scoreRawPage(existing)) {
      pageByKey.set(key, page);
    }
  });

  return Array.from(pageByKey.values());
}

async function crawlClubScopePages(
  scope: ClubScope,
  maxPagesPerClub: number,
  timeoutMs: number
): Promise<RawPageV1[]> {
  const queued = new Set<string>();
  const visited = new Set<string>();
  const queue: string[] = [];
  const pages: RawPageV1[] = [];

  scope.seedUrls.forEach((seedUrl) => {
    const key = buildUrlKey(seedUrl);
    if (queued.has(key)) return;
    queued.add(key);
    queue.push(seedUrl);
  });

  while (queue.length > 0 && pages.length < maxPagesPerClub) {
    const currentUrl = queue.shift();
    if (!currentUrl) break;

    const currentKey = buildUrlKey(currentUrl);
    if (visited.has(currentKey)) {
      continue;
    }
    visited.add(currentKey);

    const fetched = await fetchPublicPage(currentUrl, timeoutMs);
    if (!fetched.html) {
      pages.push(failedDetailPage(fetched.requestedUrl, fetched.statusCode));
      continue;
    }

    if (!isUrlWithinClubScope(fetched.finalUrl, scope)) {
      if (looksLikeLoginRedirect(fetched.finalUrl)) {
        pages.push(failedDetailPage(fetched.requestedUrl, fetched.statusCode));
      }
      continue;
    }

    const builtPage = buildRawPageFromHtml({
      url: fetched.finalUrl,
      html: fetched.html,
      sourceType: 'detail',
      statusCode: fetched.statusCode,
      allowedHost: ARCHWAY_HOST,
    });
    pages.push(builtPage);

    if (pages.length >= maxPagesPerClub) {
      break;
    }

    builtPage.links.forEach((link) => {
      if (!isUrlWithinClubScope(link, scope)) return;

      const key = buildUrlKey(link);
      if (visited.has(key) || queued.has(key)) return;

      if (visited.size + queue.length >= maxPagesPerClub * 4) return;
      queued.add(key);
      queue.push(link);
    });
  }

  return pages;
}

async function collectClubDetailRaw(clubs: ClubSeedRecord[], listHtml: string): Promise<RawDatasetV1> {
  const detailLimit = parsePositiveInt(process.env.ARCHWAY_CLUB_DETAIL_LIMIT, clubs.length);
  const detailConcurrency = parsePositiveInt(
    process.env.ARCHWAY_CLUB_DETAIL_CONCURRENCY,
    DEFAULT_CLUB_DETAIL_CONCURRENCY
  );
  const timeoutMs = parsePositiveInt(process.env.ARCHWAY_CLUB_TIMEOUT_MS, DEFAULT_CLUB_TIMEOUT_MS);
  const maxPagesPerClub = parsePositiveInt(
    process.env.ARCHWAY_CLUB_MAX_PAGES_PER_CLUB,
    DEFAULT_MAX_PAGES_PER_CLUB
  );

  const scopeEntries = clubs
    .map((club) => ({ club, scope: buildClubScope(club) }))
    .filter((entry): entry is { club: ClubSeedRecord; scope: ClubScope } => Boolean(entry.scope))
    .slice(0, detailLimit);

  const crawlLimit = pLimit(detailConcurrency);
  let processed = 0;

  const perClubPages = await Promise.all(
    scopeEntries.map((entry) =>
      crawlLimit(async () => {
        const pages = await crawlClubScopePages(entry.scope, maxPagesPerClub, timeoutMs);
        processed += 1;
        if (processed % 10 === 0 || processed === scopeEntries.length) {
          console.log(
            `Crawled ${processed}/${scopeEntries.length} clubs (${pages.length} pages for ${entry.club.name})`
          );
        }
        return pages;
      })
    )
  );

  const seedPage = buildRawPageFromHtml({
    url: CLUBS_URL,
    html: listHtml,
    sourceType: 'seed',
    statusCode: 200,
    allowedHost: ARCHWAY_HOST,
  });

  const pages = dedupeRawPages([seedPage, ...perClubPages.flat()]);
  const externalLinksSeen = new Set<string>();
  pages.forEach((page) => {
    page.externalLinks.forEach((link) => externalLinksSeen.add(link));
  });

  const pagesFetched = pages.filter(
    (page) => page.statusCode !== null && page.statusCode >= 200 && page.statusCode < 400
  ).length;

  return {
    version: '1.0',
    dataset: 'clubs-detail',
    collectedAt: new Date().toISOString(),
    seedUrls: [CLUBS_URL, ...scopeEntries.flatMap((entry) => entry.scope.seedUrls)],
    stats: {
      pagesFetched,
      pagesFailed: pages.length - pagesFetched,
      externalLinksSeen: externalLinksSeen.size,
    },
    pages,
  };
}

function findClubKeyForPageUrl(pageUrl: string, scopes: ClubScope[]): string | undefined {
  return scopes.find((scope) => isUrlWithinClubScope(pageUrl, scope))?.clubKey;
}

function extractGroupmeUrlsFromRawPage(page: RawPageV1): string[] {
  const values: string[] = [];

  values.push(page.url);
  values.push(...page.links);
  values.push(...page.externalLinks);

  page.sections.forEach((section) => {
    values.push(section.heading);
    values.push(section.text);
  });

  page.lists.forEach((list) => {
    list.forEach((item) => values.push(item));
  });

  page.tables.forEach((table) => {
    table.headers.forEach((header) => values.push(header));
    table.rows.forEach((row) => row.forEach((cell) => values.push(cell)));
  });

  page.documents.forEach((document) => {
    values.push(document.label);
    values.push(document.url);
  });

  return extractGroupmeUrlsFromStrings(values);
}

function extractClubSignalsFromDetailPages(clubs: ClubSeedRecord[], pages: RawPageV1[]): Map<string, ClubSignal> {
  const scopes = clubs
    .map((club) => buildClubScope(club))
    .filter((scope): scope is ClubScope => Boolean(scope));

  const signals = new Map<string, ClubSignal>();
  const clubByKey = new Map<string, ClubSeedRecord>();
  const slugByKey = new Map<string, string>();
  clubs.forEach((club) => {
    if (!club.websiteUrl) return;
    const scope = buildClubScope(club);
    if (!scope) return;
    clubByKey.set(scope.clubKey, club);
    slugByKey.set(scope.clubKey, scope.slugLower);
  });

  const globalEmailSlugs = new Map<string, Set<string>>();
  pages.forEach((page) => {
    if (page.sourceType !== 'detail') return;
    const clubKey = findClubKeyForPageUrl(page.url, scopes);
    if (!clubKey) return;
    const slugLower = slugByKey.get(clubKey) || '';
    if (!slugLower) return;
    extractEmailsFromRawPage(page).forEach((email) => {
      const normalized = normalizeEmail(email);
      if (isIgnoredContactEmail(normalized)) return;
      const set = globalEmailSlugs.get(normalized) || new Set<string>();
      set.add(slugLower);
      globalEmailSlugs.set(normalized, set);
    });
  });
  const globalEmailSpreads = new Map<string, number>();
  globalEmailSlugs.forEach((set, email) => {
    globalEmailSpreads.set(email, set.size);
  });

  const emailCandidatesByClub = new Map<string, Map<string, EmailCandidate>>();

  pages.forEach((page) => {
    if (page.sourceType !== 'detail') return;

    const clubKey = findClubKeyForPageUrl(page.url, scopes);
    if (!clubKey) return;

    const existing = signals.get(clubKey) || {};
    let pageIsContactUs = false;
    try {
      pageIsContactUs = /\/contact-us\/?$/i.test(new URL(page.url).pathname);
    } catch {
      pageIsContactUs = false;
    }

    const clubCandidates = emailCandidatesByClub.get(clubKey) || new Map<string, EmailCandidate>();
    const emailsOnPage = extractEmailsFromRawPage(page);
    emailsOnPage.forEach((email) => {
      const normalized = normalizeEmail(email);
      if (isIgnoredContactEmail(normalized)) return;
      const current = clubCandidates.get(normalized);
      clubCandidates.set(normalized, {
        email,
        occurrences: (current?.occurrences || 0) + 1,
        seenOnContactUs: Boolean(current?.seenOnContactUs) || pageIsContactUs,
      });
    });
    emailCandidatesByClub.set(clubKey, clubCandidates);

    const instagramLink = page.externalLinks.find((link) => /instagram\.com/i.test(link));
    const groupmeUrls = Array.from(
      new Set([...(existing.groupmeUrls || []), ...extractGroupmeUrlsFromRawPage(page)])
    );

    signals.set(clubKey, {
      email: existing.email || undefined,
      instagramUrl: existing.instagramUrl || instagramLink || undefined,
      groupmeUrls: groupmeUrls.length > 0 ? groupmeUrls : undefined,
    });
  });

  Array.from(emailCandidatesByClub.entries()).forEach(([clubKey, candidates]) => {
    const club = clubByKey.get(clubKey);
    if (!club) return;
    const slugLower = slugByKey.get(clubKey) || '';
    const bestEmail = pickBestEmailForClub({
      clubName: club.name,
      clubSlugLower: slugLower,
      candidates,
      globalSpreads: globalEmailSpreads,
    });
    if (!bestEmail) return;
    const existing = signals.get(clubKey) || {};
    signals.set(clubKey, { ...existing, email: existing.email || bestEmail });
  });

  return signals;
}

function toNormalizedClub(club: ClubSeedRecord, signal?: ClubSignal): ArchwayClub {
  const groupmeUrls = Array.from(
    new Set([...(club.groupmeUrls || []), ...(signal?.groupmeUrls || [])])
  );

  const categoryLower = (club.category || '').toLowerCase();
  const bucket: ArchwayClub['bucket'] =
    categoryLower.includes('department')
      ? 'departments'
      : categoryLower.includes('honor society') || categoryLower.includes('honour society')
        ? 'honor_societies'
        : (categoryLower.includes('greek life') ||
              categoryLower.includes('fratern') ||
              categoryLower.includes('sororit') ||
              categoryLower.includes('greek letter')) &&
            !categoryLower.includes('department')
          ? 'greek_life'
          : categoryLower.includes('athletics') || categoryLower.includes('sports / recreation')
            ? 'athletics'
          : categoryLower.includes('student organization')
            ? 'student_orgs'
            : 'other';

  return {
    name: club.name,
    category: club.category || 'Other',
    bucket,
    logoUrl: club.logoUrl,
    websiteUrl: club.websiteUrl,
    // Prefer seed card fields over detail page signals.
    email: club.email || signal?.email,
    instagramUrl: club.instagramUrl || signal?.instagramUrl,
    groupmeUrls: groupmeUrls.length > 0 ? groupmeUrls : undefined,
  };
}

async function fetchArchwayClubs() {
  console.log('Starting public Club scraper...');
  console.log('Using public, logged-out requests only (no login/session cookies).');

  try {
    console.log(`Fetching club list from ${CLUBS_URL}...`);
    const listResponse = await fetchPublicPage(CLUBS_URL, DEFAULT_CLUB_TIMEOUT_MS);
    if (!listResponse.html || !listResponse.statusCode || listResponse.statusCode >= 400) {
      throw new Error(
        `Failed to fetch club list: ${listResponse.statusCode ?? 'network error'} (${listResponse.finalUrl})`
      );
    }

    const rawClubs = extractInitialClubs(listResponse.html);
    const validatedSeedClubs = validateArchwayClubs(rawClubs);
    assertCollectionCount({
      dataset: 'Archway clubs',
      count: validatedSeedClubs.length,
      minimum: 100,
      previousFilePath: RAW_JSON_PATH,
      minimumPreviousRatio: 0.7,
    });

    console.log('Crawling all public pages for each club into raw detail dataset...');
    const detailDataset = await collectClubDetailRaw(rawClubs, listResponse.html);
    assertRawCollectionCandidate(detailDataset, {
      outputPath: DETAIL_RAW_JSON_PATH,
      minimumPages: 10,
      minimumSuccessfulPages: 5,
      minimumDetailSuccessRate: 0.3,
      minimumPreviousPageRatio: 0.5,
    });

    // Validate both publish inputs before replacing either last-known-good
    // artifact or advancing source provenance.
    writeJsonFile(RAW_JSON_PATH, rawClubs);
    writeRawProvenance('clubs', {
      sourceUrl: CLUBS_URL,
      recordCount: rawClubs.length,
      payload: rawClubs,
    });
    console.log(`Saved ${rawClubs.length} raw clubs to ${RAW_JSON_PATH}`);
    writeJsonFile(DETAIL_RAW_JSON_PATH, detailDataset);
    writeRawProvenance('clubs-detail', {
      sourceUrl: CLUBS_URL,
      recordCount: detailDataset.pages.length,
      payload: detailDataset,
    });
    console.log(`Saved club detail raw to ${DETAIL_RAW_JSON_PATH} (${detailDataset.pages.length} pages)`);

    if (isRawOnlyMode()) {
      console.log('RAW_ONLY enabled: skipping normalization and context generation.');
      return;
    }

    console.log('Building normalized club records from raw dataset signals...');
    const signalByClubKey = extractClubSignalsFromDetailPages(rawClubs, detailDataset.pages);
    const normalizedClubsFromArchway = validateArchwayClubs(
      rawClubs.map((club) =>
        toNormalizedClub(
          club,
          club.websiteUrl ? signalByClubKey.get(buildUrlKey(club.websiteUrl)) : undefined
        )
      )
    );

    // Authenticated GroupMe captures are a separate, manual workflow. Do not
    // silently mix an untracked/stale local capture into the automated
    // publish snapshot. Operators can explicitly opt in for a manual rebuild.
    const normalizedClubs =
      process.env.ARCHWAY_USE_GROUPME_DIRECTORY === '1'
        ? mergeGroupmeDirectoryLinks(normalizedClubsFromArchway)
        : normalizedClubsFromArchway;

    writeJsonFile(PUBLIC_JSON_PATH, normalizedClubs);
    writeJsonFile(RAG_JSON_PATH, normalizedClubs);
    console.log(`Saved normalized clubs to ${PUBLIC_JSON_PATH} and ${RAG_JSON_PATH}`);

    runGeneratorScript(MARKDOWN_GENERATOR_PATH);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('Fatal error:', message);
    process.exit(1);
  }
}

fetchArchwayClubs();
