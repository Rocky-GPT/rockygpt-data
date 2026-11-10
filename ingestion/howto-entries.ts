/**
 * howto-entries.ts
 *
 * Has a model read each office page publish will hold (office_sections: the office sites and the
 * catalog's academic policies) and list its how-to entries (src/data-v2/howto-entries.ts). A page
 * is read only when its sections or the instructions changed: the model's raw replies are kept in
 * data/raw/howto-entries.raw.json by page and content key, and publish checks them against the page.
 *
 * The key is never read from .env (production): pass it for this run only.
 *   HOWTO_OPENAI_API_KEY=… [HOWTO_OPENAI_PROJECT=…] [HOWTO_OPENAI_MODEL=gpt-6-luna] \
 *     DOTENV_CONFIG_PATH=/dev/null npx tsx ingestion/howto-entries.ts [--only folder,folder] [--limit N]
 *       [--spread] [--max-usd 0.50]
 *
 * --limit reads the first N due pages; with --spread, N pages spaced evenly across them (a sample
 * of every site, to measure what a page costs). A run stops sending before it could spend more
 * than --max-usd (HOWTO_MAX_USD, default $0.50): a page is sent only while its worst case (its
 * whole text and the longest reply allowed) still fits, and the pages left over wait for the next run.
 */
import fs from 'node:fs';
import path from 'node:path';
import pLimit from 'p-limit';
import { writeJsonFile, writeRawFileProvenance } from './pipeline-utils';
import { readSkippedSections } from './folder-sites';
import { loadCapturedPages } from '../src/directory/contact-evidence';
import { officeSectionPages, type OfficeSectionsPage } from '../src/data-v2/office-sections';
import { catalogPolicyPages, type CatalogPoliciesCapture } from '../src/data-v2/catalog-policies';
import { HOWTO_PROMPT, HOWTO_SCHEMA, entriesKey, pageInput, verifiedEntries, type HowtoEntry } from '../src/data-v2/howto-entries';

export const HOWTO_RAW = path.join(process.cwd(), 'data', 'raw', 'howto-entries.raw.json');

export interface HowtoCapture {
  dataset: 'howto-entries';
  /** page key -> the model's reply for the page's content key. */
  pages: Record<string, { key: string; url: string; model: string; read_at: string; reply: unknown }>;
}

/** The pages publish writes to office_sections, built the same way, from the captures in rawDir. */
export function howtoPages(rawDir = path.join(process.cwd(), 'data', 'raw')): OfficeSectionsPage[] {
  const sites = JSON.parse(fs.readFileSync('src/reference/office-sites.json', 'utf8')).sites as Array<{ folder: string }>;
  const officeFolders = new Set<string>(sites.map(site => site.folder));
  const catalog = JSON.parse(fs.readFileSync(path.join(rawDir, 'catalog-policies.raw.json'), 'utf8')) as CatalogPoliciesCapture;
  return [...officeSectionPages(loadCapturedPages(rawDir), officeFolders, readSkippedSections('src/reference/office-sites.json')),
    ...catalogPolicyPages(catalog)];
}

/** What the reader holds or would send for a page: the key that decides a re-read, and the characters sent. */
export interface PageRead { key: string; chars: number }

/** Each page's key and size, as a read of it would have them. */
export function pageReads(pages: readonly OfficeSectionsPage[]): Map<string, PageRead> {
  return new Map(pages.map(page => [page.key,
    { key: entriesKey(page.url, page.sections), chars: HOWTO_PROMPT.length + pageInput(page.url, page.sections).length }]));
}

export interface ReadCount { pages: number; same: number; changed: number; added: number; gone: number; charsToRead: number }

/** How many of `after`'s pages the reader would read, had it read every page of `before`: a page
 * is read again only when its own words (or the instructions) changed. */
export function countReads(before: ReadonlyMap<string, PageRead>, after: ReadonlyMap<string, PageRead>): ReadCount {
  const count: ReadCount = { pages: after.size, same: 0, changed: 0, added: 0, gone: 0, charsToRead: 0 };
  for (const [page, now] of after) {
    const was = before.get(page);
    if (was?.key === now.key) { count.same++; continue; }
    if (was) count.changed++; else count.added++;
    count.charsToRead += now.chars;
  }
  for (const page of before.keys()) if (!after.has(page)) count.gone++;
  return count;
}

export function readHowtoCapture(file = HOWTO_RAW): HowtoCapture {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) as HowtoCapture : { dataset: 'howto-entries', pages: {} };
}

