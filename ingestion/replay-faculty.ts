import { assertFacultyProfileCoverage, parseFacultyProfileHtml, parseLibraryStaffHtml } from './faculty-profile-parser';
import { type FacultyProfile, validateFacultyProfiles } from './schema';
import { createHash } from 'node:crypto';

export interface FacultySourcePage {
  requestedUrl: string;
  url: string;
  role: 'profile' | 'school' | 'library';
  school?: string;
  fetchedAt: string;
  status: number;
  contentHash: string;
  html: string;
}
export interface FacultySourceCapture { schemaVersion: 1; pages: FacultySourcePage[] }
const key = (value: string): string => value.replace(/\/$/, '');

/** Replay original pages without a fetch or a new collection timestamp. The raw
 * rows retain listing-only identities and local image paths from the collector.
 */
export function replayFacultySources(raw: unknown, sources: FacultySourceCapture): FacultyProfile[] {
  if (sources?.schemaVersion !== 1 || !Array.isArray(sources.pages)) throw new Error('Invalid faculty source capture');
  const profiles = validateFacultyProfiles(raw);
  const library = new Map<string, FacultyProfile[]>();
  const result = profiles.map(previous => {
    const page = sources.pages.find(candidate => key(candidate.requestedUrl) === key(previous.profileUrl)
      || key(candidate.url) === key(previous.profileUrl));
    if (!page || page.status !== 200 || typeof page.html !== 'string'
      || !Number.isFinite(Date.parse(page.fetchedAt))
      || createHash('sha256').update(page.html).digest('hex') !== page.contentHash) {
      throw new Error(`Missing or invalid successful faculty capture: ${previous.profileUrl}`);
    }
    let parsed: FacultyProfile | null | undefined;
    if (page.role === 'profile') {
      const result = parseFacultyProfileHtml(page.html, previous.profileUrl, page.school || previous.school);
      assertFacultyProfileCoverage(result);
      parsed = result.profile;
    } else if (page.role === 'library') {
      if (!library.has(page.url)) library.set(page.url, validateFacultyProfiles(parseLibraryStaffHtml(page.html, previous.profileUrl)));
      parsed = library.get(page.url)?.find(candidate => candidate.name === previous.name);
    } else {
      // School-listing-only rows are extracted by the collector from this page.
      return previous;
    }
    if (!parsed) throw new Error(`Faculty profile not found in captured page: ${previous.name}`);
    return { ...parsed, ...(previous.imagePath ? { imagePath: previous.imagePath } : {}) };
  });
  const validated = validateFacultyProfiles(result);
  if (validated.length !== profiles.length) throw new Error('Faculty replay changed profile count; review source identities');
  return validated;
}
