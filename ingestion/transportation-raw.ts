import path from 'path';
import { collectRawDataset } from './raw-collector';

const OUTPUT_PATH = path.join(process.cwd(), 'data', 'raw', 'transportation.raw.json');
const SEED_URLS = [
  'https://www.ramapo.edu/csi/commuter-affairs/',
  'https://www.ramapo.edu/csi/commuter-affairs/commuter-resources/',
  'https://www.ramapo.edu/about/transportation-services/',
];

function isTransportationDetail(url: URL): boolean {
  return (
    url.host === 'www.ramapo.edu' &&
    (/^\/csi\/transportation/.test(url.pathname) ||
      /^\/csi\/shuttles/.test(url.pathname) ||
      /^\/csi\/commuter/.test(url.pathname) ||
      /^\/about\/transportation/.test(url.pathname) ||
      /^\/about\/shuttlebus/.test(url.pathname))
  );
}

async function run() {
  console.log('Collecting transportation raw dataset...');
  const dataset = await collectRawDataset({
    dataset: 'transportation',
    seedUrls: SEED_URLS,
    outputPath: OUTPUT_PATH,
    allowedHost: 'www.ramapo.edu',
    detailUrlFilter: isTransportationDetail,
    maxDetailPages: 120,
    minimumPages: 4,
    minimumSuccessfulPages: 3,
    minimumSeedSuccessRate: 0.75,
    minimumDetailSuccessRate: 0.5,
    minimumPreviousPageRatio: 0.6,
  });

  console.log(
    `Saved ${dataset.pages.length} transportation raw pages to ${OUTPUT_PATH} (${dataset.stats.pagesFetched} fetched / ${dataset.stats.pagesFailed} failed)`
  );
}

run().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error('Transportation raw collection failed:', message);
  process.exit(1);
});
