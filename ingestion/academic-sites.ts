/**
 * academic-sites.ts
 *
 * Every page of Ramapo's academic school, program, department and center sites: the four
 * schools, the graduate programs, Nursing, Social Work, Teacher Education, the Center for
 * Holocaust and Genocide Studies and the others src/reference/academic-sites.json names by
 * their folders on www.ramapo.edu. folder-sites.ts reads each site's sitemap and collects
 * its pages, one a second.
 *
 * Pages the office sites keep are left alone too, so this runs after fetch:office-pages.
 *
 * Run: npm run fetch:academic-sites (after fetch:office-pages)
 */

import path from 'path';
import { collectFolderSites, type FolderSiteSource, RAMAPO_SITE_COLLECTORS } from './folder-sites';

/** Post types the academic sites publish that are not the site's own information, and why. */
export const SKIPPED_POST_TYPES: Readonly<Record<string, string>> = {
  post: 'dated news posts: faculty publications, student awards, advisory board members and past events',
  faculty: 'a faculty profile or the faculty list: the faculty source keeps every school\'s faculty and is the authority for them',
  tribe_venue: "the event calendar's venue listings",
  tribe_organizer: "the event calendar's organizer listings",
  tribe_event_series: "the event calendar's series pages, mostly past productions; each coming performance has its own event page",
};

export const ACADEMIC_SITES: FolderSiteSource = {
  dataset: 'academic-sites',
  sitesPath: path.join(process.cwd(), 'src', 'reference', 'academic-sites.json'),
  skippedPostTypes: SKIPPED_POST_TYPES,
  collectedElsewhere: [
    ...RAMAPO_SITE_COLLECTORS,
    { file: 'office-pages.raw.json', list: 'pages', fields: ['url'] },
  ],
};

if (process.argv[1]?.endsWith('academic-sites.ts')) {
  collectFolderSites(ACADEMIC_SITES).catch(error => { console.error('Fatal:', error); process.exitCode = 1; });
}
