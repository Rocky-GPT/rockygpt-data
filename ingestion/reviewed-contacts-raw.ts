/** Capture only the reviewed contact evidence pages, without crawling their sites. */
import path from 'node:path';
import { OFFICE_DIRECTORY_CONTACTS, OTHER_DIRECTORY_CONTACTS } from '../src/directory/static-contacts';
import { collectRawDataset } from './raw-collector';

export const REVIEWED_CONTACT_URLS = [...new Set([
  // Retain the provider page in the college -> clinic -> scheduling referral chain.
  'https://www.valleyhealth.com/ramapo-college-health-services',
  ...OFFICE_DIRECTORY_CONTACTS.flatMap(entry => [
    ...entry.evidence.map(item => item.url),
    ...(entry.notPublished ?? []).flatMap(item => item.evidence.map(ref => ref.url)),
    ...(entry.additionalContacts ?? []).flatMap(item => item.evidence.map(ref => ref.url)),
    ...(entry.contactConflicts ?? []).flatMap(item => item.evidence.map(ref => ref.url)),
    ...(entry.contactReviewExclusions ?? []).map(item => item.evidence.url),
    ...(entry.contactNotes ?? []).map(item => item.evidence.url),
    ...(entry.website ? [entry.website] : []),
    ...(entry.websiteEvidence ? [entry.websiteEvidence.url] : []),
  ]),
  ...OTHER_DIRECTORY_CONTACTS.flatMap(entry => [
    ...entry.evidence.map(item => item.url),
    ...(entry.notPublished ?? []).flatMap(item => item.evidence.map(ref => ref.url)),
  ]),
])].filter(url => !/\.pdf$/i.test(new URL(url).pathname)).sort();

async function run() {
  await collectRawDataset({
    dataset: 'reviewed-contacts',
    seedUrls: REVIEWED_CONTACT_URLS,
    outputPath: path.join(process.cwd(), 'data/raw/reviewed-contacts.raw.json'),
    allowedHosts: ['www.ramapo.edu', 'ramapo.edu', 'catalog.ramapo.edu', 'apply.ramapo.edu', 'archway.ramapo.edu', 'ramapoathletics.com', 'www.ramapoathletics.com', 'www.valleyhealth.com'],
    maxDetailPages: 0,
    minimumPages: REVIEWED_CONTACT_URLS.length,
    minimumSuccessfulPages: REVIEWED_CONTACT_URLS.length,
    minimumSeedSuccessRate: 1,
    minimumPreviousPageRatio: 0,
    retainSourceHtml: true,
    compressSourceHtml: true,
    requestIntervalMs: 150,
  });
  console.log(`Captured ${REVIEWED_CONTACT_URLS.length} reviewed contact source pages.`);
}

if (process.argv[1]?.endsWith('reviewed-contacts-raw.ts')) run().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
