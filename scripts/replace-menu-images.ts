import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import dotenv from 'dotenv';
import { dataRootPath, publicPath } from '../src/paths';

dotenv.config({ path: dataRootPath('.env'), quiet: true });

const MENU_PATH = path.join(process.cwd(), 'data', 'context', 'dining', 'menu.md');
const IMAGES_DIR = publicPath('images', 'menu');
const PLACEHOLDER_PATH = path.join(IMAGES_DIR, 'placeholder.jpg');
const ATTRIBUTION_PATH = path.join(IMAGES_DIR, 'attribution.json');

type ProviderMode = 'auto' | 'pexels' | 'pixabay' | 'openverse';

type RealProvider = 'pexels' | 'pixabay' | 'openverse';

interface CliOptions {
  dryRun: boolean;
  all: boolean;
  limit: number;
  provider: ProviderMode;
  itemNames: string[];
  placeholderOnly: boolean;
}

interface TargetItem {
  itemName: string;
  fileName: string;
  filePath: string;
}

interface ImageCandidate {
  provider: RealProvider;
  downloadUrl: string;
  sourceUrl: string;
  photographer?: string;
  photographerUrl?: string;
  license: string;
  query: string;
  relevanceScore: number;
}

interface AttributionEntry {
  itemName: string;
  fileName: string;
  provider: RealProvider;
  sourceUrl: string;
  imageUrl: string;
  photographer?: string;
  photographerUrl?: string;
  query: string;
  license: string;
  downloadedAt: string;
}

interface AttributionFile {
  generatedAt: string;
  items: Record<string, AttributionEntry>;
}

interface PexelsSearchResponse {
  photos?: Array<{
    id: number;
    width: number;
    height: number;
    url: string;
    photographer: string;
    photographer_url?: string;
    alt?: string;
    src: {
      original?: string;
      large2x?: string;
      large?: string;
      medium?: string;
      small?: string;
      portrait?: string;
      landscape?: string;
      tiny?: string;
    };
  }>;
}

interface PixabaySearchResponse {
  hits?: Array<{
    id: number;
    pageURL: string;
    tags?: string;
    largeImageURL?: string;
    webformatURL?: string;
    user?: string;
    user_id?: number;
    imageWidth?: number;
    imageHeight?: number;
  }>;
}

interface OpenverseSearchResponse {
  results?: Array<{
    title?: string;
    tags?: Array<{ name?: string }>;
    url?: string;
    foreign_landing_url?: string;
    creator?: string;
    creator_url?: string;
    license?: string;
    license_version?: string;
    license_url?: string;
    width?: number;
    height?: number;
  }>;
}

function printUsage(): void {
  console.log(`\nReplace placeholder menu images with real stock photos.\n\nUsage:\n  npm run images:menu:stock -- [options]\n\nOptions:\n  --limit <n>                 Max items to process (default: 5)\n  --all                       Process all eligible items\n  --items "A,B,C"             Only process these item names\n  --provider <auto|pexels|pixabay|openverse>  Source provider (default: auto)\n  --include-non-placeholder   Replace files even if not placeholder-backed\n  --dry-run                   Preview matches without downloading\n  --help                      Show this help\n\nEnv keys:\n  PEXELS_API_KEY (recommended)\n  PIXABAY_API_KEY (optional fallback)\n`);
}

function parseCliOptions(): CliOptions {
  const args = process.argv.slice(2);
  const options: CliOptions = {
    dryRun: false,
    all: false,
    limit: 5,
    provider: 'auto',
    itemNames: [],
    placeholderOnly: true,
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];

    if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(0);
    }

    if (arg === '--dry-run') {
      options.dryRun = true;
      continue;
    }

    if (arg === '--all') {
      options.all = true;
      continue;
    }

    if (arg === '--include-non-placeholder') {
      options.placeholderOnly = false;
      continue;
    }

    if (arg === '--limit') {
      const raw = args[i + 1];
      i += 1;
      const parsed = Number.parseInt(raw ?? '', 10);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error(`Invalid --limit value: ${raw}`);
      }
      options.limit = parsed;
      continue;
    }

    if (arg === '--provider') {
      const raw = (args[i + 1] ?? '').toLowerCase();
      i += 1;
      if (raw !== 'auto' && raw !== 'pexels' && raw !== 'pixabay' && raw !== 'openverse') {
        throw new Error(`Invalid --provider value: ${raw}`);
      }
      options.provider = raw;
      continue;
    }

    if (arg === '--items') {
      const raw = args[i + 1] ?? '';
      i += 1;
      options.itemNames = raw
        .split(',')
        .map((part) => part.trim())
        .filter((part) => part.length > 0);
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function hashFile(filePath: string): string {
  const buffer = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function readMenuItemNames(markdownPath: string): string[] {
  if (!fs.existsSync(markdownPath)) {
    throw new Error(`Menu file not found: ${markdownPath}`);
  }

  const content = fs.readFileSync(markdownPath, 'utf-8');
  const names: string[] = [];
  const seen = new Set<string>();

  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line.startsWith('- **')) continue;

    const match = line.match(/\*\*(.*?)\*\*/);
    const itemName = match?.[1]?.trim();
    if (!itemName) continue;

    const key = itemName.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(itemName);
  }

  return names;
}

