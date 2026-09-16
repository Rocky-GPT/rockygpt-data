import path from 'path';
import { generateCore6Markdown } from './generate-core6-md-utils';

const INPUT_FILE_PATH = path.join(process.cwd(), 'data/normalized/housing.json');
const OUTPUT_FILE_PATH = path.join(process.cwd(), 'data/context/campus/housing.md');

generateCore6Markdown({
  datasetName: 'housing',
  title: 'Ramapo Housing and Residence Life',
  description:
    'Context extracted from Residence Life pages. Includes housing policies, residence resources, operational details, and support contacts.',
  inputFilePath: INPUT_FILE_PATH,
  outputFilePath: OUTPUT_FILE_PATH,
  frontmatter: {
    source_url: 'https://www.ramapo.edu/reslife/',
    title: 'Housing and Residence Life',
    trust_tier: 'official_primary',
    freshness_sla_hours: 168,
  },
});
