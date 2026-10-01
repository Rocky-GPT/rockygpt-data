/** Capture every page cited by the reviewed directory into a new local folder. */
import fs from 'node:fs';
import path from 'node:path';
import { collectRawDataset } from '../../ingestion/raw-collector';
import { OFFICE_DIRECTORY_CONTACTS, OTHER_DIRECTORY_CONTACTS } from '../../src/directory/static-contacts';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--out-directory') {
    throw new Error('Use --out-directory with a new local directory.');
  }
  const directory = path.resolve(args[1]);
  const urls = [...new Set([...OFFICE_DIRECTORY_CONTACTS, ...OTHER_DIRECTORY_CONTACTS]
    .flatMap(entry => entry.evidence.map(evidence => evidence.url)))];
  const allowedHosts = ['www.ramapo.edu', 'www.valleyhealth.com'];
  if (!urls.length || urls.length > 200 || urls.some(value => {
    const url = new URL(value);
    return url.protocol !== 'https:' || !allowedHosts.includes(url.host) || url.username || url.password;
  })) throw new Error('Review the directory evidence URL set before capturing.');
  // Fail if the destination exists; earlier evidence must remain intact.
  fs.mkdirSync(directory, { mode: 0o700 });
  const captured = await collectRawDataset({
    dataset: 'office-contact-evidence', seedUrls: urls,
    outputPath: path.join(directory, 'office-contact-evidence.raw.json'),
    allowedHosts, maxDetailPages: 0, requestIntervalMs: 1000, timeoutMs: 15000, attempts: 2,
    retainSourceHtml: true, compressSourceHtml: true,
    minimumPages: urls.length, minimumSuccessfulPages: urls.length, minimumSeedSuccessRate: 1,
  });
  console.log(JSON.stringify({ directory, requestedPages: urls.length,
    capturedPages: captured.pages.length, failedPages: captured.stats.pagesFailed,
    databaseChanged: false }));
}

void main().catch(error => {
  console.error('Office evidence capture failed; existing captures and databases are unchanged.',
    error instanceof Error ? error.name : 'UnknownError');
  process.exitCode = 1;
});
