/**
 * Shows every reviewed page section of an office whose text no longer matches its review,
 * with the section's current text and hash, so a person can re-review it without downloading
 * the page again.
 *
 *   tsx scripts/review/show-changed-sections.ts "Athletics"            # pages in data/raw
 *   tsx scripts/review/show-changed-sections.ts "Athletics" --from-r2  # newest archived captures
 *   tsx scripts/review/show-changed-sections.ts "Athletics;Registrar" --from-r2 --before 2026-11-08
 *   tsx scripts/review/show-changed-sections.ts --from-r2              # every office the gate lists
 *
 * --from-r2 first restores the newest archived raw bundle of each source into data/raw (needs
 * the RAW_ARTIFACT_* settings the publish uses). It reads the archive only: it never fetches a
 * college page. --before also restores, beside them, the newest bundles archived before that
 * time (the pages the last review saw) and prints what changed in each section, line by line.
 * It then runs the publish's completed-office-review gate on the newest captures.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { downloadRawArtifactBundle, SOURCE_RAW_ARTIFACT_FILES } from '../../pipeline/raw-artifacts';
import { checkCompletedOfficeReviews } from '../../pipeline/office-review-gate';
import { buildStructuredDirectoryContacts } from '../../src/directory/structured-contacts';
import {
  contactSectionHash, evidenceText, loadCapturedPages, pageKey, type CapturedPage,
} from '../../src/directory/contact-evidence';

interface ReviewedEntry { url: string; section: string; near?: string; reviewed?: { text_sha256: string } }
interface ReviewedSection { url: string; section: string; near?: string; blockStart?: string; hashes: Set<string>; uses: string[] }

/** Restores each source's newest archived bundle (stored before `before`, when given) into rawDir. */
async function restoreNewestBundles(rawDir: string, before?: number): Promise<void> {
  const bucket = process.env.RAW_ARTIFACT_BUCKET;
  if (!bucket) throw new Error('RAW_ARTIFACT_BUCKET is required for --from-r2.');
  const client = new S3Client({
    region: process.env.RAW_ARTIFACT_REGION || 'us-east-1',
    endpoint: process.env.RAW_ARTIFACT_ENDPOINT || undefined,
    credentials: process.env.RAW_ARTIFACT_ACCESS_KEY_ID && process.env.RAW_ARTIFACT_SECRET_ACCESS_KEY
      ? { accessKeyId: process.env.RAW_ARTIFACT_ACCESS_KEY_ID, secretAccessKey: process.env.RAW_ARTIFACT_SECRET_ACCESS_KEY }
      : undefined,
  });
  fs.mkdirSync(rawDir, { recursive: true });
  for (const sourceKey of Object.keys(SOURCE_RAW_ARTIFACT_FILES)) {
    let newest: { key: string; at: number } | null = null;
    let token: string | undefined;
    do {
      const page = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: `raw/${sourceKey}/`, ContinuationToken: token }));
      for (const object of page.Contents ?? []) {
        const at = object.LastModified?.getTime() ?? 0;
        if (before !== undefined && at >= before) continue;
        if (object.Key && (!newest || at > newest.at)) newest = { key: object.Key, at };
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
    if (!newest) continue;
    const bundle = await downloadRawArtifactBundle(`s3://${bucket}/${newest.key}`);
    for (const entry of bundle.entries) {
      const body = typeof entry.content === 'string' ? entry.content : JSON.stringify(entry.content);
      fs.writeFileSync(path.join(rawDir, entry.file), body);
    }
    console.log(`Restored ${sourceKey} from ${newest.key} (stored ${new Date(newest.at).toISOString()}).`);
  }
}

