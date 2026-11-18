// Study only (never merged): which archived captures hold the Registrar page, how each one's
// staff section is shaped, and how this checkout's code shapes the same HTML.
import { downloadRawArtifactBundle, listArchivedCaptures } from '../pipeline/raw-artifacts';
import { buildRawPageFromHtml, sourceHtml } from '../ingestion/raw-collector';
import { pageKey } from '../src/directory/contact-evidence';

const WANT = pageKey('https://www.ramapo.edu/registrar/');
type Page = { url: string; requestedUrl?: string; fetchedAt?: string; statusCode: number; sections?: Array<{ heading: string; text: string }>; html?: string; htmlGzip?: string; contentHash?: string; sourceType?: 'seed' | 'detail' };

async function main() {
  for (const source of ['office-pages', 'campus-directory', 'academic-sites']) {
    const captures = (await listArchivedCaptures(source)).sort((a, b) => a.collectedAt.localeCompare(b.collectedAt));
    for (const capture of captures.slice(-2)) {
      console.log(`### ${source} capture ${capture.collectedAt}`);
      const bundle = await downloadRawArtifactBundle(capture.rawUri, capture.rawHash);
      for (const entry of bundle.entries) {
        const pages = ((entry.content as { pages?: Page[] })?.pages ?? []);
        for (const page of pages) {
          if (pageKey(page.url) !== WANT && pageKey(page.requestedUrl ?? '') !== WANT) continue;
          if (page.sections) {
            const staff = page.sections.find(s => /staff/i.test(s.heading));
            console.log(`  ${entry.file} fetchedAt=${page.fetchedAt} status=${page.statusCode} staff=${JSON.stringify(staff?.text.slice(0, 260))}`);
          } else {
            const html = sourceHtml({ html: page.html ?? '', htmlGzip: page.htmlGzip });
            const built = buildRawPageFromHtml({ url: page.url, html, sourceType: page.sourceType ?? 'detail',
              fetchedAt: page.fetchedAt ?? '', statusCode: page.statusCode, allowedHost: new URL(page.url).host });
            const staff = built.sections.find(s => /staff/i.test(s.heading)) as { text: string; shaped?: string } | undefined;
            console.log(`  ${entry.file} (HTML, rebuilt now) shaped=${JSON.stringify((staff?.shaped ?? staff?.text ?? '').slice(0, 260))}`);
          }
        }
      }
    }
  }
}
main().catch(err => { console.error(err); process.exit(1); });
