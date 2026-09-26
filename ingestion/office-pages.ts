/**
 * office-pages.ts
 *
 * Every page of Ramapo's student office sites: Financial Aid, Student Accounts, the
 * Registrar, the Testing Center, Title IX and the others src/reference/office-sites.json
 * names by their folders on www.ramapo.edu. folder-sites.ts reads each office's sitemap
 * and collects its pages, one a second.
 *
 * Run: npm run fetch:office-pages (after the other Ramapo site collectors)
 */

import path from 'path';
import { collectFolderSites, type FolderSiteSource, RAMAPO_SITE_COLLECTORS } from './folder-sites';

/** Post types the office sites publish that are not office information, and why. */
export const SKIPPED_POST_TYPES: Readonly<Record<string, string>> = {
  post: 'dated news posts: the newest is from 2025 and most are CSI weekend event lists from 2013 to 2019',
  recipient: 'a page about one student who received a scholarship',
  peers: 'a profile of one student peer facilitator',
  'success-story': "one student's own study abroad story",
  tribe_venue: "the event calendar's venue listings",
  tribe_organizer: "the event calendar's organizer listings",
};

export const OFFICE_PAGES: FolderSiteSource = {
  dataset: 'office-pages',
  sitesPath: path.join(process.cwd(), 'src', 'reference', 'office-sites.json'),
  skippedPostTypes: SKIPPED_POST_TYPES,
  collectedElsewhere: RAMAPO_SITE_COLLECTORS,
};

if (process.argv[1]?.endsWith('office-pages.ts')) {
  collectFolderSites(OFFICE_PAGES).catch(error => { console.error('Fatal:', error); process.exitCode = 1; });
}
