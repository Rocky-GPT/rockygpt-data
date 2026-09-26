/**
 * generate-office-pages-md.ts
 *
 * One context document per student office site, titled with the office's name, so every
 * passage's heading path names the office it came from (folder-sites.ts siteDocuments).
 * Reads data/normalized/office-pages.json, which normalize:raw replays from the captured HTML.
 *
 * Run: npm run generate:office-pages:md
 */

import path from 'path';
import { writeSiteDocuments } from './folder-sites';
import { OFFICE_PAGES } from './office-pages';

if (process.argv[1]?.endsWith('generate-office-pages-md.ts')) {
  writeSiteDocuments(OFFICE_PAGES, path.join(process.cwd(), 'data', 'context', 'campus', 'offices'));
}
