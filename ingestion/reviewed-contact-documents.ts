/** Original PDF evidence for reviewed contacts, with offline text extraction. */
import path from 'node:path';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import { PDFParse } from 'pdf-parse';
import { OFFICE_DIRECTORY_CONTACTS, OTHER_DIRECTORY_CONTACTS } from '../src/directory/static-contacts';
import { fetchWithPolicy } from './http-client';
import { writeJsonFile, writeRawProvenance } from './pipeline-utils';
import { type RawDatasetV1, type RawPageV1, validateRawDatasetV1 } from './raw-types';

const DATASET = 'reviewed-contact-documents';
const MAX_PDF_BYTES = 12 * 1024 * 1024;

type EvidenceRef = { url: string };
type ContactDocumentRefs = {
  evidence: EvidenceRef[];
  notPublished?: { evidence: EvidenceRef[] }[];
  additionalContacts?: { evidence: EvidenceRef[] }[];
  contactConflicts?: { evidence: EvidenceRef[] }[];
  contactNotes?: { evidence: EvidenceRef }[];
  preferredContact?: { evidence: EvidenceRef };
};

function contactUrls(entry: ContactDocumentRefs): string[] {
  return [
    ...entry.evidence.map(ref => ref.url),
    ...(entry.notPublished ?? []).flatMap(item => item.evidence.map(ref => ref.url)),
    ...(entry.additionalContacts ?? []).flatMap(item => item.evidence.map(ref => ref.url)),
    ...(entry.contactConflicts ?? []).flatMap(item => item.evidence.map(ref => ref.url)),
    ...(entry.contactNotes ?? []).map(item => item.evidence.url),
    ...(entry.preferredContact ? [entry.preferredContact.evidence.url] : []),
  ];
}

function isPdfUrl(value: string): boolean {
  return /\.pdf$/i.test(new URL(value).pathname);
}

/** Only official campus sites and the campus's referred Health Services provider. */
function officialUrl(value: string): string {
  const parsed = new URL(value);
  const host = parsed.hostname.toLowerCase();
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port
    || !(host === 'ramapo.edu' || host.endsWith('.ramapo.edu')
      || host === 'valleyhealth.com' || host === 'www.valleyhealth.com')) {
    throw new Error(`Reviewed contact PDF URL is not an allowed official source: ${value}`);
  }
  parsed.hash = '';
  return parsed.toString();
}

export const REVIEWED_CONTACT_DOCUMENT_URLS = [...new Set([
  ...OFFICE_DIRECTORY_CONTACTS.flatMap(contactUrls),
  ...OTHER_DIRECTORY_CONTACTS.flatMap(contactUrls),
].filter(isPdfUrl).map(officialUrl))].sort();

export interface ReviewedContactDocumentSourceV1 {
  requestedUrl: string;
  url: string;
  sourceType: 'seed';
  fetchedAt: string;
  statusCode: number;
  contentType: string;
  /** SHA-256 of original response bytes, before compression or text extraction. */
  contentHash: string;
  /** Original PDF response bytes, gzip-compressed and base64-encoded. Never HTML. */
  pdfGzip: string;
}

export interface ReviewedContactDocumentCaptureV1 {
  schemaVersion: 1;
  dataset: 'reviewed-contact-documents';
  generatedAt: string;
  collectionSucceeded: boolean;
  seedUrls: string[];
  pages: ReviewedContactDocumentSourceV1[];
}

function originalPdf(source: ReviewedContactDocumentSourceV1): Uint8Array {
  officialUrl(source.requestedUrl);
  officialUrl(source.url);
  if (source.sourceType !== 'seed' || source.statusCode !== 200
    || !Number.isFinite(Date.parse(source.fetchedAt))
    || !/^application\/pdf(?:\s*;|$)/i.test(source.contentType)
    || typeof source.pdfGzip !== 'string' || source.pdfGzip.length > MAX_PDF_BYTES * 2) {
    throw new Error(`Invalid reviewed contact PDF source: ${source.requestedUrl}`);
  }
  const bytes = gunzipSync(Buffer.from(source.pdfGzip, 'base64'), { maxOutputLength: MAX_PDF_BYTES });
  if (!bytes.subarray(0, 5).equals(Buffer.from('%PDF-'))
    || createHash('sha256').update(bytes).digest('hex') !== source.contentHash) {
    throw new Error(`Reviewed contact PDF bytes or hash mismatch: ${source.requestedUrl}`);
  }
  // PDF.js may transfer its input buffer. Return a fresh array, never retained storage.
  return Uint8Array.from(bytes);
}

async function parseDocument(source: ReviewedContactDocumentSourceV1): Promise<RawPageV1> {
  const parser = new PDFParse({ data: originalPdf(source) });
  try {
    const result = await parser.getText();
    if (!result.text.trim()) throw new Error(`Reviewed contact PDF has no extractable text: ${source.requestedUrl}`);
    return {
      // The evidence registry cites the requested URL; retain redirect destination below.
      url: source.requestedUrl,
      sourceType: 'seed',
      fetchedAt: source.fetchedAt,
      statusCode: source.statusCode,
      title: null,
      links: [],
      externalLinks: [],
      sections: [{ heading: 'PDF text', text: result.text }],
      lists: [],
      tables: [],
      contacts: [],
      documents: [{ label: 'Source PDF', url: source.url }],
    };
  } finally {
    await parser.destroy();
  }
}

