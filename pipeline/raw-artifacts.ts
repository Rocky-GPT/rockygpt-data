import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

/** Every raw input that can influence one published source snapshot. */
export const SOURCE_RAW_ARTIFACT_FILES: Record<string, string[]> = {
  'public-safety': ['safety.raw.json'],
  'academic-calendar': ['calendar.raw.json'],
  dining: ['menu.raw.json', 'menu-week.raw.json', 'dining-hours.raw.json'],
  'campus-hours': ['hours.raw.json'],
  'archway-events': [
    'events.raw.json',
    'events-detail.raw.json',
    'events-signals.raw.json',
  ],
  'archway-clubs': ['clubs.raw.json', 'clubs-detail.raw.json'],
  'academic-programs': ['catalog-programs-api.raw.json'],
  'campus-directory': ['directory.raw.json'],
  transportation: ['transportation.raw.json'],
  housing: ['housing.raw.json'],
  health: ['health.raw.json'],
  counseling: ['counseling.raw.json'],
  faculty: ['faculty.raw.json'],
};

export interface ArchivedRawArtifact {
  sourceKey: string;
  rawHash: string;
  rawUri: string | null;
  objectKey: string | null;
  stored: boolean;
  compressedBytes: number;
}

export interface RawBundleEntry {
  file: string;
  sha256: string;
  content: unknown;
}

export interface RawArtifactBundleEnvelope {
  version: 1;
  sourceKey: string;
  entries: RawBundleEntry[];
}

function parseRawFile(filePath: string): unknown {
  const text = fs.readFileSync(filePath, 'utf8');
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

export function buildRawArtifactBundle(
  sourceKey: string,
  rawDir = path.join(process.cwd(), 'data', 'raw')
): { body: Buffer; rawHash: string; files: string[] } | null {
  const configured = SOURCE_RAW_ARTIFACT_FILES[sourceKey] || [];
  const entries: RawBundleEntry[] = configured.flatMap((file) => {
    const fullPath = path.join(rawDir, file);
    if (!fs.existsSync(fullPath)) return [];
    const bytes = fs.readFileSync(fullPath);
    return [{
      file,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      content: parseRawFile(fullPath),
    }];
  });
  if (!entries.length) return null;

  const envelope = Buffer.from(
    JSON.stringify({ version: 1, sourceKey, entries } satisfies RawArtifactBundleEnvelope),
    'utf8'
  );
  return {
    body: gzipSync(envelope, { level: 9 }),
    rawHash: crypto.createHash('sha256').update(envelope).digest('hex'),
    files: entries.map((entry) => entry.file),
  };
}

function objectClient(bucketOverride?: string): { client: S3Client; bucket: string } | null {
  const bucket = bucketOverride || process.env.RAW_ARTIFACT_BUCKET;
  if (!bucket) return null;

  const accessKeyId = process.env.RAW_ARTIFACT_ACCESS_KEY_ID;
  const secretAccessKey = process.env.RAW_ARTIFACT_SECRET_ACCESS_KEY;
  const explicitCredentials = accessKeyId && secretAccessKey
    ? { accessKeyId, secretAccessKey }
    : undefined;
  return {
    bucket,
    client: new S3Client({
      region: process.env.RAW_ARTIFACT_REGION || 'us-east-1',
      endpoint: process.env.RAW_ARTIFACT_ENDPOINT || undefined,
      forcePathStyle: process.env.RAW_ARTIFACT_FORCE_PATH_STYLE === '1',
      credentials: explicitCredentials,
    }),
  };
}

function parseRawArtifactUri(rawUri: string): { bucket: string; objectKey: string } {
  const parsed = new URL(rawUri);
  if (parsed.protocol !== 's3:' || !parsed.hostname) {
    throw new Error(`Unsupported raw artifact URI: ${rawUri}`);
  }
  const objectKey = decodeURIComponent(parsed.pathname.replace(/^\/+/, ''));
  if (!objectKey) {
    throw new Error(`Raw artifact URI has no object key: ${rawUri}`);
  }
  return { bucket: parsed.hostname, objectKey };
}

export function decodeRawArtifactBundle(
  compressedBody: Uint8Array,
  expectedRawHash?: string
): RawArtifactBundleEnvelope {
  const envelopeBytes = gunzipSync(compressedBody);
  const actualHash = crypto.createHash('sha256').update(envelopeBytes).digest('hex');
  if (expectedRawHash && actualHash !== expectedRawHash) {
    throw new Error(
      `Raw artifact hash mismatch: expected ${expectedRawHash}, received ${actualHash}.`
    );
  }

  const parsed = JSON.parse(envelopeBytes.toString('utf8')) as Partial<RawArtifactBundleEnvelope>;
  if (
    parsed.version !== 1 ||
    typeof parsed.sourceKey !== 'string' ||
    !Array.isArray(parsed.entries)
  ) {
    throw new Error('Raw artifact bundle has an invalid envelope.');
  }
  for (const entry of parsed.entries) {
    if (
      !entry ||
      typeof entry.file !== 'string' ||
      typeof entry.sha256 !== 'string' ||
      !Object.prototype.hasOwnProperty.call(entry, 'content')
    ) {
      throw new Error('Raw artifact bundle contains an invalid entry.');
    }
  }
  return parsed as RawArtifactBundleEnvelope;
}

export async function downloadRawArtifactBundle(
  rawUri: string,
  expectedRawHash?: string
): Promise<RawArtifactBundleEnvelope> {
  const { bucket, objectKey } = parseRawArtifactUri(rawUri);
  const storage = objectClient(bucket);
  if (!storage) {
    throw new Error('Raw artifact storage is not configured.');
  }
  const response = await storage.client.send(
    new GetObjectCommand({ Bucket: bucket, Key: objectKey })
  );
  if (!response.Body) {
    throw new Error(`Raw artifact object is empty: ${rawUri}`);
  }
  const bytes = await response.Body.transformToByteArray();
  return decodeRawArtifactBundle(bytes, expectedRawHash);
}

export async function archiveSourceRawArtifact(
  sourceKey: string,
  collectedAt: string,
  rawDir?: string
): Promise<ArchivedRawArtifact | null> {
  const bundle = buildRawArtifactBundle(sourceKey, rawDir);
  if (!bundle) return null;

  const storage = objectClient();
  if (!storage) {
    if (process.env.RAW_ARTIFACT_REQUIRED === '1') {
      throw new Error('RAW_ARTIFACT_BUCKET is required for publication.');
    }
    return {
      sourceKey,
      rawHash: bundle.rawHash,
      rawUri: null,
      objectKey: null,
      stored: false,
      compressedBytes: bundle.body.byteLength,
    };
  }

  const safeTimestamp = new Date(collectedAt).toISOString().replace(/[:.]/g, '-');
  const objectKey = `raw/${sourceKey}/${safeTimestamp}/${bundle.rawHash}.json.gz`;
  await storage.client.send(new PutObjectCommand({
    Bucket: storage.bucket,
    Key: objectKey,
    Body: bundle.body,
    ContentType: 'application/json',
    ContentEncoding: 'gzip',
    Metadata: {
      'rockygpt-source': sourceKey,
      'rockygpt-sha256': bundle.rawHash,
      'rockygpt-files': String(bundle.files.length),
    },
  }));

  return {
    sourceKey,
    rawHash: bundle.rawHash,
    rawUri: `s3://${storage.bucket}/${objectKey}`,
    objectKey,
    stored: true,
    compressedBytes: bundle.body.byteLength,
  };
}