function buildTargets(menuItemNames: string[], options: CliOptions, placeholderHash: string): TargetItem[] {
  const requested =
    options.itemNames.length > 0
      ? options.itemNames
      : menuItemNames;

  const deduped = new Set<string>();
  const targets: TargetItem[] = [];

  for (const itemName of requested) {
    const cleanName = itemName.trim();
    if (!cleanName) continue;

    const fileName = `${slugify(cleanName)}.jpg`;
    if (!fileName || fileName === '.jpg') continue;

    const key = fileName.toLowerCase();
    if (deduped.has(key)) continue;
    deduped.add(key);

    const filePath = path.join(IMAGES_DIR, fileName);

    if (options.placeholderOnly && fs.existsSync(filePath)) {
      const currentHash = hashFile(filePath);
      if (currentHash !== placeholderHash) {
        continue;
      }
    }

    targets.push({
      itemName: cleanName,
      fileName,
      filePath,
    });
  }

  if (options.all) return targets;
  return targets.slice(0, options.limit);
}

function providerOrder(mode: ProviderMode): RealProvider[] {
  if (mode === 'pexels') return ['pexels'];
  if (mode === 'pixabay') return ['pixabay'];
  if (mode === 'openverse') return ['openverse'];
  return ['pexels', 'pixabay', 'openverse'];
}

function buildQueries(itemName: string): string[] {
  const compact = itemName.replace(/\s+/g, ' ').trim();
  const lower = compact.toLowerCase();

  const overrides = ITEM_QUERY_OVERRIDES[lower];
  if (overrides && overrides.length > 0) {
    return Array.from(new Set(overrides));
  }

  const queries = [
    `${compact} food`,
    compact,
    `${compact} plated dish`,
  ];

  return Array.from(new Set(queries));
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`HTTP ${response.status} from ${url}: ${text.slice(0, 200)}`);
  }
  return (await response.json()) as T;
}

function scoreSquare(width = 0, height = 0): number {
  if (!width || !height) return 0;
  const ratio = width / height;
  const ratioPenalty = Math.abs(1 - ratio) * 1000;
  const sizeBonus = Math.min(width, height);
  return sizeBonus - ratioPenalty;
}

const OPENVERSE_STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'the',
  'of',
  'for',
  'with',
  'to',
  'in',
  'on',
  'at',
  'have',
  'nice',
  'day',
  'house',
  'made',
  'style',
  'fresh',
  'low',
  'fat',
  'free',
  'hot',
  'cold',
  'plain',
]);

const INGREDIENT_KEYWORDS = [
  'cheese',
  'onion',
  'onions',
  'parsley',
  'ginger',
  'bagel',
  'yogurt',
  'bacon',
  'salami',
  'sauce',
  'lettuce',
  'tomato',
];

const DISH_TITLE_BLOCK_WORDS = [
  'sandwich',
  'burger',
  'taco',
  'pizza',
  'wrap',
  'burrito',
  'fries',
  'salad',
  'soup',
  'pasta',
  'chicken',
  'grilled',
  'kraut',
  'toast',
  'omelet',
  'omelette',
  'plate',
  'breakfast',
  'lunch',
  'dinner',
  'brunch',
  'tuna',
  'ham',
  'steak',
  'ribs',
];

const ITEM_QUERY_OVERRIDES: Record<string, string[]> = {
  'american cheese': ['american cheese slices', 'processed cheese slices', 'white american cheese'],
  'bbq sauce': ['homemade barbecue sauce', 'barbecue sauce'],
  'caramelized onions': ['caramelized onions', 'caramelized onions pan'],
  'cheddar cheese': ['cheddar cheese block', 'cheddar cheese slices'],
  'fresh cantaloupe': ['cantaloupe slices', 'fresh cantaloupe'],
  'fresh honeydew melon': ['honeydew melon slices', 'fresh honeydew melon'],
  'fresh italian parsley': ['italian parsley bunch', 'italian parsley'],
  'hash brown patty': ['hash brown patty', 'hash brown'],
  'turkey bacon': ['turkey bacon strips', 'cooked turkey bacon'],
  'vanilla belgian waffle': ['plain belgian waffle', 'belgian waffle'],
};

