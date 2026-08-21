import path from 'path';
import { generateCore6Markdown } from './generate-core6-md-utils';

const DATA_DIR = path.join(process.cwd(), 'data', 'normalized');
const OUTPUT_DIR = path.join(process.cwd(), 'data', 'context', 'campus');

generateCore6Markdown({
  datasetName: 'counseling',
  title: 'Ramapo Counseling Services',
  description:
    'Context extracted from Counseling Services pages. Includes support services, access guidance, wellness resources, and contacts.',
  inputFilePath: path.join(DATA_DIR, 'counseling.json'),
  outputFilePath: path.join(OUTPUT_DIR, 'counseling.md'),
  frontmatter: {
    source_url: 'https://www.ramapo.edu/counseling/',
    title: 'Counseling Services',
    trust_tier: 'official_primary',
    freshness_sla_hours: 168,
  },
});
