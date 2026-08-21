import path from 'path';
import { collectRawDataset } from './raw-collector';

const OUTPUT_PATH = path.join(process.cwd(), 'data', 'raw', 'safety.raw.json');
const SEED_URLS = ['https://www.ramapo.edu/publicsafety/'];

function isSafetyDetail(url: URL): boolean {
  if (url.host !== 'www.ramapo.edu') {
    return false;
  }

  const pathLower = url.pathname.toLowerCase();
  return (
    pathLower.startsWith('/publicsafety') ||
    pathLower.includes('safety') ||
    pathLower.includes('security') ||
    pathLower.includes('emergency') ||
    pathLower.includes('title-ix')
  );
}

async function run() {
  console.log('Collecting safety raw dataset...');
  const dataset = await collectRawDataset({
    dataset: 'safety',
    seedUrls: SEED_URLS,
    outputPath: OUTPUT_PATH,
    allowedHost: 'www.ramapo.edu',
    detailUrlFilter: isSafetyDetail,
    maxDetailPages: 160,
    minimumPages: 2,
    minimumSuccessfulPages: 2,
    minimumSeedSuccessRate: 1,
    minimumDetailSuccessRate: 0.5,
    minimumPreviousPageRatio: 0.6,
  });

  console.log(
    `Saved ${dataset.pages.length} safety raw pages to ${OUTPUT_PATH} (${dataset.stats.pagesFetched} fetched / ${dataset.stats.pagesFailed} failed)`
  );
}

run().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error('Safety raw collection failed:', message);
  process.exit(1);
});