const ITEM_REQUIRED_TOKENS: Record<string, string[][]> = {
  'american cheese': [['american', 'cheese']],
  'bbq sauce': [['bbq', 'sauce'], ['barbecue', 'sauce']],
  'caramelized onions': [['caramelized', 'onion'], ['caramelised', 'onion']],
  'cheddar cheese': [['cheddar', 'cheese']],
  'fresh cantaloupe': [['cantaloupe']],
  'fresh honeydew melon': [['honeydew', 'melon']],
  'fresh italian parsley': [['italian', 'parsley'], ['parsley']],
  'hash brown patty': [['hash', 'brown'], ['hash', 'patty']],
  'turkey bacon': [['turkey', 'bacon']],
  'vanilla belgian waffle': [['belgian', 'waffle'], ['waffle']],
};

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function getItemMatchTokens(itemName: string): string[] {
  const tokens = tokenize(itemName).filter((token) => token.length > 2 && !OPENVERSE_STOP_WORDS.has(token));
  return Array.from(new Set(tokens));
}

function tokenMatchedInText(text: string, token: string): boolean {
  if (text.includes(token)) return true;
  if (token.endsWith('s') && token.length > 3 && text.includes(token.slice(0, -1))) return true;
  if (!token.endsWith('s') && token.length > 3 && text.includes(`${token}s`)) return true;
  return false;
}

function countTokenMatches(text: string, tokens: string[]): number {
  let matches = 0;
  for (const token of tokens) {
    if (tokenMatchedInText(text, token)) {
      matches += 1;
    }
  }
  return matches;
}

function isIngredientLikeItem(itemName: string): boolean {
  const lower = itemName.toLowerCase();
  return INGREDIENT_KEYWORDS.some((keyword) => lower.includes(keyword));
}

function scoreOpenverseResult(
  itemName: string,
  result: NonNullable<OpenverseSearchResponse['results']>[number]
): number | null {
  const tokens = getItemMatchTokens(itemName);
  if (tokens.length === 0) return null;

  const title = (result.title || '').toLowerCase();
  const tagText = (result.tags || [])
    .map((tag) => tag.name || '')
    .join(' ')
    .toLowerCase();
  const combined = `${title} ${tagText}`.trim();
  if (!combined) return null;

  const requiredGroups = ITEM_REQUIRED_TOKENS[itemName.toLowerCase()];
  if (requiredGroups && requiredGroups.length > 0) {
    const hasRequiredGroup = requiredGroups.some((group) => group.every((requiredToken) => tokenMatchedInText(combined, requiredToken)));
    if (!hasRequiredGroup) return null;
  }

  if (isIngredientLikeItem(itemName)) {
    for (const blocked of DISH_TITLE_BLOCK_WORDS) {
      if (title.includes(blocked)) return null;
    }
  }

  const titleMatches = countTokenMatches(title, tokens);
  const matches = countTokenMatches(combined, tokens);

  const coverage = matches / tokens.length;
  const minCoverage =
    tokens.length <= 1
      ? 1
      : tokens.length === 2
      ? 1
      : tokens.length === 3
      ? 2 / 3
      : 0.75;
  if (coverage < minCoverage) return null;

  // Avoid weak tag-only matches; title should carry the core meaning.
  if (tokens.length >= 2 && titleMatches === 0) return null;
  if (tokens.length >= 3 && titleMatches < 2) return null;

  const exactTitle = title.includes(itemName.toLowerCase()) ? 1 : 0;
  const shapeScore = scoreSquare(result.width, result.height);
  return coverage * 10000 + titleMatches * 1800 + exactTitle * 2000 + shapeScore;
}

async function searchPexels(query: string, apiKey: string): Promise<ImageCandidate | null> {
  const url = `https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&per_page=20`;
  const data = await fetchJson<PexelsSearchResponse>(url, {
    headers: { Authorization: apiKey },
  });

  const photos = Array.isArray(data.photos) ? data.photos : [];
  if (photos.length === 0) return null;

  const ranked = [...photos].sort((a, b) => scoreSquare(b.width, b.height) - scoreSquare(a.width, a.height));
  const best = ranked[0];
  const src = best.src.large2x || best.src.large || best.src.original || best.src.medium || best.src.small;
  if (!src) return null;

  return {
    provider: 'pexels',
    downloadUrl: src,
    sourceUrl: best.url,
    photographer: best.photographer,
    photographerUrl: best.photographer_url,
    license: 'Pexels License - https://www.pexels.com/license/',
    query,
    relevanceScore: scoreSquare(best.width, best.height),
  };
}

