// Study only (never merged): read the newest archived academic-sites capture from R2 and
// (1) check proposed owner quotes the way the publish does (heading + text, spaces folded,
// lower case), (2) print each unowned folder's lines that name a school or an office.
import { downloadRawArtifactBundle, listArchivedCaptures } from '../pipeline/raw-artifacts';
import { pageKey } from '../src/directory/contact-evidence';

const PROPOSED: Array<[string, string, string]> = JSON.parse(process.env.PROPOSED ?? '[]');
const FOLDERS = (process.env.FOLDERS ?? '').split(',').filter(Boolean);
const folded = (t: string) => t.replace(/\s+/g, ' ').trim().toLowerCase();

async function main() {
  const captures = (await listArchivedCaptures('academic-sites')).sort((a, b) => a.collectedAt.localeCompare(b.collectedAt));
  const latest = captures.at(-1);
  if (!latest) throw new Error('no capture');
  console.log('capture', latest.collectedAt, captures.length, 'archived');
  const bundle = await downloadRawArtifactBundle(latest.rawUri, latest.rawHash);
  const entry = bundle.entries.find(e => e.file === 'academic-sites.raw.json');
  const pages = ((entry?.content as { pages?: Array<{ url: string; statusCode: number; sections: Array<{ heading: string; text: string }> }> })?.pages ?? [])
    .filter(p => p.statusCode === 200 && Array.isArray(p.sections));
  const byKey = new Map(pages.map(p => [pageKey(p.url), p]));
  console.log('pages', pages.length);
  for (const [folder, url, quote] of PROPOSED) {
    const page = byKey.get(pageKey(url));
    const text = page ? folded(page.sections.map(s => `${s.heading} ${s.text}`).join(' ')) : '';
    console.log(`QUOTE ${folder} ${page ? (text.includes(folded(quote)) ? 'FOUND' : 'MISSING') : 'NO PAGE'} | ${url} | ${quote}`);
    if (page && !text.includes(folded(quote))) {
      for (const s of page.sections) console.log(`   [${s.heading}] ${s.text.slice(0, 300).replace(/\s+/g, ' ')}`);
    }
  }
  const want = /school of|office of|anisfield|graduate admissions|graduate@|dean|director/i;
  for (const folder of FOLDERS) {
    const mine = pages.filter(p => new URL(p.url).pathname.split('/')[1] === folder);
    console.log(`##### ${folder}: ${mine.length} pages`);
    for (const p of mine.slice(0, 30)) {
      const hits = p.sections.flatMap(s => `${s.heading}. ${s.text}`.split(/(?<=[.!?])\s+|\n/))
        .map(l => l.replace(/\s+/g, ' ').trim()).filter(l => l && l.length < 260 && want.test(l));
      console.log(`  ${p.url} | ${p.sections.map(s => s.heading).slice(0, 6).join(' / ')}`);
      for (const h of [...new Set(hits)].slice(0, 5)) console.log(`      ${h}`);
    }
  }
}
main().catch(err => { console.error(err); process.exit(1); });
