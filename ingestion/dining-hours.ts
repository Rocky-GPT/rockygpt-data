import path from 'path';
import { fetchWithPolicy } from './http-client';
import { isRawOnlyMode, runGeneratorScript, writeJsonFile, writeRawProvenance } from './pipeline-utils';
import { validateDiningHoursState } from './schema';
import { chromium } from 'playwright';
import { applyRenderedClosures, captureRenderedDiningHours, type RenderedDiningHours } from './dining-rendered';

const URL = 'https://ramapo.sodexomyway.com/en-us/locations/hours';
const RAW_JSON_OUTPUT_PATH = path.join(process.cwd(), 'data', 'raw', 'dining-hours.raw.json');
const RENDERED_JSON_OUTPUT_PATH = path.join(process.cwd(), 'data', 'raw', 'dining-hours-rendered.raw.json');
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

const RENDER_TRIES = 2;

/**
 * The page as a browser renders it: the only source of a "Closed" the data leaves blank. It adds to
 * the hours and never replaces them, so when the page cannot be rendered the hours are still saved,
 * a blank day stays unknown, and the run says so. It must not cost the night its dining data.
 */
async function renderHours(): Promise<RenderedDiningHours | null> {
  for (let attempt = 1; attempt <= RENDER_TRIES; attempt++) {
    try {
      // Playwright's own Chromium when installed; otherwise the machine's Google Chrome (no download).
      const browser = await chromium.launch({ headless: true })
        .catch(() => chromium.launch({ headless: true, channel: 'chrome' }));
      return await captureRenderedDiningHours(browser, URL).finally(() => browser.close());
    } catch (error: unknown) {
      const reason = (error instanceof Error ? error.message : String(error)).split('\n')[0];
      console.log(`::warning::Dining hours: the page could not be rendered (try ${attempt} of ${RENDER_TRIES}): ${reason}`);
    }
  }
  console.log('::warning::Dining hours: saved without the rendered page, so a day the data leaves blank stays unknown instead of Closed.');
  return null;
}

/** What the rendered page did and did not show, for the run's log. */
function renderedNotes(rendered: RenderedDiningHours): string[] {
  const { opened = 0, hidden = 0, stuck = 0 } = rendered.moreHours ?? {};
  const notes = [`Rendered page: ${rendered.venues.length} venue(s); "More hours" buttons: ${opened} opened, ${hidden} hidden and left alone, ${stuck} would not open.`];
  const bare = rendered.venues.filter((venue) => !venue.regular.length).map((venue) => venue.name);
  if (!rendered.venues.length || bare.length) {
    notes.push(`::warning::Dining hours: the rendered page shows no regular hours for ${bare.join(', ') || 'any venue'}; a day the data leaves blank there stays unknown instead of Closed.`);
  }
  return notes;
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
    const rendered = await renderHours();
    if (rendered) {
      writeJsonFile(RENDERED_JSON_OUTPUT_PATH, rendered);
      writeRawProvenance('dining-hours-rendered', { sourceUrl: URL, payload: rendered });
      for (const line of renderedNotes(rendered)) console.log(line);
    }

    if (isRawOnlyMode()) {
      console.log('RAW_ONLY enabled: skipping normalization and context generation.');
      return;
    }

    const normalizedState = validateDiningHoursState(rawState);
    for (const marked of rendered ? applyRenderedClosures(normalizedState as unknown as Record<string, unknown>, rendered) : []) {
      console.log(`Closed as the rendered page prints it: ${marked}`);
    }
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
