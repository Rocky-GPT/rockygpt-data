/**
 * major-pages.ts
 *
 * Ramapo's public program pages: majors, minors, concentrations and graduate programs.
 * The index at /majors-minors/ lists every program as a card with its page, name, degree
 * and what it offers (major, minor, graduate and so on, named by the index's own legend).
 * Each page describes its program in sections and links the catalog program ("See all
 * courses and degree requirements").
 *
 * A page names its programs only through those catalog links: a catalog code, or the
 * catalog's program group ID, which the captured catalog resolves to a code. The first one
 * is the page's own program; others it links as its own, such as a minor on a major's page,
 * are kept as further programs it describes. Links in a "Related Programs" section name
 * other programs and are kept apart. Nothing is linked by name, and a page that links no
 * catalog program of its own is reported, not guessed.
 *
 * Run: npm run fetch:major-pages
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { load } from 'cheerio';
import type { AnyNode, Element, Text } from 'domhandler';
import { fetchWithPolicy } from './http-client';
import { writeJsonFile, writeRawFileProvenance } from './pipeline-utils';
import { publicPath } from '../src/paths';

export const MAJORS_INDEX_URL = 'https://www.ramapo.edu/majors-minors/';
const OUT = publicPath('data', 'major-pages.json');
const RAW_OUT = path.join(process.cwd(), 'data', 'raw', 'major-pages.raw.json');
const PROGRAMS_JSON = publicPath('data', 'programs.json');
const CATALOG_API_RAW = path.join(process.cwd(), 'data', 'raw', 'catalog-programs-api.raw.json');
const HEADERS = {
  accept: 'text/html,application/xhtml+xml',
  'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
};
// One page at a time, with a pause, like a person reading the pages.
const PAUSE_MS = 300;

export interface MajorListing {
  url: string;
  name: string;
  /** The degree lines the index card shows, such as "Bachelor of Science". */
  degrees: string[];
  /** What the program offers, in the index legend's words: "Major", "Minor", "Graduate"... */
  offers: string[];
}
export interface PageSection { heading: string; text: string }
export interface PageLink { name: string; url: string; section: string }
export interface MajorPageContent { title: string; sections: PageSection[]; links: PageLink[] }
export interface CatalogLink extends PageLink { code: string | null }
export interface MajorPage extends MajorListing, MajorPageContent {
  id: string;
  /** Where the listed page led, when it redirected. */
  finalUrl: string | null;
  catalogLinks: CatalogLink[];
  /** The catalog code of the page's own program: the first catalog program it links as its
   * own ("See all courses and degree requirements"). A source record has one identity. */
  programCodes: string[];
  /** Other catalog programs the page links as its own, such as a minor it also describes. */
  otherProgramCodes: string[];
  /** Catalog codes the page links in a "Related Programs" section. */
  relatedProgramCodes: string[];
  limitations: string[];
}
export interface MajorPagesArtifact {
  schema_version: 1;
  source_url: string;
  captured_at: string;
  pages: MajorPage[];
  unresolved: Array<{ name: string; url: string; reason: string }>;
  /** Programs the index lists whose page is gone; nothing of them is published. */
  unavailable: Array<{ name: string; url: string; status: number }>;
}

const clean = (value: string) => value.replace(/\s+/g, ' ').trim();
const unique = <T>(values: T[]) => [...new Set(values)];
const absolute = (href: string | undefined, base: string) => {
  try { return href ? new URL(href, base).toString() : ''; } catch { return ''; }
};

/** Every program card on the index, with the legend's names for the keys it shows. */
export function majorListings(html: string, base = MAJORS_INDEX_URL): MajorListing[] {
  const $ = load(html);
  const legend = new Map<string, string>();
  $('li[rel]').each((_, item) => {
    const key = clean($(item).children('span').first().text());
    const label = clean($(item).clone().children('span').remove().end().text());
    if (key && label) legend.set(key, label);
  });
  const listings = $('.course-wrap[data-url]').toArray().map(card => {
    const $card = $(card);
    const degrees = ($card.children('h4').first().html() ?? '').split(/<br\s*\/?>/i)
      .map(part => clean(load(part).text())).filter(Boolean);
    const offers = $card.find('.keys span').toArray().map(span => clean($(span).text())).filter(Boolean)
      .map(key => legend.get(key) ?? key);
    return { url: absolute($card.attr('data-url'), base), name: clean($card.children('h3').first().text()), degrees, offers };
  }).filter(listing => listing.url && listing.name);
  if (!listings.length) throw new Error('The majors index lists no programs.');
  return listings;
}