/** A page's verified entries, when the model read this very content; else none. */
export function pageEntries(capture: HowtoCapture, page: OfficeSectionsPage): HowtoEntry[] {
  const read = capture.pages[page.key];
  return read && read.key === entriesKey(page.url, page.sections) ? verifiedEntries(read.reply, page.sections) : [];
}

/** gpt-6-luna's listed rates in billionths of a dollar per token, as the Brain pins them
 * (rockygpt-brain provider-release.json); HOWTO_INPUT_NUSD_PER_TOKEN and
 * HOWTO_OUTPUT_NUSD_PER_TOKEN replace them when the price or the model changes. */
export const HOWTO_RATES = { input: 125, output: 500 } as const;
const NUSD_PER_DOLLAR = 1_000_000_000;
/** The first reply's length limit, and the limit of the one longer try a cut-off reply gets. */
const REPLY_TOKENS = 8000;
const LONG_REPLY_TOKENS = 24000;
/** A try whose reply ran out of room, and a page the cap had no room for. */
const CUT = Symbol('cut');
const WAITS = Symbol('waits');

/**
 * What a run may spend. A page is sent only while its worst case fits under the cap beside the
 * pages already out: every two characters of input counted as a token, and a reply as long as
 * its limit allows. What a call really cost replaces its hold when it comes back.
 */
export class ReadBudget {
  private spent = 0;
  private held = 0;
  constructor(private readonly capNusd: number,
    private readonly rates: { input: number; output: number } = HOWTO_RATES) {}

  /** Holds a page's worst case and returns it, or null when it does not fit under the cap. */
  hold(inputChars: number, maxOutputTokens: number): number | null {
    const worst = Math.ceil(inputChars / 2) * this.rates.input + maxOutputTokens * this.rates.output;
    if (this.spent + this.held + worst > this.capNusd) return null;
    this.held += worst;
    return worst;
  }

  /** Swaps a hold for what the call used (nothing, when it never reached the model). */
  settle(held: number, inputTokens: number, outputTokens: number): void {
    this.held -= held;
    this.spent += inputTokens * this.rates.input + outputTokens * this.rates.output;
  }

  get spentUsd(): number { return this.spent / NUSD_PER_DOLLAR; }
}

/** The first `count` of the pages, or with `spread` that many spaced evenly across them. */
export function pickPages<T>(pages: readonly T[], count: number, spread: boolean): T[] {
  if (!(count < pages.length)) return [...pages];
  if (!spread) return pages.slice(0, Math.max(0, count));
  return Array.from({ length: Math.max(0, count) }, (_, index) => pages[Math.floor(index * pages.length / count)]);
}

/** One read of a page. `reply` is null when the model's answer was cut off before its JSON
 * ended; the tokens it used are reported either way. */
async function ask(page: OfficeSectionsPage, model: string, maxOutput: number): Promise<{ reply: unknown | null; input: number; output: number }> {
  const headers: Record<string, string> = { 'content-type': 'application/json',
    authorization: `Bearer ${process.env.HOWTO_OPENAI_API_KEY}` };
  if (process.env.HOWTO_OPENAI_PROJECT) headers['openai-project'] = process.env.HOWTO_OPENAI_PROJECT;
  for (let attempt = 1; ; attempt++) {
    const response = await fetch('https://api.openai.com/v1/responses', { method: 'POST', headers, body: JSON.stringify({
      model, store: false, max_output_tokens: maxOutput,
      input: [{ role: 'system', content: HOWTO_PROMPT }, { role: 'user', content: pageInput(page.url, page.sections) }],
      text: { format: { type: 'json_schema', name: 'howto_entries', schema: HOWTO_SCHEMA, strict: true } },
    }) });
    if (response.ok) {
      const body = await response.json() as { status?: string;
        output?: Array<{ type: string; content?: Array<{ type: string; text?: string }> }>;
        usage?: { input_tokens?: number; output_tokens?: number } };
      const text = body.output?.find(item => item.type === 'message')?.content?.find(part => part.type === 'output_text')?.text;
      // A reply that ran out of room is not "no entries", whether it stopped mid-JSON or before its first word.
      let reply: unknown | null = body.status === 'incomplete' ? null : { entries: [] };
      if (text && reply !== null) {
        try { reply = JSON.parse(text); } catch { reply = null; }
      }
      return { reply, input: body.usage?.input_tokens ?? 0, output: body.usage?.output_tokens ?? 0 };
    }
    if (attempt >= 3 || ![429, 500, 502, 503].includes(response.status)) throw new Error(`${page.url}: the model answered ${response.status}`);
    await new Promise(resolve => setTimeout(resolve, 2000 * attempt));
  }
}

