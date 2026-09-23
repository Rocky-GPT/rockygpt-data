import { createHash } from 'node:crypto';
import { assertFacultyProfileCoverage, parseFacultyProfileHtml, parseLibraryStaffHtml } from '../../ingestion/faculty-profile-parser';
import { validateFacultyProfiles } from '../../ingestion/schema';
import { load } from 'cheerio';

type Row = Record<string, unknown>;
const row = (value: unknown): value is Row => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const text = (value: unknown): string => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
const key = (value: unknown): string => text(value).replace(/\/$/, '');
const fields = ['education', 'courses', 'teachingInterests', 'researchInterests', 'publishedResearch'] as const;

/** Compare publishable facts with retained source pages, not merely with parsed raw JSON.
 * Empty source sections are allowed. A supplied entry may not disappear downstream.
 */
export function facultyCoverageErrors(normalized: unknown, capture: unknown): string[] {
  if (!Array.isArray(normalized) || !row(capture) || capture.schemaVersion !== 1 || !Array.isArray(capture.pages)) {
    return ['Faculty coverage requires normalized profiles and a versioned source-page capture.'];
  }
  const errors: string[] = [];
  const pages = capture.pages.filter(row);
  const profiles = normalized.filter(row);
  for (const profile of profiles) {
    const page = pages.find(p => key(p.requestedUrl) === key(profile.profileUrl) || key(p.url) === key(profile.profileUrl));
    if (!page) errors.push(`Faculty source capture missing: ${text(profile.name)} (${text(profile.profileUrl)})`);
  }
  for (const page of pages) {
    const url = text(page.requestedUrl || page.url);
    if (page.status !== 200 || typeof page.html !== 'string' || !Number.isFinite(Date.parse(text(page.fetchedAt)))
      || createHash('sha256').update(typeof page.html === 'string' ? page.html : '').digest('hex') !== page.contentHash) {
      errors.push(`Faculty source capture is invalid: ${url}`);
      continue;
    }
    if (page.role === 'library') {
      const expected = validateFacultyProfiles(parseLibraryStaffHtml(page.html as string, url));
      for (const staff of expected) {
        const actual = profiles.filter(p => text(p.name) === staff.name && key(p.profileUrl) === key(url));
        if (actual.length !== 1 || ['email', 'phone', 'office', 'bio'].some(field =>
          text(actual[0]?.[field]) !== text(staff[field as keyof typeof staff]))) {
          errors.push(`Library source content differs from published staff record: ${staff.name}`);
        }
      }
      continue;
    }
    if (page.role !== 'profile') continue;
    const matches = profiles.filter(p => key(p.profileUrl) === key(url) || key(p.profileUrl) === key(page.url));
    const parsed = parseFacultyProfileHtml(page.html as string, url, text(page.school) || text(matches[0]?.school));
    try { assertFacultyProfileCoverage(parsed); }
    catch (error) { errors.push(`Faculty source extraction incomplete: ${url} — ${String(error)}`); }
    if (!parsed.profile || !matches.length) {
      errors.push(`Faculty source profile was not preserved: ${url}`);
      continue;
    }
    const validated = validateFacultyProfiles([parsed.profile])[0];
    if (!validated) {
      errors.push(`Faculty source profile did not survive validation: ${url}`);
      continue;
    }
    for (const field of fields) {
      // Allow schema entity-decoding/whitespace cleanup, but no silent entry removal.
      if (validated[field].length < new Set(parsed.profile[field].map(text)).size) {
        errors.push(`Faculty source entries removed during ${field} validation: ${url}`);
      }
      const expected = validated[field].map(text);
      const actual = new Set(matches.flatMap(p => Array.isArray(p[field]) ? p[field].map(text) : []));
      for (const entry of expected) {
        if (entry && !actual.has(entry)) errors.push(`Faculty source content lost from ${field}: ${url} — ${entry.slice(0, 100)}`);
      }
    }
    const expectedBio = text(validated.bio);
    if (expectedBio && !matches.some(p => text(p.bio).includes(expectedBio))) {
      errors.push(`Faculty source biography content lost: ${url}`);
    }
    // Compare original source anchors independently of parser and validator.
    // Re-validating the parser's output alone can conceal a shared data loss.
    const $ = load(page.html as string);
    const content = $('#content-block .col-lg-12').first();
    content.find('script, style, nav, footer, .disclaimer, [role="navigation"]').remove();
    const published = matches.flatMap(profile => Object.values(profile).flat()).join('\n');
    const checked = new Set<string>();
    content.find('a[href]').each((_, anchor) => {
      try {
        const target = new URL($(anchor).attr('href') || '', text(page.url) || url);
        if (!['http:', 'https:'].includes(target.protocol) || checked.has(target.href)) return;
        checked.add(target.href);
        if (!published.includes(target.href)) errors.push(`Faculty source link lost: ${url} — ${target.href}`);
      } catch { /* Invalid source URLs are not invented or repaired. */ }
    });
  }
  return errors;
}
