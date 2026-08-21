import path from 'path';
import { collectRawDataset } from './raw-collector';

const OUTPUT_PATH = path.join(process.cwd(), 'data', 'raw', 'housing.raw.json');
const SEED_URLS = ['https://www.ramapo.edu/reslife/'];

function isHousingDetail(url: URL): boolean {
  return url.host === 'www.ramapo.edu' && /^\/reslife/.test(url.pathname);
}

async function run() {
  console.log('Collecting housing raw dataset...');
  const dataset = await collectRawDataset({
    dataset: 'housing',
    seedUrls: SEED_URLS,
    outputPath: OUTPUT_PATH,
    allowedHost: 'www.ramapo.edu',
    detailUrlFilter: isHousingDetail,
    maxDetailPages: 160,
    minimumPages: 2,
    minimumSuccessfulPages: 2,
    minimumSeedSuccessRate: 1,
    minimumDetailSuccessRate: 0.5,
    minimumPreviousPageRatio: 0.6,
  });

  console.log(
    `Saved ${dataset.pages.length} housing raw pages to ${OUTPUT_PATH} (${dataset.stats.pagesFetched} fetched / ${dataset.stats.pagesFailed} failed)`
  );
}

run().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error('Housing raw collection failed:', message);
  process.exit(1);
});
