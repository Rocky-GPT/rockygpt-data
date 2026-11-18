/**
 * show-blocked-pages.ts
 *
 * The list of what RockyGPT cannot read on Ramapo's sites (Dan, 2026-11-18): every site's
 * robots.txt rules as the run read them, every page the run was refused, and the reviewed list of
 * blocks robots.txt does not show (sign-in walls, src/reference/blocked-sources.json).
 *
 * Reads data/review/blocked-pages.jsonl (written by site-guard during a refresh) and writes
 * data/review/blocked-pages.md and data/review/blocked-pages.json, and prints the Markdown.
 *   npx tsx scripts/review/show-blocked-pages.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import reviewed from '../../src/reference/blocked-sources.json';
import { BLOCKED_PAGES_NOTE, type BlockedNote } from '../../ingestion/site-guard';

export interface BlockedSummary {
  generatedAt: string;
  sites: Array<{ site: string; status: number | null; refuses: string[]; crawlDelaySeconds: number }>;
  refused: Array<{ url: string; reason: string }>;
  reviewed: typeof reviewed.sources;
}

export function summarize(lines: string[], now = new Date()): BlockedSummary {
  const sites = new Map<string, BlockedSummary['sites'][number]>();
  const refused = new Map<string, string>();
  for (const line of lines) {
    if (!line.trim()) continue;
    let note: BlockedNote;
    try {
      note = JSON.parse(line) as BlockedNote;
    } catch {
      continue;
    }
    if (note.type === 'site') sites.set(note.site, { site: note.site, status: note.status, refuses: note.refuses,
      crawlDelaySeconds: note.crawlDelaySeconds });
    else if (note.type === 'refused') refused.set(note.url, note.reason);
  }
  return {
    generatedAt: now.toISOString(),
    sites: [...sites.values()].sort((a, b) => a.site.localeCompare(b.site)),
    refused: [...refused].map(([url, reason]) => ({ url, reason })).sort((a, b) => a.url.localeCompare(b.url)),
    reviewed: reviewed.sources,
  };
}

export function markdown(summary: BlockedSummary): string {
  const out = ['# What RockyGPT cannot read on Ramapo\'s sites', '',
    `Made ${summary.generatedAt.slice(0, 16).replace('T', ' ')} UTC from this run's robots.txt reads, plus the reviewed list.`, '',
    '## Each site\'s robots.txt, as read this run', ''];
  if (!summary.sites.length) out.push('No Ramapo site was read this run.', '');
  for (const site of summary.sites) {
    const delay = site.crawlDelaySeconds ? `, ${site.crawlDelaySeconds} s between pages` : '';
    const status = site.status === null ? 'no answer' : String(site.status);
    out.push(`- **${site.site}** (robots.txt answered ${status}${delay}): ${site.refuses.length
      ? `blocks ${site.refuses.map(rule => `\`${rule}\``).join(', ')}` : 'blocks nothing'}`);
  }
  out.push('', '## Pages this run wanted but was refused', '');
  if (!summary.refused.length) out.push('None.');
  for (const page of summary.refused) out.push(`- ${page.url}: ${page.reason}`);
  out.push('', '## Reviewed list (sign-in walls and robots.txt blocks that matter)', '',
    '| Site | What | Why | What it means for answers |', '| --- | --- | --- | --- |');
  for (const source of summary.reviewed) {
    out.push(`| ${source.site} | ${source.what} | ${source.why === 'robots' ? 'robots.txt' : 'needs sign-in'} | ${source.effect} |`);
  }
  return `${out.join('\n')}\n`;
}

function main(): void {
  const notePath = path.join(process.cwd(), BLOCKED_PAGES_NOTE);
  const lines = fs.existsSync(notePath) ? fs.readFileSync(notePath, 'utf8').split('\n') : [];
  const summary = summarize(lines);
  const reviewDir = path.dirname(notePath);
  fs.mkdirSync(reviewDir, { recursive: true });
  fs.writeFileSync(path.join(reviewDir, 'blocked-pages.json'), `${JSON.stringify(summary, null, 2)}\n`);
  const text = markdown(summary);
  fs.writeFileSync(path.join(reviewDir, 'blocked-pages.md'), text);
  console.log(text);
}

if (process.argv[1]?.endsWith('show-blocked-pages.ts')) main();
