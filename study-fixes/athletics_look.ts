// Study only (never merged): which ramapoathletics.com pages are already in archived captures,
// with their sections, and does any capture mention intramurals? No download from any site.
import { downloadRawArtifactBundle, listArchivedCaptures } from '../pipeline/raw-artifacts';

type Page = { url: string; statusCode: number; title?: string; sections?: Array<{ heading: string; text: string; shaped?: string }> };

async function main() {
  for (const source of ['campus-directory', 'campus-hours', 'office-pages']) {
    const captures = (await listArchivedCaptures(source)).sort((a, b) => a.collectedAt.localeCompare(b.collectedAt));
    const latest = captures.at(-1);
    if (!latest?.rawUri) { console.log(source, 'no capture'); continue; }
    console.log('#####', source, latest.collectedAt);
    const bundle = await downloadRawArtifactBundle(latest.rawUri, latest.rawHash);
    for (const entry of bundle.entries) {
      if (entry.file.endsWith('-sources.raw.json')) continue;
      const pages = ((entry.content as { pages?: Page[] })?.pages ?? []);
      if (!Array.isArray(pages)) continue;
      const mention = pages.filter(p => JSON.stringify(p.sections ?? []).match(/intramural/i)).map(p => p.url);
      console.log(`  ${entry.file}: ${pages.length} pages; mention intramural: ${mention.length}`, mention.slice(0, 15));
      for (const p of pages.filter(p => /ramapoathletics/i.test(p.url))) {
        console.log(`  PAGE ${p.url} status=${p.statusCode} title=${p.title} sections=${p.sections?.length}`);
        for (const s of (p.sections ?? []).slice(0, 25)) {
          console.log(`     [${s.heading}] ${s.text.slice(0, 400).replace(/\s+/g, ' ')}`);
        }
      }
    }
  }
}
main().catch(err => { console.error(err); process.exit(1); });