/** Re-extract retained PDF bytes without network access, writes or newer timestamps. */
export async function replayReviewedContactDocuments(
  capture: ReviewedContactDocumentCaptureV1,
): Promise<RawDatasetV1> {
  if (capture?.schemaVersion !== 1 || capture.dataset !== DATASET
    || capture.collectionSucceeded !== true || !Number.isFinite(Date.parse(capture.generatedAt))
    || !Array.isArray(capture.seedUrls) || !Array.isArray(capture.pages)) {
    throw new Error('Invalid or incomplete reviewed contact PDF source capture');
  }
  const seeds = capture.seedUrls.map(officialUrl);
  const requested = capture.pages.map(page => officialUrl(page.requestedUrl));
  if (new Set(seeds).size !== seeds.length || new Set(requested).size !== requested.length
    || seeds.length !== requested.length || seeds.some(seed => !requested.includes(seed))) {
    throw new Error('Reviewed contact PDF source capture does not cover its seed URLs');
  }
  const pages: RawPageV1[] = [];
  for (const source of capture.pages) pages.push(await parseDocument(source));
  return validateRawDatasetV1({
    version: '1.0', dataset: DATASET, collectedAt: capture.generatedAt, seedUrls: seeds,
    stats: { pagesFetched: pages.length, pagesFailed: 0, externalLinksSeen: 0 }, pages,
  });
}

async function fetchDocument(requestedUrl: string): Promise<ReviewedContactDocumentSourceV1> {
  let target = officialUrl(requestedUrl);
  // Validate every redirect before fetching it, not only the final response host.
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    const response = await fetchWithPolicy(target, {
      redirect: 'manual', headers: { Accept: 'application/pdf' },
    }, { timeoutMs: 30_000, attempts: 2, maxResponseBytes: MAX_PDF_BYTES });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      if (!location) throw new Error(`Reviewed contact PDF redirect has no destination: ${target}`);
      target = officialUrl(new URL(location, target).toString());
      continue;
    }
    const source: ReviewedContactDocumentSourceV1 = {
      requestedUrl, url: officialUrl(response.url || target), sourceType: 'seed',
      fetchedAt: new Date().toISOString(), statusCode: response.status,
      contentType: response.headers.get('content-type') || '',
      contentHash: createHash('sha256').update(response.body).digest('hex'),
      pdfGzip: gzipSync(response.body).toString('base64'),
    };
    originalPdf(source);
    return source;
  }
  throw new Error(`Too many reviewed contact PDF redirects: ${requestedUrl}`);
}

export async function collectReviewedContactDocuments(options: {
  seedUrls?: string[];
  rawDir?: string;
} = {}): Promise<RawDatasetV1> {
  const rawDir = options.rawDir ?? path.join(process.cwd(), 'data/raw');
  const seedUrls = [...new Set((options.seedUrls ?? REVIEWED_CONTACT_DOCUMENT_URLS).map(officialUrl))].sort();
  if (seedUrls.some(seed => !isPdfUrl(seed))) throw new Error('Reviewed contact document seeds must be PDF URLs');
  const capture: ReviewedContactDocumentCaptureV1 = {
    schemaVersion: 1, dataset: DATASET, generatedAt: new Date().toISOString(),
    collectionSucceeded: false, seedUrls, pages: [],
  };
  try {
    for (const seed of seedUrls) capture.pages.push(await fetchDocument(seed));
    // Replay checks completeness and all byte hashes. Failures still retain captured PDFs below.
    const parsed = await replayReviewedContactDocuments({ ...capture, collectionSucceeded: true });
    writeJsonFile(path.join(rawDir, `${DATASET}.raw.json`), parsed);
    writeRawProvenance(DATASET, { sourceUrl: seedUrls[0], recordCount: parsed.pages.length,
      payload: parsed, fetchedAt: capture.generatedAt }, rawDir);
    capture.collectionSucceeded = true;
    return parsed;
  } finally {
    writeJsonFile(path.join(rawDir, `${DATASET}-sources.raw.json`), capture);
    writeRawProvenance(`${DATASET}-sources`, { sourceUrl: seedUrls[0], recordCount: capture.pages.length,
      payload: capture, fetchedAt: capture.generatedAt }, rawDir);
  }
}

/** Rebuild both consumer copies and their hash using the original collection instant. */
export async function normalizeReviewedContactDocuments(cwd = process.cwd()): Promise<RawDatasetV1> {
  const rawDir = path.join(cwd, 'data/raw');
  const capture = JSON.parse(fs.readFileSync(path.join(rawDir, `${DATASET}-sources.raw.json`), 'utf8')) as ReviewedContactDocumentCaptureV1;
  const parsed = await replayReviewedContactDocuments(capture);
  writeJsonFile(path.join(rawDir, `${DATASET}.raw.json`), parsed);
  writeJsonFile(path.join(cwd, 'data/normalized', `${DATASET}.json`), parsed);
  writeRawProvenance(DATASET, {
    sourceUrl: capture.seedUrls[0], recordCount: parsed.pages.length,
    payload: parsed, fetchedAt: capture.generatedAt,
  }, rawDir);
  return parsed;
}

async function run(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--replay')) {
    if (args.length !== 1) throw new Error('--replay reads retained PDF sources only; do not pass collection URLs');
    const result = await normalizeReviewedContactDocuments();
    console.log(`Replayed ${result.pages.length} reviewed contact PDF document(s) without a fetch or newer timestamps.`);
    return;
  }
  const result = await collectReviewedContactDocuments({ seedUrls: [...REVIEWED_CONTACT_DOCUMENT_URLS, ...args] });
  console.log(`Captured ${result.pages.length} reviewed contact PDF document(s).`);
}

if (process.argv[1]?.endsWith('reviewed-contact-documents.ts')) {
  run().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
