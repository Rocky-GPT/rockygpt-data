import path from 'path';
import { generateCore6Markdown } from './generate-core6-md-utils';

const DATA_DIR = path.join(process.cwd(), 'data', 'normalized');
const OUTPUT_DIR = path.join(process.cwd(), 'data', 'context', 'campus');

generateCore6Markdown({
  datasetName: 'safety',
  title: 'Ramapo Public Safety',
  description:
    'Context extracted from Public Safety pages. Includes emergency guidance, parking/public safety procedures, and safety contact channels.',
  inputFilePath: path.join(DATA_DIR, 'safety.json'),
  outputFilePath: path.join(OUTPUT_DIR, 'safety.md'),
  frontmatter: {
    source_url: 'https://www.ramapo.edu/publicsafety/',
    title: 'Public Safety',
    trust_tier: 'official_primary',
    freshness_sla_hours: 168,
  },
});
