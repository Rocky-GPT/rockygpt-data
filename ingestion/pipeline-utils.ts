import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { execSync } from 'child_process';

function ensureParentDirectory(filePath: string): void {
  const parent = path.dirname(filePath);
  if (!fs.existsSync(parent)) {
    fs.mkdirSync(parent, { recursive: true });
  }
}

export function writeJsonFile(filePath: string, data: unknown): void {
  ensureParentDirectory(filePath);
  const temporaryPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random()
    .toString(16)
    .slice(2)}`;
  try {
    fs.writeFileSync(temporaryPath, JSON.stringify(data, null, 2), 'utf-8');
    fs.renameSync(temporaryPath, filePath);
  } finally {
    if (fs.existsSync(temporaryPath)) {
      fs.rmSync(temporaryPath, { force: true });
    }
  }
}

export function getGeneratedTimestamp(): string {
  return process.env.GENERATOR_TIMESTAMP || new Date().toISOString();
}

/**
 * Records source-native provenance next to a raw dataset (PROB-002).
 * Collectors call this immediately after a real fetch, so `fetchedAt` is the
 * actual collection instant — never a normalization or publication time.
 * The quality gates and publisher read these sidecars; a raw dataset without
 * one has unknown (not zero) age and cannot pass the enforced publish gate.
 */
export function writeRawProvenance(
  dataset: string,
  input: { sourceUrl?: string; recordCount?: number; payload: unknown; fetchedAt?: string },
  rawDir = path.join(process.cwd(), 'data', 'raw')
): void {
  writeJsonFile(path.join(rawDir, `${dataset}.provenance.json`), {
    version: 1,
    dataset,
    fetchedAt: input.fetchedAt || new Date().toISOString(),
    ...(input.sourceUrl ? { sourceUrl: input.sourceUrl } : {}),
    ...(typeof input.recordCount === 'number' ? { recordCount: input.recordCount } : {}),
    contentHash: createHash('sha256').update(JSON.stringify(input.payload)).digest('hex'),
  });
}

/**
 * Writes provenance for the exact JSON payload persisted by a collector.
 * Reading the payload back from disk prevents a transformed representation
 * from being hashed accidentally while the validator hashes the raw file.
 */
export function writeRawFileProvenance(
  dataset: string,
  rawFilePath: string,
  input: { sourceUrl?: string; recordCount?: number; fetchedAt?: string }
): void {
  const payload = JSON.parse(fs.readFileSync(rawFilePath, 'utf8')) as unknown;
  writeRawProvenance(dataset, { ...input, payload }, path.dirname(rawFilePath));
}

export function isRawOnlyMode(): boolean {
  return process.env.RAW_ONLY === '1' || process.env.RAW_ONLY === 'true';
}

export function runGeneratorScript(scriptPath: string): void {
  console.log(`Running generator: ${scriptPath}`);
  execSync(`npx tsx "${scriptPath}"`, { stdio: 'inherit' });
}

export function sortByName<T>(items: T[], nameGetter: (item: T) => string): T[] {
  return [...items].sort((a, b) => nameGetter(a).localeCompare(nameGetter(b)));
}

function inferredCollectionCount(payload: unknown): number | null {
  if (Array.isArray(payload)) return payload.length;
  if (!payload || typeof payload !== 'object') return null;
  const record = payload as Record<string, unknown>;
  if (Array.isArray(record.pages)) return record.pages.length;
  if (Array.isArray(record.programs)) return record.programs.length;
  if (Array.isArray(record.entries)) return record.entries.length;
  if (typeof record.count === 'number' && Number.isFinite(record.count)) {
    return record.count;
  }
  return null;
}

export function assertCollectionCount(input: {
  dataset: string;
  count: number;
  minimum: number;
  previousFilePath?: string;
  minimumPreviousRatio?: number;
}): void {
  if (input.count < input.minimum) {
    throw new Error(
      `${input.dataset}: collected ${input.count} records; expected at least ${input.minimum}.`
    );
  }
  if (
    !input.previousFilePath ||
    input.minimumPreviousRatio === undefined ||
    !fs.existsSync(input.previousFilePath)
  ) {
    return;
  }

  try {
    const previousPayload = JSON.parse(fs.readFileSync(input.previousFilePath, 'utf8')) as unknown;
    const previousCount = inferredCollectionCount(previousPayload);
    if (previousCount === null || previousCount <= 0) return;
    const floor = Math.ceil(previousCount * input.minimumPreviousRatio);
    if (input.count < floor) {
      throw new Error(
        `${input.dataset}: record count dropped from ${previousCount} to ${input.count}; minimum allowed is ${floor}.`
      );
    }
  } catch (error) {
    if (error instanceof Error && /record count dropped/.test(error.message)) throw error;
    console.warn(
      `${input.dataset}: previous artifact could not be used for record-count regression comparison.`
    );
  }
}