const BLOCK = new Set(['address', 'article', 'blockquote', 'br', 'dd', 'div', 'dl', 'dt', 'figcaption', 'figure', 'hr',
  'li', 'ol', 'p', 'section', 'table', 'tbody', 'td', 'th', 'thead', 'tr', 'ul']);

/** A page's own content: its sections by top heading, and every named link with its section. */
export function parseMajorPage(html: string, url: string): MajorPageContent {
  const $ = load(html);
  const block = $('#content-block').first();
  if (!block.length) throw new Error(`No program content on ${url}.`);
  block.find('script, style, noscript, iframe, form').remove();
  // Newer pages divide the content with h2 headings; older ones with h3.
  const top = ['h2', 'h3'].find(tag => block.find(tag).length) ?? null;
  const sections: PageSection[] = [];
  const links: PageLink[] = [];
  let heading = '';
  let lines: string[] = [];
  let line = '';
  const endLine = () => { const text = clean(line); if (text) lines.push(text); line = ''; };
  const endSection = () => {
    endLine();
    if (lines.length) sections.push({ heading, text: lines.join('\n') });
    lines = [];
  };
  const walk = (node: AnyNode) => {
    if (node.type === 'text') { line += ` ${(node as Text).data}`; return; }
    if (node.type !== 'tag') return;
    const element = node as Element;
    const tag = element.tagName.toLowerCase();
    if (tag === top) { endSection(); heading = clean($(element).text()); return; }
    if (/^h[1-6]$/.test(tag)) { endLine(); line = clean($(element).text()); endLine(); return; }
    if (tag === 'a') {
      const href = $(element).attr('href')?.trim() ?? '';
      const name = clean($(element).text());
      const target = /^(#|javascript:)/i.test(href) ? '' : absolute(href, url);
      if (name && target) links.push({ name, url: target, section: heading });
    }
    const block = BLOCK.has(tag);
    if (block) endLine();
    if (tag === 'li') line = '- ';
    element.children.forEach(walk);
    if (block) endLine();
  };
  block.contents().toArray().forEach(walk);
  endSection();
  return { title: clean($('h1').last().text()), sections, links };
}

const CATALOG_PROGRAM = /^https:\/\/catalog\.ramapo\.edu\/programs\/([^/?#]+)\/?(?:[?#].*)?$/;

/** A page's catalog program links, each resolved to a catalog code where the catalog has one. */
export function catalogLinks(links: PageLink[], codes: Set<string>, groups: Map<string, string>): CatalogLink[] {
  return links.flatMap(link => {
    const reference = CATALOG_PROGRAM.exec(link.url)?.[1];
    if (!reference) return [];
    const code = decodeURIComponent(reference).toUpperCase();
    return [{ ...link, code: codes.has(code) ? code : groups.get(decodeURIComponent(reference)) ?? null }];
  });
}

const pageId = (url: string) => crypto.createHash('sha256').update(url).digest('hex').slice(0, 32);
const nameKey = (value: string) => clean(value).toLowerCase().replace(/[‐-―]/g, '-');

/** A captured page with its catalog programs and any caveats about how it was reached. */
export function majorPage(listing: MajorListing, content: MajorPageContent, finalUrl: string,
  codes: Set<string>, groups: Map<string, string>): MajorPage {
  const catalog = catalogLinks(content.links, codes, groups);
  const related = (link: CatalogLink) => /\brelated\b/i.test(link.section);
  const own = unique(catalog.filter(link => !related(link) && link.code).map(link => link.code!));
  const limitations: string[] = [];
  const unknown = unique(catalog.filter(link => !link.code).map(link => link.url));
  if (unknown.length) limitations.push(`These catalog links are not in the captured catalog: ${unknown.join(', ')}.`);
  // A redirect can land on another page. A moved page keeps its slug; otherwise the page
  // must still name the listed program.
  const slug = (value: string) => value.replace(/\/+$/, '').split('/').pop()!.toLowerCase();
  const elsewhere = finalUrl !== listing.url && slug(finalUrl) !== slug(listing.url)
    && !nameKey(content.title).includes(nameKey(listing.name));
  if (elsewhere) limitations.push(`The listed link led to ${finalUrl}, titled "${content.title}", which does not name this program.`);
  if (!own.length && !elsewhere) limitations.push('The page links no catalog program of its own, so it is not linked to one.');
  return {
    id: pageId(listing.url), ...listing, finalUrl: finalUrl === listing.url ? null : finalUrl, ...content,
    catalogLinks: catalog, programCodes: elsewhere ? [] : own.slice(0, 1),
    otherProgramCodes: elsewhere ? [] : own.slice(1),
    relatedProgramCodes: unique(catalog.filter(link => related(link) && link.code).map(link => link.code!))
      .filter(code => !own.includes(code)),
    limitations,
  };
}

/** A page, or its status when the site says it is gone. Any other failure stops the capture,
 * so a temporary outage never quietly drops pages. */
async function fetchPage(url: string): Promise<{ html: string; finalUrl: string } | { gone: number }> {
  const response = await fetchWithPolicy(url, { headers: HEADERS }, { expectedContentTypes: ['text/html'], maxResponseBytes: 8 * 1024 * 1024 });
  if (response.status === 404 || response.status === 410) return { gone: response.status };
  if (!response.ok) throw new Error(`${response.status} ${response.statusText} for ${url}`);
  return { html: response.text(), finalUrl: response.url || url };
}

/** Catalog codes and program group IDs as the captured catalog publishes them. */
function catalogReferences(): { codes: Set<string>; groups: Map<string, string> } {
  const published = (JSON.parse(fs.readFileSync(PROGRAMS_JSON, 'utf8')) as { schools: Array<{ majors: Array<{ catalogCode?: string }> }> })
    .schools.flatMap(school => school.majors).map(program => program.catalogCode).filter((code): code is string => Boolean(code));
  const api = JSON.parse(fs.readFileSync(CATALOG_API_RAW, 'utf8')) as { programs: Array<{ code?: string; programGroupId?: string }> };
  const groups = new Map(api.programs.filter(program => program.code && program.programGroupId)
    .map(program => [program.programGroupId!, program.code!]));
  return { codes: new Set([...published, ...groups.values()]), groups };
}

async function main() {
  const capturedAt = new Date().toISOString();
  const { codes, groups } = catalogReferences();
  const index = await fetchPage(MAJORS_INDEX_URL);
  if ('gone' in index) throw new Error(`The majors index returned ${index.gone}.`);
  const listings = majorListings(index.html);
  const pages: MajorPage[] = [];
  const unavailable: MajorPagesArtifact['unavailable'] = [];
  const captured: Array<{ url: string; finalUrl: string; sha256: string; bytes: number }> = [];
  for (const listing of listings) {
    const page = await fetchPage(listing.url);
    if ('gone' in page) {
      unavailable.push({ name: listing.name, url: listing.url, status: page.gone });
      continue;
    }
    captured.push({ url: listing.url, finalUrl: page.finalUrl, sha256: crypto.createHash('sha256').update(page.html).digest('hex'), bytes: page.html.length });
    pages.push(majorPage(listing, parseMajorPage(page.html, page.finalUrl), page.finalUrl, codes, groups));
    await new Promise(resolve => setTimeout(resolve, PAUSE_MS));
  }
  const artifact: MajorPagesArtifact = {
    schema_version: 1, source_url: MAJORS_INDEX_URL, captured_at: capturedAt, pages,
    unresolved: pages.filter(page => !page.programCodes.length).map(page => ({ name: page.name, url: page.url, reason: page.limitations.join(' ') })),
    unavailable,
  };
  writeJsonFile(RAW_OUT, { capturedAt, index: { url: MAJORS_INDEX_URL, finalUrl: index.finalUrl }, listings, pages: captured, unavailable });
  writeRawFileProvenance('major-pages', RAW_OUT, { sourceUrl: MAJORS_INDEX_URL, recordCount: pages.length, fetchedAt: capturedAt });
  writeJsonFile(OUT, artifact);
  const linked = pages.filter(page => page.programCodes.length).length;
  console.log(`Wrote ${pages.length} program pages; ${linked} linked to a catalog program, ${pages.length - linked} not linked, ${unavailable.length} listed pages gone.`);
}

if (process.argv[1]?.endsWith('major-pages.ts')) {
  main().catch(error => { console.error('Fatal:', error); process.exitCode = 1; });
}
