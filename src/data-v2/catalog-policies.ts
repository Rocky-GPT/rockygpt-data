/**
 * The college's academic policies, as the course catalog publishes them. The Provost's own policy
 * addresses on www.ramapo.edu (/provost/policy/used-name/) redirect to the catalog's academic
 * policies page, which says the Office of the Provost is responsible for every academic policy and
 * links one catalog page holding all of them as tabs. That page is a Coursedog app: its published
 * tabs are in the page's own data (__NUXT_DATA__), each with a name, an anchor and its HTML. Each
 * policy is one office_sections row (folder CATALOG_POLICIES_FOLDER) with its headed sections, cited
 * to its own tab on the catalog page; the identity compile links them to the reviewed owner.
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

/**
 * The published tabs of the catalog page: its widgets, never its temporaryWidgets (unpublished
 * edits). Nuxt's payload is a flat array whose objects point at other entries by index.
 */
export function publishedPolicies(pageHtml: string, slug: string): { policies: CatalogPolicy[]; publishedAt: string | null } {
  const raw = /<script type="application\/json"[^>]*id="__NUXT_DATA__"[^>]*>([\s\S]*?)<\/script>/.exec(pageHtml)?.[1];
  if (!raw) throw new Error('The catalog page has no __NUXT_DATA__ payload.');
  const payload = JSON.parse(raw) as unknown[];
  const at = (index: unknown): unknown => (typeof index === 'number' ? payload[index] : index);
  const page = payload.find((entry): entry is Record<string, number> =>
    !!entry && typeof entry === 'object' && !Array.isArray(entry) && 'widgets' in entry && 'temporaryWidgets' in entry
    && at((entry as Record<string, unknown>).slug) === slug);
  if (!page) throw new Error(`The catalog payload has no page ${slug}.`);
  if (at(page.published) !== true) throw new Error(`Catalog page ${slug} is not published.`);
  const policies: CatalogPolicy[] = [];
  for (const widgetIndex of at(page.widgets) as number[]) {
    const widget = at(widgetIndex) as Record<string, number>;
    if (at(widget.type) !== 'tabs') continue;
    for (const tabIndex of at(widget.data) as number[]) {
      const tab = at(tabIndex) as Record<string, number>;
      const [id, name, anchor, html] = [at(tab.id), at(tab.name), at(tab.anchor), at(tab.content)];
      if (typeof name !== 'string' || typeof anchor !== 'string' || typeof html !== 'string') continue;
      policies.push({ id: String(id), name: name.trim(), anchor, html });
    }
  }
  if (!policies.length) throw new Error(`Catalog page ${slug} has no published policy tabs.`);
  const published = at(page.publishedAt);
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
    const url = `${base}#${policy.anchor}`;
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
