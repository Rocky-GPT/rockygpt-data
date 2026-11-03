import type { CampusIdentity, IdentityEvidence } from './campus-identities';
import type { IdentityCoverageIssue } from './compile-campus-identities';
import { COURSE_SOURCE_KEY, courseCatalogUrl } from './course-identities';
import { catalogCourses } from './course-requisites';

/**
 * @module data-v2/course-cross-listings
 * Two catalog courses the catalog calls one course listed under two codes are `cross_listed`.
 *
 * A cross-listed course's catalog description says so in a sentence of its own: "This course is
 * cross-listed with ARHT 311." (also "cross listed with MBAD670" and "cross listed as BIIN335").
 * Every course code that sentence names is linked when it is a course in this release's catalog.
 * A pair gets one link, kept on the course that comes first in code order, with each course whose
 * description names the other as evidence (usually both do). A code that is not a course in this
 * release's catalog is reported, never linked.
 */

type Row = Record<string, unknown>;
const record = (value: unknown): Row => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
const SENTENCE = /cross[- ]?listed\s+(?:with|as)\s+([^.;]*)/gi;
const CODE = /\b([A-Z]{3,4})\s?-?(\d{3}[A-Z]?)\b/g;

/** The course codes a description's cross-listing sentences name, written the catalog's way ("BIIN 335"). */
export function crossListedCodes(description: unknown): string[] {
  const found: string[] = [];
  for (const sentence of (typeof description === 'string' ? description : '').matchAll(SENTENCE)) {
    for (const [, subject, number] of sentence[1].matchAll(CODE)) {
      const code = `${subject} ${number}`;
      if (!found.includes(code)) found.push(code);
    }
  }
  return found;
}

/** Adds `cross_listed` links between catalog course identities; `courses` is the release's `courses` artifact. */
export function linkCourseCrossListings(entities: CampusIdentity[], courses: unknown): { linked: number; unresolved: IdentityCoverageIssue[] } {
  const byCode = catalogCourses(entities);
  const unresolved: IdentityCoverageIssue[] = [];
  const pairs = new Map<string, { first: CampusIdentity; second: CampusIdentity; evidence: IdentityEvidence[] }>();
  for (const [code, value] of Object.entries(record(courses)).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const course = byCode.get(code);
    if (!course) continue;
    for (const other of crossListedCodes(record(value).description)) {
      const target = byCode.get(other);
      if (!target) {
        unresolved.push({ entity: code, collection: 'courses', record: code, kind: 'missing_connection',
          reason: `Its description says it is cross-listed with ${other}, which is not a course in this release's catalog; it is not linked.` });
        continue;
      }
      if (target.id === course.id) continue;
      const [first, second] = code < other ? [course, target] : [target, course];
      const pair = pairs.get(`${first.id} ${second.id}`) ?? { first, second, evidence: [] };
      pair.evidence.push({ collection: 'courses', source_key: COURSE_SOURCE_KEY, source_record_key: code, field: 'description', source_url: courseCatalogUrl(code) });
      pairs.set(`${first.id} ${second.id}`, pair);
    }
  }
  let linked = 0;
  for (const { first, second, evidence } of pairs.values()) {
    first.relationships ||= [];
    if (first.relationships.some(r => r.type === 'cross_listed' && 'target_entity_id' in r && r.target_entity_id === second.id)) continue;
    first.relationships.push({ type: 'cross_listed', target_entity_id: second.id, evidence });
    linked++;
  }
  return { linked, unresolved };
}
