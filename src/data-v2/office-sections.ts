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
import { type CapturedPage, pageKey } from '../directory/contact-evidence';

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

/** A section longer than this is kept to its start; a page is read for its how-to steps. */
export const MAX_SECTION_CHARS = 6000;
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
    const sections = kept
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