async function searchPixabay(query: string, apiKey: string): Promise<ImageCandidate | null> {
  const url = `https://pixabay.com/api/?key=${encodeURIComponent(apiKey)}&q=${encodeURIComponent(query)}&image_type=photo&safesearch=true&per_page=20`;
  const data = await fetchJson<PixabaySearchResponse>(url);

  const hits = Array.isArray(data.hits) ? data.hits : [];
  if (hits.length === 0) return null;

  const ranked = [...hits].sort((a, b) => scoreSquare(b.imageWidth, b.imageHeight) - scoreSquare(a.imageWidth, a.imageHeight));
  const best = ranked[0];
  const src = best.largeImageURL || best.webformatURL;
  if (!src) return null;

  return {
    provider: 'pixabay',
    downloadUrl: src,
    sourceUrl: best.pageURL,
    photographer: best.user,
    photographerUrl: best.user_id ? `https://pixabay.com/users/${best.user_id}/` : undefined,
    license: 'Pixabay License - https://pixabay.com/service/license-summary/',
    query,
    relevanceScore: scoreSquare(best.imageWidth, best.imageHeight),
  };
}

function toOpenverseLicenseText(license?: string, version?: string, url?: string): string {
  const name = license ? `CC ${license.toUpperCase()}` : 'Openverse license';
  const withVersion = version ? `${name} ${version}` : name;
  if (!url) return withVersion;
  return `${withVersion} - ${url}`;
}

async function searchOpenverse(query: string, itemName: string): Promise<ImageCandidate | null> {
  const url = `https://api.openverse.org/v1/images/?q=${encodeURIComponent(query)}&license_type=commercial&extension=jpg&page_size=20&mature=false`;
  const data = await fetchJson<OpenverseSearchResponse>(url);
  const results = Array.isArray(data.results) ? data.results : [];
  if (results.length === 0) return null;

  const ranked = results
    .filter((item) => Boolean(item.url))
    .map((item) => ({ item, score: scoreOpenverseResult(itemName, item) }))
    .filter((entry): entry is { item: NonNullable<OpenverseSearchResponse['results']>[number]; score: number } => entry.score !== null)
    .sort((a, b) => b.score - a.score);

  const best = ranked[0];
  const bestItem = best?.item;
  if (!bestItem?.url) return null;

  const sourceUrl = bestItem.foreign_landing_url || bestItem.url;
  return {
    provider: 'openverse',
    downloadUrl: bestItem.url,
    sourceUrl,
    photographer: bestItem.creator,
    photographerUrl: bestItem.creator_url,
    license: toOpenverseLicenseText(bestItem.license, bestItem.license_version, bestItem.license_url),
    query,
    relevanceScore: best.score,
  };
}

