import type { CampusIdentity } from './campus-identities';
import type { IdentityCoverageIssue } from './compile-campus-identities';
import { COURSE_SOURCE_KEY, courseCatalogUrl } from './course-identities';

/**
 * @module data-v2/course-requisites
 * The courses a catalog course names in its own requisites: `requires` for each course its
 * prerequisites name, and `taken_with` for each course its corequisites name.
 *
 * The catalog publishes each course's requisites as rules (normalized by the catalog capture into
 * the course record's `requisites`): a section, "Prerequisite" or "Corequisite" (the catalog also
 * spells them "Prerequiste", "Corequsite" and so on), holding course codes and nested rules. Every
 * course a rule names is linked, one link per course, so a choice ("CRWT 102 or CRWT 102S") links
 * both courses. The course record keeps what a link does not say: which courses are a choice, the
 * minimum grade, and a placement test that can stand in for a course. A code that is not a course
 * in this release's catalog (a retired course) is reported, never linked.
 */

type Row = Record<string, unknown>;
const record = (value: unknown): Row => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
const rows = (value: unknown): Row[] => Array.isArray(value) ? value.filter(item => item && typeof item === 'object') as Row[] : [];
const text = (value: unknown): string => typeof value === 'string' ? value.trim() : '';

/** Which link a requisite section makes: its section label decides, else its rule's name. */
export function requisiteLink(requisite: Row): 'requires' | 'taken_with' | null {
  for (const label of [text(requisite.section), text(record(requisite.rule).name)]) {
    if (/^pre/i.test(label)) return 'requires';
    if (/^co/i.test(label)) return 'taken_with';
  }
  return null;
}

/** Every course code a rule names, its nested rules included, in the order the catalog gives them. */
export function requisiteCodes(rule: unknown): string[] {
  const found: string[] = [];
  const visit = (value: unknown) => {
    const current = record(value);
    for (const item of rows(current.items)) for (const course of rows(item.codes)) {
      const code = text(course.code).replace(/\s+/g, ' ');
      if (code && !found.includes(code)) found.push(code);
    }
    for (const sub of rows(current.subRules)) visit(sub);
  };
  visit(rule);
  return found;
}

/** Each catalog course identity by the code its `courses` record link names. */
export function catalogCourses(entities: CampusIdentity[]): Map<string, CampusIdentity> {
  const byCode = new Map<string, CampusIdentity>();
  for (const entity of entities.filter(e => e.kind === 'course')) {
    for (const link of entity.links.filter(l => l.collection === 'courses' && l.source_key === COURSE_SOURCE_KEY)) {
      for (const key of link.source_record_keys) byCode.set(key, entity);
    }
  }
  return byCode;
}

/**
 * Adds `requires` and `taken_with` links between catalog course identities. `courses` is the
 * release's `courses` artifact (catalog code -> course record); a course identity is found by the
 * code its `courses` record link names.
 */
export function linkCourseRequisites(entities: CampusIdentity[], courses: unknown): { linked: number; unresolved: IdentityCoverageIssue[] } {
  const byCode = catalogCourses(entities);
  const unresolved: IdentityCoverageIssue[] = [];
  let linked = 0;
  for (const [code, value] of Object.entries(record(courses)).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const course = byCode.get(code);
    if (!course) continue;
    for (const requisite of rows(record(value).requisites)) {
      const type = requisiteLink(requisite);
      const named = requisiteCodes(requisite.rule);
      if (!type) {
        if (named.length) unresolved.push({ entity: code, collection: 'courses', record: code, reason: `A requisite section headed "${text(requisite.section)}" is neither a prerequisite nor a corequisite; its courses are not linked.`, kind: 'missing_connection' });
        continue;
      }
      for (const other of named) {
        if (other === code) continue;
        const target = byCode.get(other);
        if (!target) {
          if (!unresolved.some(issue => issue.record === code && issue.reason.startsWith(`${other} `))) {
            unresolved.push({ entity: code, collection: 'courses', record: code, reason: `${other} is named in this course's ${type === 'requires' ? 'prerequisites' : 'corequisites'} but is not a course in this release's catalog; it is not linked.`, kind: 'missing_connection' });
          }
          continue;
        }
        course.relationships ||= [];
        if (course.relationships.some(r => r.type === type && 'target_entity_id' in r && r.target_entity_id === target.id)) continue;
        course.relationships.push({ type, target_entity_id: target.id, evidence: [{ collection: 'courses', source_key: COURSE_SOURCE_KEY, source_record_key: code, field: 'requisites', source_url: courseCatalogUrl(code) }] });
        linked++;
      }
    }
  }
  return { linked, unresolved };
}
