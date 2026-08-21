import path from 'path';
import { generateCore6Markdown } from './generate-core6-md-utils';

const DATA_DIR = path.join(process.cwd(), 'data', 'normalized');
const OUTPUT_DIR = path.join(process.cwd(), 'data', 'context', 'campus');

generateCore6Markdown({
  datasetName: 'directory',
  title: 'Ramapo Campus Directory',
  description:
    'Context extracted from directory and phone listing pages. Includes office/service references and published contact points when present.',
  inputFilePath: path.join(DATA_DIR, 'directory.json'),
  outputFilePath: path.join(OUTPUT_DIR, 'directory.md'),
  frontmatter: {
    source_url: 'https://www.ramapo.edu/directory/',
    title: 'Campus Directory',
    trust_tier: 'official_primary',
    freshness_sla_hours: 168,
  },
});
