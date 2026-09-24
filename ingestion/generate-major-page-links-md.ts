import path from 'path';
import { generateCore6Markdown } from './generate-core6-md-utils';

const INPUT_FILE_PATH = path.join(process.cwd(), 'data/normalized/major-page-links.json');
const OUTPUT_FILE_PATH = path.join(process.cwd(), 'data/context/academic/major-page-links.md');

generateCore6Markdown({
  datasetName: 'major-page-links',
  title: 'Related Ramapo College Pages',
  description: 'Ramapo pages that the college\'s program pages link to, collected one link away from those pages.',
  inputFilePath: INPUT_FILE_PATH,
  outputFilePath: OUTPUT_FILE_PATH,
  frontmatter: {
    source_url: 'https://www.ramapo.edu/majors-minors/',
    title: 'Related Ramapo College Pages',
    trust_tier: 'official_primary',
    freshness_sla_hours: 4320,
  },
});
