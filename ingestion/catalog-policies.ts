/**
 * catalog-policies.ts
 *
 * The college's academic policies from the course catalog (src/data-v2/catalog-policies.ts): the
 * academic policies index the Provost's own policy addresses redirect to, and the one catalog page
 * it links, read for its published policy tabs. Two requests, a second apart, with the browser
 * user agent every Ramapo collector uses. Both pages' HTML is kept beside the parsed policies.
 *
 * Run: npm run fetch:catalog-policies
 */
import { createHash } from 'node:crypto';
import path from 'node:path';
import { DEFAULT_USER_AGENT, fetchWithPolicy } from './http-client';
import { writeJsonFile, writeRawFileProvenance } from './pipeline-utils';
import { CATALOG_POLICIES_INDEX, indexText, policiesPageUrl, publishedPolicies,
  type CatalogPoliciesCapture } from '../src/data-v2/catalog-policies';

const RAW_DIR = path.join(process.cwd(), 'data', 'raw');

async function get(url: string): Promise<{ url: string; html: string; fetchedAt: string }> {
  const response = await fetchWithPolicy(url, { headers: { 'User-Agent': DEFAULT_USER_AGENT, Accept: 'text/html' } });
  if (!response.ok) throw new Error(`${url} answered ${response.status}.`);
  return { url: response.url || url, html: response.text(), fetchedAt: new Date().toISOString() };
}

async function main(): Promise<void> {
  const index = await get(CATALOG_POLICIES_INDEX);
  const pageUrl = policiesPageUrl(index.html);
  await new Promise(resolve => setTimeout(resolve, 1000));
  const page = await get(pageUrl);
  const { policies, publishedAt } = publishedPolicies(page.html, pageUrl.split('/').pop()!);
  const capture: CatalogPoliciesCapture = { dataset: 'catalog-policies', collectedAt: page.fetchedAt,
    index: { url: CATALOG_POLICIES_INDEX, text: indexText(index.html) }, page: { url: pageUrl, publishedAt }, policies };
  const sources = { schemaVersion: 1, dataset: 'catalog-policies', generatedAt: page.fetchedAt, collectionSucceeded: true,
    pages: [index, page].map(source => ({ ...source, contentHash: createHash('sha256').update(source.html).digest('hex') })) };
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
