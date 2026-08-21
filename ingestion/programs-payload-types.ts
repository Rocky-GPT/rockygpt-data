export const PROGRAM_PAYLOAD_EXTRACTION_STATUSES = [
  'ok',
  'missing-html',
  'missing-nuxt',
  'eval-error',
  'missing-program',
] as const;

export type ProgramPayloadExtractionStatus = (typeof PROGRAM_PAYLOAD_EXTRACTION_STATUSES)[number];

export interface ProgramPayloadEntryV1 {
  url: string;
  fetchedAt: string;
  statusCode: number | null;
  title: string | null;
  school?: string;
  activeCatalog?: string;
  extractionStatus: ProgramPayloadExtractionStatus;
  extractionError?: string;
  program?: Record<string, unknown>;
}

export interface ProgramsPayloadRawV1 {
  version: '1.0';
  dataset: 'programs-payload';
  collectedAt: string;
  seedUrls: string[];
  stats: {
    pagesProcessed: number;
    payloadsExtracted: number;
    extractionFailed: number;
    payloadParseSuccessRate: number;
  };
  entries: ProgramPayloadEntryV1[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function asStringArray(value: unknown, path: string): string[] {
  assert(Array.isArray(value), `${path} must be an array`);
  value.forEach((entry, index) => {
    assert(typeof entry === 'string', `${path}[${index}] must be a string`);
  });
  return value as string[];
}

function asOptionalString(value: unknown, path: string): string | undefined {
  if (value === undefined) return undefined;
  assert(typeof value === 'string', `${path} must be a string when present`);
  return value;
}

function asOptionalProgramRecord(value: unknown, path: string): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  assert(isRecord(value), `${path} must be an object when present`);
  return value;
}

function validateEntry(input: unknown, index: number): ProgramPayloadEntryV1 {
  const base = `entries[${index}]`;
  assert(isRecord(input), `${base} must be an object`);

  assert(typeof input.url === 'string', `${base}.url must be a string`);
  assert(typeof input.fetchedAt === 'string', `${base}.fetchedAt must be a string`);
  assert(
    input.statusCode === null || (typeof input.statusCode === 'number' && Number.isFinite(input.statusCode)),
    `${base}.statusCode must be a number or null`
  );
  assert(input.title === null || typeof input.title === 'string', `${base}.title must be a string or null`);

  const validStatuses = new Set<ProgramPayloadEntryV1['extractionStatus']>(PROGRAM_PAYLOAD_EXTRACTION_STATUSES);
  assert(
    typeof input.extractionStatus === 'string' && validStatuses.has(input.extractionStatus as ProgramPayloadEntryV1['extractionStatus']),
    `${base}.extractionStatus must be one of: ${Array.from(validStatuses).join(', ')}`
  );

  const output: ProgramPayloadEntryV1 = {
    url: input.url,
    fetchedAt: input.fetchedAt,
    statusCode: input.statusCode,
    title: input.title,
    extractionStatus: input.extractionStatus as ProgramPayloadEntryV1['extractionStatus'],
  };

  const school = asOptionalString(input.school, `${base}.school`);
  if (school !== undefined) output.school = school;

  const activeCatalog = asOptionalString(input.activeCatalog, `${base}.activeCatalog`);
  if (activeCatalog !== undefined) output.activeCatalog = activeCatalog;

  const extractionError = asOptionalString(input.extractionError, `${base}.extractionError`);
  if (extractionError !== undefined) output.extractionError = extractionError;

  const program = asOptionalProgramRecord(input.program, `${base}.program`);
  if (program !== undefined) output.program = program;

  if (output.extractionStatus === 'ok') {
    assert(output.program !== undefined, `${base}.program is required when extractionStatus is ok`);
  }

  return output;
}

export function validateProgramsPayloadRawV1(input: unknown): ProgramsPayloadRawV1 {
  assert(isRecord(input), 'program payload dataset must be an object');
  assert(input.version === '1.0', 'program payload dataset.version must be 1.0');
  assert(input.dataset === 'programs-payload', "program payload dataset.dataset must be 'programs-payload'");
  assert(typeof input.collectedAt === 'string', 'program payload dataset.collectedAt must be a string');

  const seedUrls = asStringArray(input.seedUrls, 'program payload dataset.seedUrls');

  assert(isRecord(input.stats), 'program payload dataset.stats must be an object');
  assert(typeof input.stats.pagesProcessed === 'number', 'program payload dataset.stats.pagesProcessed must be a number');
  assert(typeof input.stats.payloadsExtracted === 'number', 'program payload dataset.stats.payloadsExtracted must be a number');
  assert(typeof input.stats.extractionFailed === 'number', 'program payload dataset.stats.extractionFailed must be a number');
  assert(
    typeof input.stats.payloadParseSuccessRate === 'number',
    'program payload dataset.stats.payloadParseSuccessRate must be a number'
  );
  assert(
    input.stats.payloadParseSuccessRate >= 0 && input.stats.payloadParseSuccessRate <= 1,
    'program payload dataset.stats.payloadParseSuccessRate must be between 0 and 1'
  );

  assert(Array.isArray(input.entries), 'program payload dataset.entries must be an array');
  const entries = input.entries.map((entry, index) => validateEntry(entry, index));
  assert(
    input.stats.pagesProcessed === entries.length,
    'program payload dataset.stats.pagesProcessed must equal entries.length'
  );
  assert(
    input.stats.payloadsExtracted + input.stats.extractionFailed === input.stats.pagesProcessed,
    'program payload dataset.stats.payloadsExtracted + extractionFailed must equal pagesProcessed'
  );
  const computedSuccessRate =
    entries.length === 0
      ? 0
      : entries.filter((entry) => entry.extractionStatus === 'ok').length / entries.length;
  assert(
    Math.abs(input.stats.payloadParseSuccessRate - computedSuccessRate) <= 0.001,
    'program payload dataset.stats.payloadParseSuccessRate must match entries-derived success rate'
  );

  return {
    version: '1.0',
    dataset: 'programs-payload',
    collectedAt: input.collectedAt,
    seedUrls,
    stats: {
      pagesProcessed: input.stats.pagesProcessed,
      payloadsExtracted: input.stats.payloadsExtracted,
      extractionFailed: input.stats.extractionFailed,
      payloadParseSuccessRate: input.stats.payloadParseSuccessRate,
    },
    entries,
  };
}