/** Every reviewed section an office's entry cites, wherever in the entry it sits. */
function reviewedSections(entry: unknown): ReviewedSection[] {
  const found = new Map<string, ReviewedSection>();
  const visit = (value: unknown, trail: string[]): void => {
    if (Array.isArray(value)) { value.forEach((item, index) => visit(item, [...trail, String(index)])); return; }
    if (!value || typeof value !== 'object') return;
    const record = value as Record<string, unknown>;
    const hash = (record as Partial<ReviewedEntry>).reviewed?.text_sha256 ?? (typeof record.text_sha256 === 'string' ? record.text_sha256 : undefined);
    if (typeof record.url === 'string' && typeof record.section === 'string') {
      const near = typeof record.near === 'string' ? record.near : undefined;
      const blockStart = typeof record.blockStart === 'string' ? record.blockStart : undefined;
      const key = `${pageKey(record.url)}\n${record.section}\n${near ?? ''}\n${blockStart ?? ''}`;
      const item = found.get(key) ?? { url: record.url, section: record.section, near, blockStart, hashes: new Set<string>(), uses: [] };
      if (hash) item.hashes.add(hash);
      item.uses.push(trail.join('.'));
      found.set(key, item);
    }
    for (const [key, child] of Object.entries(record)) visit(child, [...trail, key]);
  };
  visit(entry, []);
  return [...found.values()];
}

const cited = (item: ReviewedSection) => ({ url: item.url, section: item.section, near: item.near, blockStart: item.blockStart, fields: [] });
/** How a citation names its place on the page. */
const place = (item: ReviewedSection) => `"${item.section}"${item.blockStart ? ` (the block starting "${item.blockStart}")` : ''}${item.near ? ` near "${item.near}"` : ''}`;

/** Lines only the old text has (-) and lines only the new text has (+), in page order. */
function changedLines(before: string, after: string): string[] {
  // A captured section is one long line: break it at list items and sentences so one changed name shows as one line.
  const lines = (text: string) => text.split(/\n|(?<=;) |(?<=[.?!]) (?=[A-Z*])/).map(line => line.trim()).filter(Boolean);
  const count = (list: string[]) => list.reduce((map, line) => map.set(line, (map.get(line) ?? 0) + 1), new Map<string, number>());
  const old = lines(before);
  const now = lines(after);
  const spare = (from: string[], against: string[], mark: string) => {
    const left = count(against);
    return from.filter(line => { const have = left.get(line) ?? 0; if (have > 0) { left.set(line, have - 1); return false; } return true; })
      .map(line => `${mark} ${line}`);
  };
  return [...spare(old, now, '-'), ...spare(now, old, '+')];
}

/** How many captured pages carry a validator the next collection can send back (a 304 saves the download). */
function printValidators(rawDir: string): void {
  console.log('\nPages that came with a change marker (ETag or Last-Modified) in these captures:');
  for (const file of fs.readdirSync(rawDir).filter(name => name.endsWith('-sources.raw.json')).sort()) {
    try {
      const pages = (JSON.parse(fs.readFileSync(path.join(rawDir, file), 'utf8')) as { pages?: Array<{ etag?: string; lastModified?: string }> }).pages ?? [];
      console.log(`  ${file}: ${pages.length} pages, ${pages.filter(page => page.etag).length} with ETag, `
        + `${pages.filter(page => page.lastModified).length} with Last-Modified`);
    } catch {
      console.log(`  ${file}: unreadable`);
    }
  }
}

