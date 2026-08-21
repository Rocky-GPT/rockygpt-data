import path from 'path';
import { generateCore6Markdown, type ContextSection } from './generate-core6-md-utils';
import type { RawPageV1 } from './raw-types';

const DATA_DIR = path.join(process.cwd(), 'data', 'normalized');
const OUTPUT_DIR = path.join(process.cwd(), 'data', 'context', 'campus');
const VALLEY_HEALTH_HOST = 'www.valleyhealth.com';
const HEALTH_APPOINTMENT_PATH = '/save-your-spot-ramapo-college-health-services';

/**
 * Valley's appointment page is client-rendered and can yield only navigation
 * text to the raw collector. Its successful official URL still provides a
 * stable, citable action without inventing hours, availability, or policy.
 */
export function healthDerivedSections(page: RawPageV1): ContextSection[] {
  if (page.statusCode === null || page.statusCode < 200 || page.statusCode >= 400) return [];

  try {
    const url = new URL(page.url);
    const pathname = url.pathname.replace(/\/+$/, '');
    if (
      url.protocol !== 'https:' ||
      url.host !== VALLEY_HEALTH_HOST ||
      pathname !== HEALTH_APPOINTMENT_PATH
    ) {
      return [];
    }
  } catch {
    return [];
  }

  return [
    {
      heading: 'Appointments',
      text: 'Schedule a Health Services appointment through the official Save Your Spot page.',
    },
  ];
}

export function main(): void {
  generateCore6Markdown({
    datasetName: 'health',
    title: 'Ramapo Health Services',
    description:
      'Context extracted from Health Services pages. Includes care access details, procedures, forms/documents, and contact information.',
    inputFilePath: path.join(DATA_DIR, 'health.json'),
    outputFilePath: path.join(OUTPUT_DIR, 'health.md'),
    derivedSections: healthDerivedSections,
    frontmatter: {
      source_url: 'https://www.ramapo.edu/health/',
      title: 'Health Services',
      trust_tier: 'official_primary',
      freshness_sla_hours: 168,
    },
  });
}

if (process.argv[1]?.endsWith('generate-health-md.ts')) main();
