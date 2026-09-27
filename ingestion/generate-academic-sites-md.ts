/**
 * generate-academic-sites-md.ts
 *
 * One context document per school, program, department or center site, titled with the
 * site's name, so every passage's heading path names the site it came from (folder-sites.ts
 * siteDocuments). Reads data/normalized/academic-sites.json, which normalize:raw replays from
 * the captured HTML.
 *
 * Run: npm run generate:academic-sites:md
 */

import path from 'path';
import { ACADEMIC_SITES } from './academic-sites';
import { writeSiteDocuments } from './folder-sites';

if (process.argv[1]?.endsWith('generate-academic-sites-md.ts')) {
  writeSiteDocuments(ACADEMIC_SITES, path.join(process.cwd(), 'data', 'context', 'academic', 'sites'));
}
