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
