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

/** The pages publish writes to office_sections, built the same way. */
export function howtoPages(): OfficeSectionsPage[] {
  const sites = JSON.parse(fs.readFileSync('src/reference/office-sites.json', 'utf8')).sites as Array<{ folder: string }>;
  const officeFolders = new Set<string>(sites.map(site => site.folder));
  const catalog = JSON.parse(fs.readFileSync('data/raw/catalog-policies.raw.json', 'utf8')) as CatalogPoliciesCapture;
  return [...officeSectionPages(loadCapturedPages(), officeFolders, readSkippedSections('src/reference/office-sites.json')),
    ...catalogPolicyPages(catalog)];
}

export function readHowtoCapture(file = HOWTO_RAW): HowtoCapture {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) as HowtoCapture : { dataset: 'howto-entries', pages: {} };
}

/** A page's verified entries, when the model read this very content; else none. */
export function pageEntries(capture: HowtoCapture, page: OfficeSectionsPage): HowtoEntry[] {
  const read = capture.pages[page.key];
  return read && read.key === entriesKey(page.url, page.sections) ? verifiedEntries(read.reply, page.sections) : [];
}

async function ask(page: OfficeSectionsPage, model: string, maxOutput = 8000): Promise<{ reply: unknown; input: number; output: number }> {
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
      const body = await response.json() as { output?: Array<{ type: string; content?: Array<{ type: string; text?: string }> }>;
        usage?: { input_tokens?: number; output_tokens?: number } };
      const text = body.output?.find(item => item.type === 'message')?.content?.find(part => part.type === 'output_text')?.text;
      return { reply: text ? JSON.parse(text) : { entries: [] }, input: body.usage?.input_tokens ?? 0, output: body.usage?.output_tokens ?? 0 };
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
  const capture = readHowtoCapture();
  const pages = howtoPages().filter(page => !only || only.includes(page.folder));
  const due = pages.filter(page => capture.pages[page.key]?.key !== entriesKey(page.url, page.sections)).slice(0, limit);
  console.log(`${pages.length} pages; ${due.length} to read (${pages.length - due.length} unchanged).`);
  let input = 0, output = 0, done = 0, entries = 0;
  const queue = pLimit(Number(process.env.HOWTO_CONCURRENCY) || 4);
  let skipped = 0;
  await Promise.all(due.map(page => queue(async () => {
    // A page with many table rows can outrun the reply's length and come back cut mid-JSON: read
    // it once more with room to spare; a page that still fails keeps no entries, not the run.
    let read: Awaited<ReturnType<typeof ask>>;
    try {
      read = await ask(page, model);
    } catch {
      try {
        read = await ask(page, model, 24000);
      } catch (error) {
        skipped++;
        console.log(`Skipped ${page.url}: ${error instanceof Error ? error.message : error}`);
        return;
      }
    }
    capture.pages[page.key] = { key: entriesKey(page.url, page.sections), url: page.url, model, read_at: new Date().toISOString(), reply: read.reply };
    input += read.input; output += read.output; done++;
    entries += verifiedEntries(read.reply, page.sections).length;
    if (done % 50 === 0) { writeJsonFile(HOWTO_RAW, capture); console.log(`${done}/${due.length} read`); }
  })));
  writeJsonFile(HOWTO_RAW, capture);
  writeRawFileProvenance('howto-entries', HOWTO_RAW, { recordCount: Object.keys(capture.pages).length });
  console.log(`Read ${done} pages (${skipped} skipped): ${entries} verified entries; ${input} input and ${output} output tokens.`);
}

if (process.argv[1]?.endsWith('howto-entries.ts')) {
  main().catch(error => { console.error('Fatal:', error instanceof Error ? error.message : error); process.exitCode = 1; });
}
