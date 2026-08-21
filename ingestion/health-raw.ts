import path from 'path';
import { collectRawDataset } from './raw-collector';

const OUTPUT_PATH = path.join(process.cwd(), 'data', 'raw', 'health.raw.json');
const SEED_URLS = [
  'https://www.ramapo.edu/health/',
  'https://www.valleyhealth.com/ramapo-college-health-services',
];
const ALLOWED_HOSTS = ['www.ramapo.edu', 'www.valleyhealth.com'];

function isHealthDetail(url: URL): boolean {
  return (
    url.host === 'www.valleyhealth.com' &&
    url.pathname === '/save-your-spot-ramapo-college-health-services'
  );
}

async function run() {
  console.log('Collecting health raw dataset...');
  const dataset = await collectRawDataset({
    dataset: 'health',
    seedUrls: SEED_URLS,
    outputPath: OUTPUT_PATH,
    allowedHosts: ALLOWED_HOSTS,
    detailUrlFilter: isHealthDetail,
    maxDetailPages: 1,
    minimumPages: 2,
    minimumSuccessfulPages: 2,
    minimumSeedSuccessRate: 1,
    minimumPreviousPageRatio: 0.5,
  });

  console.log(
    `Saved ${dataset.pages.length} health raw pages to ${OUTPUT_PATH} (${dataset.stats.pagesFetched} fetched / ${dataset.stats.pagesFailed} failed)`
  );
}

run().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error('Health raw collection failed:', message);
  process.exit(1);
});
