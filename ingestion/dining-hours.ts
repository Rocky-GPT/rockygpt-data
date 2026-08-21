import path from 'path';
import { fetchWithPolicy } from './http-client';
import { isRawOnlyMode, runGeneratorScript, writeJsonFile, writeRawProvenance } from './pipeline-utils';
import { validateDiningHoursState } from './schema';

const URL = 'https://ramapo.sodexomyway.com/en-us/locations/hours';
const RAW_JSON_OUTPUT_PATH = path.join(process.cwd(), 'data', 'raw', 'dining-hours.raw.json');
const NORMALIZED_JSON_OUTPUT_PATH = path.join(process.cwd(), 'data', 'normalized', 'dining-hours.json');
const MARKDOWN_GENERATOR_PATH = path.join(__dirname, 'generate-dining-hours-md.ts');

function extractPreloadedState(html: string): unknown {
  const marker = 'window.__PRELOADED_STATE__ =';
  const startIndex = html.indexOf(marker);
  if (startIndex === -1) {
    throw new Error('PRELOADED_STATE marker not found');
  }

  const contentStart = startIndex + marker.length;
  const scriptEndIndex = html.indexOf('</script>', contentStart);
  if (scriptEndIndex === -1) {
    throw new Error('Could not find PRELOADED_STATE script end');
  }

  let potentialJson = html.substring(contentStart, scriptEndIndex).trim();
  if (potentialJson.endsWith(';')) {
    potentialJson = potentialJson.slice(0, -1);
  }
  return JSON.parse(potentialJson);
}

async function fetchDiningHours() {
  console.log('Fetching dining hours from:', URL);
  try {
    const response = await fetchWithPolicy(
      URL,
      { headers: { Accept: 'text/html,application/xhtml+xml' } },
      { expectedContentTypes: ['text/html', 'application/xhtml+xml'] }
    );
    if (!response.ok) {
      throw new Error(`Dining hours page returned HTTP ${response.status}.`);
    }
    const html = response.text();
    const rawState = extractPreloadedState(html);
    writeJsonFile(RAW_JSON_OUTPUT_PATH, rawState);
    writeRawProvenance('dining-hours', { sourceUrl: URL, payload: rawState });
    console.log(`Saved raw dining-hours data to ${RAW_JSON_OUTPUT_PATH}`);

    if (isRawOnlyMode()) {
      console.log('RAW_ONLY enabled: skipping normalization and context generation.');
      return;
    }

    const normalizedState = validateDiningHoursState(rawState);
    writeJsonFile(NORMALIZED_JSON_OUTPUT_PATH, normalizedState);
    console.log(`Saved normalized dining-hours data to ${NORMALIZED_JSON_OUTPUT_PATH}`);

    runGeneratorScript(MARKDOWN_GENERATOR_PATH);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('Error fetching dining data:', message);
    process.exit(1);
  }
}

fetchDiningHours();