function main(): Promise<void> | void {
  const args = process.argv.slice(2);
  const beforeAt = args.indexOf('--before');
  const beforeText = beforeAt >= 0 ? args[beforeAt + 1] : undefined;
  const before = beforeText ? Date.parse(beforeText) : undefined;
  if (beforeText && !Number.isFinite(before)) throw new Error(`--before needs a date, got "${beforeText}".`);
  const named = args.filter((arg, index) => !arg.startsWith('--') && !(beforeAt >= 0 && index === beforeAt + 1))
    .flatMap(arg => arg.split(';')).map(name => name.trim()).filter(Boolean);
  const rawDir = path.join(process.cwd(), 'data', 'raw');
  const run = async () => {
    const fromR2 = args.includes('--from-r2');
    if (fromR2) await restoreNewestBundles(rawDir);
    let earlier: Map<string, CapturedPage> | undefined;
    if (fromR2 && before !== undefined) {
      const earlierDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rockygpt-earlier-raw-'));
      console.log(`\nThe pages as archived before ${new Date(before).toISOString()}:`);
      await restoreNewestBundles(earlierDir, before);
      earlier = loadCapturedPages(earlierDir);
    }
    const reference = JSON.parse(fs.readFileSync('src/reference/directory-contacts.json', 'utf8')) as unknown;
    const entries = (Array.isArray(reference) ? reference
      : Object.values(reference as Record<string, unknown>).filter(Array.isArray).flat()) as Array<{ name?: string }>;
    const pages: Map<string, CapturedPage> = loadCapturedPages(rawDir);
    // The same check the publish runs, over every completed office review, on these captures.
    const review = JSON.parse(fs.readFileSync('src/reference/office-contact-review.json', 'utf8')) as { offices: Array<{ name: string }> };
    const check = checkCompletedOfficeReviews(review.offices.map(office => office.name), buildStructuredDirectoryContacts([], pages));
    const names = named.length ? named : check.changed.map(office => office.name);
    for (const name of names) {
      const entry = entries.find(item => item.name === name);
      if (!entry) throw new Error(`No reviewed contact named "${name}".`);
      console.log(`\n\n# ${name}`);
      let changed = 0;
      const shownPages = new Set<string>();
      for (const item of reviewedSections(entry)) {
        const found = evidenceText(cited(item), pages, { wholeSection: true });
        if ('reason' in found) {
          changed += 1;
          console.log(`\n## MISSING ${item.url} ${place(item)}: ${found.reason}`);
          console.log(`cited by ${item.uses.join(', ')}`);
          const was = earlier && evidenceText(cited(item), earlier, { wholeSection: true });
          if (was && 'text' in was) console.log(`----- the section as last archived before the change -----\n${was.text}\n----- end -----`);
          // A renamed heading keeps its text: show the page as it reads now, once.
          const page = pages.get(pageKey(item.url));
          if (page && !shownPages.has(pageKey(item.url))) {
            shownPages.add(pageKey(item.url));
            console.log(`----- every section of the page now (captured ${page.fetchedAt}) -----`);
            for (const section of page.sections) console.log(`### "${section.heading}" sha256 ${contactSectionHash(`${section.heading}\n${section.text}`)}\n${section.text}\n`);
            console.log('----- end -----');
          }
          continue;
        }
        if (!item.hashes.size) continue;
        const now = contactSectionHash(found.text);
        // An exclusion with a `near` phrase was reviewed as the short window after it, not the rest of the section.
        const window = evidenceText(cited(item), pages);
        const accepted = new Set([now, ...('text' in window ? [contactSectionHash(window.text)] : [])]);
        if ([...item.hashes].every(hash => accepted.has(hash))) continue;
        changed += 1;
        console.log(`\n## CHANGED ${item.url} ${place(item)} (captured ${pages.get(pageKey(item.url))?.fetchedAt})`);
        console.log(`reviewed sha256: ${[...item.hashes].join(', ')}`);
        console.log(`current  sha256: ${now}`);
        console.log(`cited by ${item.uses.length} review entr${item.uses.length === 1 ? 'y' : 'ies'}`);
        const was = earlier && evidenceText(cited(item), earlier, { wholeSection: true });
        if (was && 'text' in was) {
          const wasHash = contactSectionHash(was.text);
          console.log(`earlier  sha256: ${wasHash}${item.hashes.has(wasHash) ? ' (the reviewed text)' : ' (not the reviewed text)'}`);
          console.log('----- lines only in the earlier text (-) and only in the current text (+) -----');
          console.log(changedLines(was.text, found.text).join('\n') || '(the same lines; only spacing or order changed)');
        }
        console.log('----- current section text -----');
        console.log(found.text);
        console.log('----- end -----');
      }
      console.log(changed ? `\n${changed} reviewed section(s) of ${name} changed.` : `\nEvery reviewed section of ${name} still matches.`);
    }
    console.log('\n\n# The publish gate on these captures');
    for (const office of check.toReview) console.log(`Needs another review (not blocking): ${office}`);
    for (const office of check.changed) {
      console.log(`Published with facts left out until reviewed again: ${office.name}`);
      for (const line of office.leftOut) console.log(`  - ${line}`);
    }
    for (const office of check.blocking) console.log(`BLOCKS PUBLISH: ${office}`);
    console.log(check.blocking.length ? `\nThe publish would stop: ${check.blocking.length} office(s).`
      : `\nThe office review gate passes${check.changed.length ? `, leaving out facts of ${check.changed.length} office(s)` : ''}.`);
    if (fromR2) printValidators(rawDir);
    if (check.blocking.length) process.exitCode = 1;
  };
  return run();
}

if (process.argv[1]?.endsWith('show-changed-sections.ts')) {
  Promise.resolve(main()).catch(error => { console.error(error instanceof Error ? error.message : error); process.exit(1); });
}
