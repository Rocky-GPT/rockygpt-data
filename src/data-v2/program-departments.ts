import type { CampusIdentity } from './campus-identities';
import type { IdentityCoverageIssue } from './compile-campus-identities';

/**
 * @module data-v2/program-departments
 * Each catalog program is `part_of` the department that convenes it.
 *
 * A program's catalog page shows its Convening Group, the department that runs it ("Computer
 * Science (CMPS)"); the catalog capture keeps it as the program's `conveningGroups`. A course
 * subject is that same catalog department, named in the same form ("Computer Science (CMPS)",
 * course-subjects.ts). A program is placed in the one subject whose name is exactly its convening
 * group. A group no subject is named like (a department with no courses of its own code, such as
 * Data Science (DSCI)) is reported, never matched by a similar name.
 */

type Row = Record<string, unknown>;
const text = (value: unknown): string => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
const strings = (value: unknown): string[] => Array.isArray(value) ? value.map(text).filter(Boolean) : [];

/** `programs` are this release's program records joined with the catalog artifact's fields, by record key. */
export function linkProgramDepartments(entities: CampusIdentity[], programs: Row[]): { linked: number; unresolved: IdentityCoverageIssue[] } {
  const subjects = new Map<string, string[]>();
  for (const subject of entities.filter(e => e.kind === 'subject')) subjects.set(subject.name, [...subjects.get(subject.name) ?? [], subject.id]);
  const rows = new Map(programs.map(row => [`${text(row.source_key)}:${text(row.source_record_key)}`, row]));
  const unresolved: IdentityCoverageIssue[] = [];
  let linked = 0;
  for (const program of entities.filter(e => e.kind === 'program')) {
    for (const link of program.links.filter(l => l.collection === 'programs')) {
      for (const key of link.source_record_keys) {
        const row = rows.get(`${link.source_key}:${key}`);
        for (const group of strings(row?.conveningGroups)) {
          const found = subjects.get(group) ?? [];
          if (found.length !== 1) {
            unresolved.push({ entity: program.name, collection: 'programs', record: key, kind: 'missing_connection',
              reason: found.length ? `Its convening group "${group}" names ${found.length} subjects; the program is not placed in one.`
                : `Its convening group "${group}" is not a course subject in this release (no catalog course carries its code); the program is not placed in a department.` });
            continue;
          }
          program.relationships ||= [];
          if (program.relationships.some(r => r.type === 'part_of' && 'target_entity_id' in r && r.target_entity_id === found[0])) continue;
          const url = text(row?.catalogUrl);
          program.relationships.push({ type: 'part_of', target_entity_id: found[0], evidence: [{ collection: 'programs', source_key: link.source_key, source_record_key: key, field: 'conveningGroups', ...(/^https:\/\//.test(url) ? { source_url: url } : {}) }] });
          linked++;
        }
      }
    }
  }
  return { linked, unresolved };
}
