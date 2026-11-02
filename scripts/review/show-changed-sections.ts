/**
 * Shows every reviewed page section of one office whose text no longer matches its review,
 * with the section's current text and hash, so a person can re-review it without downloading
 * the page again.
 *
 *   tsx scripts/review/show-changed-sections.ts "Athletics"            # pages in data/raw
 *   tsx scripts/review/show-changed-sections.ts "Athletics" --from-r2  # newest archived captures
 *
 * --from-r2 first restores the newest archived raw bundle of each source into data/raw (needs
 * the RAW_ARTIFACT_* settings the publish uses). It reads the archive only: it never fetches a
 * college page.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { downloadRawArtifactBundle, SOURCE_RAW_ARTIFACT_FILES } from '../../pipeline/raw-artifacts';
import {
  contactSectionHash, evidenceText, loadCapturedPages, pageKey, type CapturedPage,
} from '../../src/directory/contact-evidence';

interface ReviewedEntry { url: string; section: string; near?: string; reviewed?: { text_sha256: string } }
interface ReviewedSection { url: string; section: string; near?: string; hashes: Set<string>; uses: string[] }

async function restoreNewestBundles(rawDir: string): Promise<void> {
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
    if (typeof record.url === 'string' && typeof record.section === 'string' && hash) {
      const near = typeof record.near === 'string' ? record.near : undefined;
      const key = `${pageKey(record.url)}\n${record.section}\n${near ?? ''}`;
      const item = found.get(key) ?? { url: record.url, section: record.section, near, hashes: new Set<string>(), uses: [] };
      item.hashes.add(hash);
      item.uses.push(trail.join('.'));
      found.set(key, item);
    }
    for (const [key, child] of Object.entries(record)) visit(child, [...trail, key]);
  };
  visit(entry, []);
  return [...found.values()];
}

function main(): Promise<void> | void {
  const args = process.argv.slice(2);
  const name = args.find(arg => !arg.startsWith('--'));
  if (!name) throw new Error('Usage: show-changed-sections.ts "<office name>" [--from-r2]');
  const rawDir = path.join(process.cwd(), 'data', 'raw');
  const run = async () => {
    if (args.includes('--from-r2')) await restoreNewestBundles(rawDir);
    const reference = JSON.parse(fs.readFileSync('src/reference/directory-contacts.json', 'utf8')) as unknown;
    const entries = (Array.isArray(reference) ? reference
      : Object.values(reference as Record<string, unknown>).find(Array.isArray) ?? []) as Array<{ name?: string }>;
    const entry = entries.find(item => item.name === name);
    if (!entry) throw new Error(`No reviewed contact named "${name}".`);
    const pages: Map<string, CapturedPage> = loadCapturedPages(rawDir);
    let changed = 0;
    for (const item of reviewedSections(entry)) {
      const found = evidenceText({ url: item.url, section: item.section, near: item.near, fields: [] }, pages, { wholeSection: true });
      if ('reason' in found) { changed += 1; console.log(`\n## MISSING ${item.url} "${item.section}": ${found.reason}`); continue; }
      const now = contactSectionHash(found.text);
      if (item.hashes.has(now) && item.hashes.size === 1) continue;
      changed += 1;
      console.log(`\n## CHANGED ${item.url} "${item.section}" (captured ${pages.get(pageKey(item.url))?.fetchedAt})`);
      console.log(`reviewed sha256: ${[...item.hashes].join(', ')}`);
      console.log(`current  sha256: ${now}`);
      console.log(`cited by ${item.uses.length} review entr${item.uses.length === 1 ? 'y' : 'ies'}`);
      console.log('----- current section text -----');
      console.log(found.text);
      console.log('----- end -----');
    }
    console.log(changed ? `\n${changed} reviewed section(s) of ${name} changed.` : `\nEvery reviewed section of ${name} still matches.`);
  };
  return run();
}

Promise.resolve(main()).catch(error => { console.error(error instanceof Error ? error.message : error); process.exit(1); });