async function findImageCandidate(itemName: string, providers: RealProvider[], pexelsKey?: string, pixabayKey?: string): Promise<ImageCandidate | null> {
  const queries = buildQueries(itemName);
  let bestCandidate: ImageCandidate | null = null;

  for (const provider of providers) {
    for (const query of queries) {
      try {
        if (provider === 'pexels' && pexelsKey) {
          const found = await searchPexels(query, pexelsKey);
          if (found && (!bestCandidate || found.relevanceScore > bestCandidate.relevanceScore)) {
            bestCandidate = found;
          }
        }

        if (provider === 'pixabay' && pixabayKey) {
          const found = await searchPixabay(query, pixabayKey);
          if (found && (!bestCandidate || found.relevanceScore > bestCandidate.relevanceScore)) {
            bestCandidate = found;
          }
        }

        if (provider === 'openverse') {
          const found = await searchOpenverse(query, itemName);
          if (found && (!bestCandidate || found.relevanceScore > bestCandidate.relevanceScore)) {
            bestCandidate = found;
          }
        }
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[warn] ${provider} failed for "${itemName}" query "${query}": ${message}`);
      }
    }
  }

  return bestCandidate;
}

function ensureJpegIfPossible(filePath: string): void {
  const header = fs.readFileSync(filePath).subarray(0, 8).toString('hex');
  const isPng = header.startsWith('89504e47');
  if (!isPng) return;

  const sips = spawnSync('which', ['sips'], { stdio: 'pipe' });
  if (sips.status !== 0) return;

  const tmpOut = `${filePath}.converted.jpg`;
  const result = spawnSync('sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', 'best', filePath, '--out', tmpOut], {
    stdio: 'pipe',
  });

  if (result.status === 0 && fs.existsSync(tmpOut)) {
    fs.renameSync(tmpOut, filePath);
  }
}

async function downloadToFile(url: string, destinationPath: string): Promise<void> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed download (${response.status}) ${url}`);
  }

  const data = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(destinationPath, data);
  ensureJpegIfPossible(destinationPath);
}

function loadAttribution(): AttributionFile {
  if (!fs.existsSync(ATTRIBUTION_PATH)) {
    return { generatedAt: new Date().toISOString(), items: {} };
  }

  try {
    const raw = fs.readFileSync(ATTRIBUTION_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as AttributionFile;
    if (!parsed || typeof parsed !== 'object' || typeof parsed.items !== 'object') {
      return { generatedAt: new Date().toISOString(), items: {} };
    }
    return parsed;
  } catch {
    return { generatedAt: new Date().toISOString(), items: {} };
  }
}

function saveAttribution(file: AttributionFile): void {
  const sortedEntries = Object.entries(file.items).sort(([a], [b]) => a.localeCompare(b));
  const sortedItems: Record<string, AttributionEntry> = {};
  for (const [key, value] of sortedEntries) {
    sortedItems[key] = value;
  }

  const payload: AttributionFile = {
    generatedAt: new Date().toISOString(),
    items: sortedItems,
  };

  fs.writeFileSync(ATTRIBUTION_PATH, `${JSON.stringify(payload, null, 2)}\n`, 'utf-8');
}

async function main(): Promise<void> {
  const options = parseCliOptions();

  if (!fs.existsSync(IMAGES_DIR)) {
    fs.mkdirSync(IMAGES_DIR, { recursive: true });
  }

  if (!fs.existsSync(PLACEHOLDER_PATH)) {
    throw new Error(`Placeholder not found: ${PLACEHOLDER_PATH}`);
  }

  const pexelsKey = process.env.PEXELS_API_KEY;
  const pixabayKey = process.env.PIXABAY_API_KEY;

  const providers = providerOrder(options.provider).filter((provider) => {
    if (provider === 'openverse') return true;
    if (provider === 'pexels') return Boolean(pexelsKey);
    if (provider === 'pixabay') return Boolean(pixabayKey);
    return false;
  });

  if (!options.dryRun && providers.length === 0) {
    throw new Error('No API keys found. Set PEXELS_API_KEY and/or PIXABAY_API_KEY in .env.');
  }

  const placeholderHash = hashFile(PLACEHOLDER_PATH);
  const menuItems = readMenuItemNames(MENU_PATH);
  const targets = buildTargets(menuItems, options, placeholderHash);

  console.log(`Menu items detected: ${menuItems.length}`);
  console.log(`Eligible targets: ${targets.length}`);
  console.log(`Mode: ${options.dryRun ? 'dry-run' : 'write'}`);

  if (targets.length === 0) {
    console.log('Nothing to process.');
    return;
  }

  const attribution = loadAttribution();
  let successCount = 0;
  let skippedCount = 0;

  for (const [index, target] of targets.entries()) {
    console.log(`\n[${index + 1}/${targets.length}] ${target.itemName}`);

    if (options.dryRun) {
      console.log(`Would process ${target.fileName}`);
      continue;
    }

    const candidate = await findImageCandidate(target.itemName, providers, pexelsKey, pixabayKey);
    if (!candidate) {
      console.log('No stock result found. Keeping existing image.');
      skippedCount += 1;
      continue;
    }

    try {
      await downloadToFile(candidate.downloadUrl, target.filePath);
      attribution.items[target.fileName] = {
        itemName: target.itemName,
        fileName: target.fileName,
        provider: candidate.provider,
        sourceUrl: candidate.sourceUrl,
        imageUrl: candidate.downloadUrl,
        photographer: candidate.photographer,
        photographerUrl: candidate.photographerUrl,
        query: candidate.query,
        license: candidate.license,
        downloadedAt: new Date().toISOString(),
      };
      console.log(`Saved via ${candidate.provider} (${candidate.query})`);
      successCount += 1;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.log(`Failed to save image: ${message}`);
      skippedCount += 1;
    }
  }

  if (!options.dryRun) {
    saveAttribution(attribution);
  }

  console.log(`\nDone. saved=${successCount} skipped=${skippedCount}`);
  if (!options.dryRun) {
    console.log(`Attribution file: ${ATTRIBUTION_PATH}`);
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
});