async function main(): Promise<void> {
  if (!process.env.HOWTO_OPENAI_API_KEY) throw new Error('Pass HOWTO_OPENAI_API_KEY for this run (never from .env).');
  const model = process.env.HOWTO_OPENAI_MODEL || 'gpt-6-luna';
  const argument = (name: string) => { const at = process.argv.indexOf(name); return at > 0 ? process.argv[at + 1] : undefined; };
  const only = argument('--only')?.split(',');
  const limit = Number(argument('--limit') ?? Infinity);
  const maxUsd = Number(argument('--max-usd') ?? (process.env.HOWTO_MAX_USD?.trim() || 0.5));
  if (!(maxUsd > 0) || Number.isNaN(limit)) throw new Error('--max-usd takes a dollar amount and --limit a number of pages.');
  const rates = { input: Number(process.env.HOWTO_INPUT_NUSD_PER_TOKEN) || HOWTO_RATES.input,
    output: Number(process.env.HOWTO_OUTPUT_NUSD_PER_TOKEN) || HOWTO_RATES.output };
  const budget = new ReadBudget(maxUsd * NUSD_PER_DOLLAR, rates);
  const capture = readHowtoCapture();
  const pages = howtoPages().filter(page => !only || only.includes(page.folder));
  const changed = pages.filter(page => capture.pages[page.key]?.key !== entriesKey(page.url, page.sections));
  const due = pickPages(changed, limit, process.argv.includes('--spread'));
  console.log(`${pages.length} pages; ${changed.length} new or changed since they were last read `
    + `(${pages.length - changed.length} unchanged); reading ${due.length}, spending at most $${maxUsd.toFixed(2)}.`);
  let input = 0, output = 0, done = 0, entries = 0, skipped = 0, waiting = 0;
  const queue = pLimit(Number(process.env.HOWTO_CONCURRENCY) || 4);
  /** One try at a page under the budget: the model's reply, CUT when it ran out of room, or
   * WAITS when the cap has no room left for the page. */
  const attempt = async (page: OfficeSectionsPage, maxOutput: number): Promise<unknown> => {
    const held = budget.hold(HOWTO_PROMPT.length + pageInput(page.url, page.sections).length, maxOutput);
    if (held === null) return WAITS;
    let used = { input: 0, output: 0 };
    try {
      const read = await ask(page, model, maxOutput);
      used = read;
      input += read.input; output += read.output;
      return read.reply === null ? CUT : read.reply;
    } finally {
      budget.settle(held, used.input, used.output);
    }
  };
  await Promise.all(due.map(page => queue(async () => {
    // A page with many table rows can outrun the reply's length and come back cut off: read it
    // once more with room to spare; a page that still fails keeps no entries, not the run.
    let reply: unknown;
    try {
      reply = await attempt(page, REPLY_TOKENS);
      if (reply === CUT) reply = await attempt(page, LONG_REPLY_TOKENS);
      if (reply === WAITS) { waiting++; return; }
      if (reply === CUT) throw new Error(`${page.url}: the reply was cut off twice`);
    } catch (error) {
      skipped++;
      console.log(`Skipped ${page.url}: ${error instanceof Error ? error.message : error}`);
      return;
    }
    capture.pages[page.key] = { key: entriesKey(page.url, page.sections), url: page.url, model, read_at: new Date().toISOString(), reply };
    done++;
    entries += verifiedEntries(reply, page.sections).length;
    if (done % 50 === 0) { writeJsonFile(HOWTO_RAW, capture); console.log(`${done}/${due.length} read`); }
  })));
  writeJsonFile(HOWTO_RAW, capture);
  writeRawFileProvenance('howto-entries', HOWTO_RAW, { recordCount: Object.keys(capture.pages).length });
  console.log(`Read ${done} pages (${skipped} skipped): ${entries} verified entries; ${input} input and ${output} output tokens; `
    + `$${budget.spentUsd.toFixed(4)} at ${rates.input} and ${rates.output} billionths of a dollar per input and output token`
    + `${done ? `, $${(budget.spentUsd / done).toFixed(5)} a page read` : ''}.`);
  if (waiting) console.log(`${waiting} pages wait for the next run: the $${maxUsd.toFixed(2)} cap had no room left for them.`);
}

if (process.argv[1]?.endsWith('howto-entries.ts')) {
  main().catch(error => { console.error('Fatal:', error instanceof Error ? error.message : error); process.exitCode = 1; });
}
