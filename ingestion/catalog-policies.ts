/**
 * catalog-policies.ts
 *
 * The college's academic policies from the course catalog (src/data-v2/catalog-policies.ts): the
 * academic policies index the Provost's own policy addresses redirect to, read once with the
 * browser user agent every Ramapo collector uses, then opened once in a browser, which receives
 * the record of the one catalog page the index links (its published policy tabs). The index's
 * HTML and that record are kept beside the parsed policies.
 *
 * Run: npm run fetch:catalog-policies
 */
import { createHash } from 'node:crypto';
import path from 'node:path';
import { chromium } from 'playwright';
import { DEFAULT_USER_AGENT, fetchWithPolicy } from './http-client';
import { assertSiteFetchAllowed, paceRamapoRequest } from './site-guard';
import { writeJsonFile, writeRawFileProvenance } from './pipeline-utils';
import { CATALOG_POLICIES_INDEX, indexText, isCatalogPageRecord, policiesPageUrl, publishedPolicies,
  type CatalogPoliciesCapture } from '../src/data-v2/catalog-policies';

const RAW_DIR = path.join(process.cwd(), 'data', 'raw');

async function get(url: string): Promise<{ url: string; html: string; fetchedAt: string }> {
  const response = await fetchWithPolicy(url, { headers: { 'User-Agent': DEFAULT_USER_AGENT, Accept: 'text/html' } });
  if (!response.ok) throw new Error(`${url} answered ${response.status}.`);
  return { url: response.url || url, html: response.text(), fetchedAt: new Date().toISOString() };
}

/** How long the index's script gets to ask for the catalog page once the index is open. */
const RECORD_TIMEOUT_MS = 30_000;

/** The catalog page record the index's own script receives when a browser opens the index. */
async function pageRecord(pageId: string): Promise<{ record: unknown; text: string; fetchedAt: string }> {
  assertSiteFetchAllowed(CATALOG_POLICIES_INDEX);
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ userAgent: DEFAULT_USER_AGENT });
    const received = page.waitForResponse(response => isCatalogPageRecord(response.url(), pageId)
      && response.status() === 200, { timeout: RECORD_TIMEOUT_MS });
    await paceRamapoRequest(CATALOG_POLICIES_INDEX);
    await page.goto(CATALOG_POLICIES_INDEX, { waitUntil: 'domcontentloaded', timeout: RECORD_TIMEOUT_MS });
    const response = await received;
    const text = await response.text();
    return { record: JSON.parse(text), text, fetchedAt: new Date().toISOString() };
  } finally {
    await browser.close();
  }
}

async function main(): Promise<void> {
  const index = await get(CATALOG_POLICIES_INDEX);
  const pageUrl = policiesPageUrl(index.html);
  const pageId = pageUrl.split('/').pop()!;
  const page = await pageRecord(pageId);
  const { policies, publishedAt } = publishedPolicies(page.record, pageId);
  const capture: CatalogPoliciesCapture = { dataset: 'catalog-policies', collectedAt: page.fetchedAt,
    index: { url: CATALOG_POLICIES_INDEX, text: indexText(index.html) }, page: { url: pageUrl, publishedAt }, policies };
  const sources = { schemaVersion: 1, dataset: 'catalog-policies', generatedAt: page.fetchedAt, collectionSucceeded: true,
    pages: [index, { url: pageUrl, html: page.text, fetchedAt: page.fetchedAt }]
      .map(source => ({ ...source, contentHash: createHash('sha256').update(source.html).digest('hex') })) };
  writeJsonFile(path.join(RAW_DIR, 'catalog-policies-sources.raw.json'), sources);
  writeJsonFile(path.join(RAW_DIR, 'catalog-policies.raw.json'), capture);
  writeRawFileProvenance('catalog-policies', path.join(RAW_DIR, 'catalog-policies.raw.json'),
    { sourceUrl: CATALOG_POLICIES_INDEX, recordCount: policies.length, fetchedAt: page.fetchedAt });
  writeRawFileProvenance('catalog-policies-sources', path.join(RAW_DIR, 'catalog-policies-sources.raw.json'),
    { sourceUrl: pageUrl, recordCount: 2, fetchedAt: page.fetchedAt });
  console.log(`Saved ${policies.length} published academic policies from ${pageUrl} (published ${publishedAt ?? 'unknown'}).`);
}

if (process.argv[1]?.endsWith('catalog-policies.ts')) {
  main().catch(error => { console.error('Fatal:', error); process.exitCode = 1; });
}
