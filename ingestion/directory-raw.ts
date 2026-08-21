import path from 'path';
import { collectRawDataset } from './raw-collector';

const OUTPUT_PATH = path.join(process.cwd(), 'data', 'raw', 'directory.raw.json');
const SEED_URLS = [
  'https://www.ramapo.edu/campus-directory/',
  'https://www.ramapo.edu/about/phone/',
];

function isDirectoryDetail(url: URL): boolean {
  return (
    url.host === 'www.ramapo.edu' &&
    (/^\/campus-directory/.test(url.pathname) ||
      /^\/about\/phone/.test(url.pathname) ||
      /directory/i.test(url.pathname))
  );
}

async function run() {
  console.log('Collecting directory raw dataset...');
  const dataset = await collectRawDataset({
    dataset: 'directory',
    seedUrls: SEED_URLS,
    outputPath: OUTPUT_PATH,
    allowedHost: 'www.ramapo.edu',
    detailUrlFilter: isDirectoryDetail,
    maxDetailPages: 120,
    minimumPages: 2,
    minimumSuccessfulPages: 2,
    minimumSeedSuccessRate: 0.75,
    minimumPreviousPageRatio: 0.6,
  });

  console.log(
    `Saved ${dataset.pages.length} directory raw pages to ${OUTPUT_PATH} (${dataset.stats.pagesFetched} fetched / ${dataset.stats.pagesFailed} failed)`
  );
}

run().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error('Directory raw collection failed:', message);
  process.exit(1);
});
