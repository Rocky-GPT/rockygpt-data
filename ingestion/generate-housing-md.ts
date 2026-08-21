import fs from 'fs';
import path from 'path';
import { generateCore6Markdown } from './generate-core6-md-utils';

const DATA_DIR = path.join(process.cwd(), 'data', 'normalized');
const OUTPUT_DIR = path.join(process.cwd(), 'data', 'context', 'campus');
const INPUT_FILE_PATH = path.join(DATA_DIR, 'housing.json');
const OUTPUT_FILE_PATH = path.join(OUTPUT_DIR, 'housing.md');

type HousingPage = {
  title?: string;
  url?: string;
  sourceType?: string;
};

type HousingDataset = {
  pages?: HousingPage[];
};

const MEAL_PLAN_PATTERNS = [
  /students who wish to change their meal plan/i,
  /last day to add, drop, or change (your )?meal plan/i,
  /block plan or flex plan/i,
  /mealplan@ramapo\.edu/i,
  /meal plan choice/i,
  /drop their meal plan/i,
];

function normalizeText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function collectMatchingStrings(node: unknown, output: string[]): void {
  if (typeof node === 'string') {
    const normalized = normalizeText(node);
    if (normalized && MEAL_PLAN_PATTERNS.some((pattern) => pattern.test(normalized))) {
      output.push(normalized);
    }
    return;
  }

  if (Array.isArray(node)) {
    node.forEach((entry) => collectMatchingStrings(entry, output));
    return;
  }

  if (node && typeof node === 'object') {
    Object.values(node).forEach((value) => collectMatchingStrings(value, output));
  }
}

function findPage(dataset: HousingDataset, titleFragment: string): HousingPage | null {
  return dataset.pages?.find((page) => page.title?.includes(titleFragment)) ?? null;
}

function pickMealPlanHighlights(dataset: HousingDataset): string[] {
  const matches: string[] = [];
  collectMatchingStrings(dataset, matches);

  const prioritized = matches.filter((entry) =>
    /change their meal plan|add, drop, or change|block plan or flex plan|mealplan@ramapo\.edu|meal plan choice|drop their meal plan/i.test(
      entry
    )
  );

  const deduped: string[] = [];
  const seen = new Set<string>();
  for (const entry of prioritized) {
    if (entry.length < 40) continue;
    const key = entry.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(entry);
  }

  return deduped.slice(0, 6);
}

function appendMealPlanContext(outputPath: string, dataset: HousingDataset): void {
  const existing = fs.readFileSync(outputPath, 'utf-8').trimEnd();
  const roomChangePage = findPage(dataset, 'Room Change Process');
  const winterPage = findPage(dataset, 'Fall Check-out & Winter Housing Information');
  const mealPlanHighlights = pickMealPlanHighlights(dataset);

  if (mealPlanHighlights.length === 0) {
    fs.writeFileSync(outputPath, `${existing}\n`, 'utf-8');
    return;
  }

  const derivedSection = [
    existing,
    '',
    '## Meal Plan Updates & Requests - Residence Life',
    '',
    `- URL: ${roomChangePage?.url || winterPage?.url || 'https://www.ramapo.edu/reslife/'}`,
    `- Source Type: ${roomChangePage?.sourceType || winterPage?.sourceType || 'derived'}`,
    '- Status: 200',
    '',
    '### Key Details',
    '',
    ...mealPlanHighlights.map((entry, index) => {
      if (index === 0) return `- **Meal Plan Change Instructions:** ${entry}`;
      if (index === 1) return `- **Meal Plan Request Details:** ${entry}`;
      if (index === 2) return `- **Block And Flex Plan Requests:** ${entry}`;
      if (index === 3) return `- **Meal Plan Contact:** ${entry}`;
      if (index === 4) return `- **Required Request Information:** ${entry}`;
      return `- **Related Meal Plan Policy:** ${entry}`;
    }),
    '',
    '### Contacts',
    '',
    '- mealplan@ramapo.edu | Email: mealplan@ramapo.edu',
    '- reslife@ramapo.edu | Email: reslife@ramapo.edu | Office: Office of Residence Life',
    '',
    '---',
    '',
  ].join('\n');

  fs.writeFileSync(outputPath, `${derivedSection}`, 'utf-8');
}

generateCore6Markdown({
  datasetName: 'housing',
  title: 'Ramapo Housing and Residence Life',
  description:
    'Context extracted from Residence Life pages. Includes housing policies, residence resources, operational details, and support contacts.',
  inputFilePath: INPUT_FILE_PATH,
  outputFilePath: OUTPUT_FILE_PATH,
  frontmatter: {
    source_url: 'https://www.ramapo.edu/reslife/',
    title: 'Housing and Residence Life',
    trust_tier: 'official_primary',
    freshness_sla_hours: 168,
  },
});

const housingDataset = JSON.parse(fs.readFileSync(INPUT_FILE_PATH, 'utf-8')) as HousingDataset;
appendMealPlanContext(OUTPUT_FILE_PATH, housingDataset);
