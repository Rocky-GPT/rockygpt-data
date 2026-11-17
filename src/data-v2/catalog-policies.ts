/**
 * The college's academic policies, as the course catalog publishes them. The Provost's own policy
 * addresses on www.ramapo.edu (/provost/policy/used-name/) redirect to the catalog's academic
 * policies page, which says the Office of the Provost is responsible for every academic policy and
 * links one catalog page holding all of them as tabs. The catalog is a Coursedog app. Until
 * November 2026 that page's server HTML carried its tabs (__NUXT_DATA__); now the index's own
 * script asks Coursedog for the page when a visitor opens a policy, and a plain request for the
 * same address is refused (401). So the collector opens the index in a browser and keeps the
 * page record the index's script receives: its published widgets, each tab with a name, an
 * anchor and its HTML. Each policy is one office_sections row (folder CATALOG_POLICIES_FOLDER)
 * with its headed sections, cited to its own anchor on the index; the identity compile links them
 * to the reviewed owner.
 */
import { createHash } from 'crypto';
import { load } from 'cheerio';
import { buildRawPageFromHtml } from '../../ingestion/raw-collector';
import { MAX_PAGE_SECTIONS, MAX_SECTION_CHARS, type OfficeSectionsPage } from './office-sections';

export const CATALOG_POLICIES_FOLDER = 'catalog-academic-policies';
export const CATALOG_POLICIES_INDEX = 'https://catalog.ramapo.edu/quicklinks/academicpolicies';

export interface CatalogPolicy { id: string; name: string; anchor: string; html: string }
export interface CatalogPoliciesCapture {
  dataset: 'catalog-policies';
  collectedAt: string;
  /** The index page's own text (who is responsible) and the catalog page it links. */
  index: { url: string; text: string };
  page: { url: string; publishedAt: string | null };
  policies: CatalogPolicy[];
}
export interface CatalogPoliciesOwner { folder: string; owner: string; evidence_url: string; evidence_quote: string; reviewed_on: string }

const folded = (text: string) => text.replace(/\s+/g, ' ').trim().toLowerCase();

/** The catalog page the index links to for its policies ("/pages/<id>"), as a full address. */
export function policiesPageUrl(indexHtml: string): string {
  const ids = new Set<string>();
  const $ = load(indexHtml);
  $('a[href*="/pages/"]').each((_, a) => {
    const match = /\/pages\/([A-Za-z0-9]+)/.exec($(a).attr('href') ?? '');
    if (match) ids.add(match[1]);
  });
  if (ids.size !== 1) throw new Error(`The academic policies index links ${ids.size} catalog pages, not one.`);
  return `https://catalog.ramapo.edu/pages/${[...ids][0]}`;
}

/** The index page's text: the statement of who is responsible comes before the list of policies. */
export function indexText(indexHtml: string): string {
  const $ = load(indexHtml);
  $('script, style, nav, header, footer').remove();
  return $('main').text().replace(/\s+/g, ' ').trim() || $('body').text().replace(/\s+/g, ' ').trim();
}

/** Whether a response the index's script received is the catalog page record of pageId. */
export function isCatalogPageRecord(url: string, pageId: string): boolean {
  return new RegExp(`/catalogPages/[^/?#]+/${pageId}(?:[?#]|$)`).test(url);
}

/**
 * The published tabs of the catalog page record: its widgets, never its temporaryWidgets
 * (unpublished edits).
 */
export function publishedPolicies(record: unknown, pageId: string): { policies: CatalogPolicy[]; publishedAt: string | null } {
  if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error(`Catalog page ${pageId} is not a record.`);
  const page = record as Record<string, unknown>;
  if (page.id !== pageId && page.slug !== pageId) throw new Error(`The catalog record is page ${String(page.id)}, not ${pageId}.`);
  if (page.published !== true) throw new Error(`Catalog page ${pageId} is not published.`);
  const policies: CatalogPolicy[] = [];
  for (const widget of Array.isArray(page.widgets) ? page.widgets as Record<string, unknown>[] : []) {
    if (widget?.type !== 'tabs' || !Array.isArray(widget.data)) continue;
    for (const tab of widget.data as Record<string, unknown>[]) {
      const { id, name, anchor, content } = tab ?? {};
      if (typeof name !== 'string' || typeof anchor !== 'string' || typeof content !== 'string') continue;
      policies.push({ id: String(id), name: name.trim(), anchor, html: content });
    }
  }
  if (!policies.length) throw new Error(`Catalog page ${pageId} has no published policy tabs.`);
  const published = page.publishedAt;
  return { policies, publishedAt: typeof published === 'number' ? new Date(published).toISOString() : null };
}

/** Each policy as an office_sections row, cited to its own tab, with its headed sections. */
export function catalogPolicyPages(capture: CatalogPoliciesCapture): OfficeSectionsPage[] {
  const base = capture.page.url.replace(/\/$/, '');
  const seen = new Set<string>();
  const rows: OfficeSectionsPage[] = [];
  for (const policy of capture.policies) {
    if (seen.has(policy.anchor)) throw new Error(`Two catalog policies share the anchor ${policy.anchor}.`);
    seen.add(policy.anchor);
    // The index opens the policy at its anchor; the catalog page's own address no longer does.
    const url = `${capture.index.url}#${policy.anchor}`;
    const parsed = buildRawPageFromHtml({ url: base, html: `<main>${policy.html}</main>`, sourceType: 'seed',
      allowedHost: 'catalog.ramapo.edu' });
    const sections = parsed.sections
      .map(section => ({ heading: section.heading.replace(/\s+/g, ' ').trim(), text: section.text.trim().slice(0, MAX_SECTION_CHARS) }))
      .filter(section => section.text)
      .map(section => (section.heading === policy.name || !section.heading || section.heading === 'Overview'
        ? { ...section, heading: policy.name } : { ...section, heading: `${policy.name}: ${section.heading}` }))
      .slice(0, MAX_PAGE_SECTIONS);
    if (!sections.length) continue;
    const contentHash = createHash('sha256').update(JSON.stringify(sections)).digest('hex');
    rows.push({ key: `catalog.ramapo.edu/pages/${base.split('/').pop()}/#${policy.anchor}`, folder: CATALOG_POLICIES_FOLDER,
      url, fetchedAt: capture.collectedAt, sections, contentHash });
  }
  return rows.sort((a, b) => a.key.localeCompare(b.key));
}

/** The reviewed owner holds only while its quote is on the index page this run captured. */
export function checkCatalogPoliciesOwner(owner: CatalogPoliciesOwner, capture: CatalogPoliciesCapture): CatalogPoliciesOwner {
  if (owner.folder !== CATALOG_POLICIES_FOLDER) throw new Error(`The catalog policies owner names folder ${owner.folder}, not ${CATALOG_POLICIES_FOLDER}.`);
  if (owner.evidence_url !== capture.index.url) throw new Error(`The catalog policies owner cites ${owner.evidence_url}, not the captured index.`);
  if (!folded(capture.index.text).includes(folded(owner.evidence_quote))) {
    throw new Error(`The catalog policies owner's quote is no longer on ${owner.evidence_url}; review src/reference/catalog-policies-owner.json.`);
  }
  return owner;
}
