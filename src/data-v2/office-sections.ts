/**
 * Office sections: what an office's own site says, page by page. Every captured page under a
 * reviewed office site's folder on www.ramapo.edu (office-sites.json) is one row, with the
 * page's headed sections as captured, less the reviewed section cuts; a page whose cut no longer
 * matches is left out rather than published uncut. The identity compile links each office to the
 * pages of the folder its own reviewed website names, so "how do I request a transcript" is read
 * from the Registrar's pages, never from a search across the whole site.
 */
import { createHash } from 'crypto';
import { cutSections, type SkippedSection } from '../../ingestion/folder-sites';
import { type CapturedPage, type CapturedSection, pageKey } from '../directory/contact-evidence';

export interface OfficeSection { heading: string; text: string }
export interface OfficeSectionsPage {
  /** The page key: host and path, the same key the evidence checks use. */
  key: string;
  folder: string;
  url: string;
  fetchedAt: string;
  sections: OfficeSection[];
  contentHash: string;
}

/** A section longer than this is kept to its start. 6,000 cut 124 sections of rules students ask
 * about (Residence Life's prohibited items); the Brain says the part of a long section that matches. */
export const MAX_SECTION_CHARS = 20000;
/** A page with more sections than this keeps its first ones. */
export const MAX_PAGE_SECTIONS = 60;

/** The first folder of a www.ramapo.edu address ("counseling" for /counseling/faq/), or null. */
export function siteFolder(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (!/^(www\.)?ramapo\.edu$/i.test(parsed.hostname)) return null;
    const first = parsed.pathname.split('/').filter(Boolean)[0];
    return first ? first.toLowerCase() : null;
  } catch {
    return null;
  }
}

/**
 * A section holding FAQ items, as its own text before the first question and then one section per
 * question with its answer, so "what is the transfer credit limit" is one small section rather
 * than the tenth question of a long one.
 */
function faqItems(section: CapturedSection): OfficeSection[] {
  const asked = section.questions ?? [];
  if (!asked.length) return [{ heading: section.heading, text: section.text }];
  const first = section.text.indexOf(asked[0].question);
  const intro = first > 0 ? section.text.slice(0, first).trim() : '';
  return [...intro ? [{ heading: section.heading, text: intro }] : [],
    ...asked.map(entry => ({ heading: entry.question, text: entry.answer }))];
}

/** The captured pages of the reviewed office sites, each with its sections less the cuts. */
export function officeSectionPages(pages: ReadonlyMap<string, CapturedPage>, folders: ReadonlySet<string>,
  cuts: ReadonlyMap<string, readonly SkippedSection[]>): OfficeSectionsPage[] {
  const rows: OfficeSectionsPage[] = [];
  for (const page of pages.values()) {
    const folder = siteFolder(page.url);
    if (!folder || !folders.has(folder)) continue;
    const key = pageKey(page.url);
    const kept = cutSections(page.sections, cuts.get(key) ?? []);
    if (!kept) continue;
    const sections = kept.flatMap(faqItems)
      .map(section => ({ heading: section.heading.replace(/\s+/g, ' ').trim(),
        text: section.text.trim().slice(0, MAX_SECTION_CHARS) }))
      .filter(section => section.text)
      .slice(0, MAX_PAGE_SECTIONS);
    if (!sections.length) continue;
    const contentHash = createHash('sha256').update(JSON.stringify(sections)).digest('hex');
    rows.push({ key, folder, url: page.url, fetchedAt: page.fetchedAt, sections, contentHash });
  }
  return rows.sort((a, b) => a.key.localeCompare(b.key));
}

/** A reviewed owner of an office site whose website claim names another folder or none. */
export interface SiteOwner { folder: string; owner: string; evidence_url: string; evidence_quote: string; note: string }
export interface SiteOwners { reviewed_on: string; sites: SiteOwner[] }

const folded = (text: string) => text.replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * The reviewed site owners whose evidence still holds: the quote is on its page in this run's
 * capture, the page is in the owned folder, and the folder is a reviewed office site. Anything
 * else stops the publish, so an owner is never linked from an older reading.
 */
export function checkSiteOwners(reviewed: SiteOwners, pages: ReadonlyMap<string, CapturedPage>,
  folders: ReadonlySet<string>): SiteOwner[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const site of reviewed.sites) {
    const fail = (why: string) => problems.push(`${site.folder}: ${why}`);
    if (seen.has(site.folder)) { fail('listed twice'); continue; }
    seen.add(site.folder);
    if (!folders.has(site.folder)) { fail('is not a reviewed office site'); continue; }
    if (siteFolder(site.evidence_url) !== site.folder) { fail('its evidence page is in another folder'); continue; }
    const page = pages.get(pageKey(site.evidence_url));
    if (!page) { fail(`${site.evidence_url} is not in this capture`); continue; }
    const text = folded(page.sections.map(section => `${section.heading} ${section.text}`).join(' '));
    if (!text.includes(folded(site.evidence_quote))) fail(`the quote is no longer on ${site.evidence_url}`);
  }
  if (problems.length) throw new Error(`Reviewed office site owners need review:\n${problems.join('\n')}`);
  return reviewed.sites;
}
