/** Unstructured evidence from a club's own public pages, never inferred officers. */
import { chunkDocumentText } from '../src/data-v2/document-text';
import type { ArchwayClub } from './schema';
import { validateRawDatasetV1 } from './raw-types';

const text = (value: string) => value.replace(/\s+/g, ' ').trim();
const TEMPLATE_TEXT = new Set([
  'be the first to know about what we have planned and add our group calendar to your schedule.',
  'get our newsletter and stay in the loop.',
  'meeting new students with shared interest',
  'membership benefits include (define your member benefits under group settings)',
  'photos category:',
  'join', 'log in', 'loading...', 'learn more',
]);
const TEMPLATE_HEADING = /^(?:sign in|join group|\d+|there (?:are|is) no\b.*|become part of our vibrant community\.?|join our group and make an impact in (?:your|our) campus community\.?)$/i;
const QUALIFIER = 'Raw published page text. Publication/effective dates are not verified; capture time does not renew dated or historical statements. '
  + 'Names and roles in flattened text do not establish person-role pairings or current officers.';

function scope(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (url.hostname !== 'archway.ramapo.edu' || !['https:', 'http:'].includes(url.protocol)) return null;
    return url.pathname.split('/').filter(Boolean)[0]?.toLowerCase() || null;
  } catch { return null; }
}

export function renderClubDetailContext(clubs: ArchwayClub[], raw: unknown) {
  const dataset = validateRawDatasetV1(raw);
  if (dataset.dataset !== 'clubs-detail') throw new Error('Expected clubs-detail source capture');
  const byScope = new Map<string, ArchwayClub[]>();
  for (const club of clubs) {
    const key = scope(club.websiteUrl || '');
    if (key) byScope.set(key, [...byScope.get(key) || [], club]);
  }
  const stats = { capturedPages: dataset.pages.length, eligiblePages: 0, publishedPages: 0,
    publishedSections: 0, filteredSections: 0, duplicateSections: 0 };
  const seen = new Set<string>();
  let markdown = '# Public club page source text\n\n';
  // Source order stays stable; deduplication never merges distinct organizations.
  for (const page of dataset.pages) {
    const key = scope(page.url), owners = key ? byScope.get(key) : undefined;
    if (!key || owners?.length !== 1 || page.statusCode === null || page.statusCode < 200 || page.statusCode >= 300
      || !Number.isFinite(Date.parse(page.fetchedAt))) continue;
    const route = new URL(page.url).pathname.split('/').filter(Boolean)[1]?.toLowerCase();
    // Sign-in forms are UI; seed signup-card facts already have their own artifact.
    if (['web_login', 'login', 'club_signup'].includes(route || '')) continue;
    stats.eligiblePages++;
    let published = false;
    const candidates = [...page.sections, ...page.documents.map(document => ({
      heading: 'Published document link', text: `${document.label}: ${document.url}`,
    }))];
    for (const section of candidates) {
      const heading = text(section.heading) || 'Published page text';
      const value = text(section.text);
      if (!value || TEMPLATE_HEADING.test(heading) || TEMPLATE_TEXT.has(value.toLowerCase())
        || /^\[CONTENT-[^\]]+\]$/.test(value)
        || /^(?:Photos\s+)?Photos Category:$/i.test(value)) {
        stats.filteredSections++;
        continue;
      }
      const fingerprint = `${key}\n${heading.toLowerCase()}\n${value.toLowerCase()}`;
      if (seen.has(fingerprint)) { stats.duplicateSections++; continue; }
      seen.add(fingerprint);
      stats.publishedSections++;
      published = true;
      // Bound retrieval chunks, not source content. Repeat the evidence qualifier
      // in every chunk, including later pieces of long historical blog posts.
      for (const part of chunkDocumentText(value, 600, 100)) {
        const pageTitle = text(page.title || 'Published page');
        markdown += `## ${owners[0].name} — ${pageTitle} — ${heading}\n\n- URL: ${page.url}\n- Collected At: ${page.fetchedAt}\n\n`
          + `${QUALIFIER}\n\n${part}\n\n`;
      }
    }
    if (published) stats.publishedPages++;
  }
  return { markdown, stats };
}
