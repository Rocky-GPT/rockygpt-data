import path from 'path';
import fs from 'fs';
import { fetchWithPolicy } from './http-client';
import { isRawOnlyMode, runGeneratorScript, writeJsonFile, writeRawProvenance } from './pipeline-utils';
import { validateMenuData } from './schema';

const API_URL = 'https://api-prd.sodexomyway.net/v0.2/data/menu/97508001/15858';
const API_KEY = '68717828-b754-420d-9488-4c37cb7d7ef7';
const RAW_JSON_OUTPUT_PATH = path.join(process.cwd(), 'data', 'raw', 'menu.raw.json');
const RAW_WEEK_JSON_OUTPUT_PATH = path.join(process.cwd(), 'data', 'raw', 'menu-week.raw.json');
const NORMALIZED_JSON_OUTPUT_PATH = path.join(process.cwd(), 'data', 'normalized', 'menu.json');
const NORMALIZED_WEEK_JSON_OUTPUT_PATH = path.join(
  process.cwd(),
  'data',
  'normalized',
  'menu-week.json'
);
const MENU_MD_OUTPUT_PATH = path.join(process.cwd(), 'data', 'context', 'dining', 'menu.md');
const MARKDOWN_GENERATOR_PATH = path.join(__dirname, 'generate-menu-md.ts');

function easternDateKey(offsetDays = 0): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const year = Number(parts.find((part) => part.type === 'year')?.value);
  const month = Number(parts.find((part) => part.type === 'month')?.value);
  const day = Number(parts.find((part) => part.type === 'day')?.value);
  const shifted = new Date(Date.UTC(year, month - 1, day + offsetDays));
  return shifted.toISOString().slice(0, 10);
}

async function fetchMenuDate(date: string): Promise<unknown> {
  const response = await fetchWithPolicy(
    `${API_URL}?date=${date}`,
    {
      headers: {
        'API-Key': API_KEY,
        Accept: 'application/json',
      },
    },
    {
      expectedContentTypes: ['application/json'],
      maxResponseBytes: 8 * 1024 * 1024,
    }
  );
  if (!response.ok) {
    throw new Error(`Dining menu API returned HTTP ${response.status}.`);
  }
  return response.json();
}

async function fetchBirchMenu() {
  const dates = Array.from({ length: 7 }, (_, offset) => easternDateKey(offset));
  console.log(`Fetching published menus for ${dates[0]} through ${dates.at(-1)}.`);

  try {
    const collectedAt = new Date().toISOString();
    const rawDates: Array<{ date: string; sections: unknown }> = [];
    for (const [index, date] of dates.entries()) {
      try {
        rawDates.push({ date, sections: await fetchMenuDate(date) });
      } catch (error) {
        if (index === 0) throw error;
        console.warn(`Menu was unavailable for ${date}; recording an empty future-day snapshot.`);
        rawDates.push({ date, sections: [] });
      }
    }
    const rawMenuData = rawDates[0].sections;
    const rawWeek = { version: 1, collectedAt, dates: rawDates };
    writeJsonFile(RAW_JSON_OUTPUT_PATH, rawMenuData);
    writeJsonFile(RAW_WEEK_JSON_OUTPUT_PATH, rawWeek);
    writeRawProvenance('menu', { sourceUrl: API_URL, payload: rawMenuData });
    writeRawProvenance('menu-week', {
      sourceUrl: API_URL,
      recordCount: rawDates.length,
      payload: rawWeek,
    });
    console.log(`Saved current and seven-day raw menu snapshots.`);

    if (isRawOnlyMode()) {
      console.log('RAW_ONLY enabled: skipping normalization and context generation.');
      return;
    }

    const normalizedDates = rawDates.map(({ date, sections }) => {
      try {
        return { date, sections: validateMenuData(sections) };
      } catch {
        return { date, sections: [] };
      }
    });
    writeJsonFile(NORMALIZED_WEEK_JSON_OUTPUT_PATH, {
      version: 1,
      collectedAt,
      dates: normalizedDates,
    });

    const normalizedMenuData = normalizedDates[0].sections;
    try {
      validateMenuData(normalizedMenuData);
    } catch {
      console.warn('No menu items available for today — writing empty-menu placeholder.');
      const now = new Date().toISOString();
      const placeholder = `# Birch Tree Inn Menu\n\n*Generated (UTC): ${now}*\n\n---\n\nNo menu is available for today. The dining hall may be closed or the menu has not been published yet.\n\nCheck back later or visit the Ramapo dining page for updates.\n`;
      fs.mkdirSync(path.dirname(MENU_MD_OUTPUT_PATH), { recursive: true });
      fs.writeFileSync(MENU_MD_OUTPUT_PATH, placeholder, 'utf-8');
      writeJsonFile(NORMALIZED_JSON_OUTPUT_PATH, []);
      console.log(`Wrote empty-menu placeholder to ${MENU_MD_OUTPUT_PATH}`);
      return;
    }

    writeJsonFile(NORMALIZED_JSON_OUTPUT_PATH, normalizedMenuData);
    console.log(`Saved normalized menu data to ${NORMALIZED_JSON_OUTPUT_PATH}`);

    runGeneratorScript(MARKDOWN_GENERATOR_PATH);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('Error fetching menu:', message);
    process.exit(1);
  }
}

fetchBirchMenu();
