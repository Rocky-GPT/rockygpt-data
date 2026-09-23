import type { CampusIdentities } from './campus-identities';
import type { CourseIdentitiesArtifact } from './course-identities';
import { uuid5 } from './course-identities';
import type { IdentityCoverageIssue } from './compile-campus-identities';

/**
 * @module data-v2/requirement-groups
 * Program requirements as contextual records: one record per distinct published
 * requirement section, keeping its nested all-of / any-of / choose-N rule tree,
 * notes and exact artifact paths. Identical sections, such as each General
 * Education area, are one shared record referenced by every program.
 *
 * Programs point to their groups (`requirement_group`); groups point to catalog
 * courses (`requirement_option`) with the option's position and and/or logic.
 * An option is never an unconditional requirement. Course codes resolve only by
 * exact match to a published catalog key, never by name.
 */

type Row = Record<string, unknown>;
type Path = (string | number)[];

// Fixed namespace for content-derived group IDs; unchanged sections keep their ID.
const REQUIREMENT_NAMESPACE = Buffer.from('418aaa3bf8d34f0c9eeed80e274ea591', 'hex');

export type Choose = { all: true } | { at_least: number } | { minimum_credits: number };
export interface RequirementCourse { code: string; name: string | null; course_id: string | null }
export interface RequirementItem { logic: string | null; courses: RequirementCourse[] }
export interface RequirementRule {
  condition: string | null; count: number | null; credits: number | null; choose: Choose | null;
  items: RequirementItem[]; sub_rules: RequirementRule[];
}
export interface RequirementGroup {
  id: string; record_type: 'requirement_group'; label: string; shape: 'rule' | 'course_list' | 'text';
  note: string | null;
  rule: RequirementRule | null;
  course_list: { select_count: number | null; choose: Choose | null; courses: RequirementCourse[] } | null;
  program_sections: number;
  provenance: { artifact_key: 'programs'; path: Path; program: string; catalog_code: string | null }[];
}
export type RequirementEndpoint = { entity_id: string } | { record_id: string };
export interface RequirementEdge {
  type: 'requirement_group' | 'requirement_option';
  source: RequirementEndpoint; target: RequirementEndpoint;
  order?: number; path?: Path; logic?: string | null; code?: string;
}
export interface RequirementGroupsArtifact {
  schema_version: 1; source: { artifact_key: 'programs' };
  semantics: Record<string, string>;
  groups: RequirementGroup[]; edges: RequirementEdge[]; unresolved: IdentityCoverageIssue[];
}

const rows = (value: unknown): Row[] => Array.isArray(value) ? value.filter(v => v && typeof v === 'object') as Row[] : [];
const text = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value : null;
const number = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null;

/** Deterministic JSON: object keys sorted, array order kept. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Row).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Row)[key])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/** Only unambiguous published forms get a derived choice; everything else stays verbatim. */
export function chooseFor(condition: string | null, count: number | null, credits: number | null, hasItems: boolean, hasSubRules: boolean): Choose | null {
  const children = hasItems !== hasSubRules;
  if (!children && condition !== 'minimumCredits') return null;
  if ((condition === 'completedAllOf' && hasItems) || (condition === 'allOf' && hasSubRules)) return count === null ? { all: true } : null;
  if ((condition === 'completedAnyOf' && hasItems) || (condition === 'anyOf' && hasSubRules)) return count === null ? { at_least: 1 } : null;
  if (condition === 'completedAtLeastXOf' && count !== null && Number.isInteger(count) && count >= 1) return { at_least: count };
  if (condition === 'minimumCredits' && count === null && credits !== null) return { minimum_credits: credits };
  return null;
}

export function compileRequirementGroups(programs: unknown, registry: CampusIdentities, courses: CourseIdentitiesArtifact): RequirementGroupsArtifact {
  const courseIds = new Map(courses.courses.map(course => [course.source_record_key, course.id]));
  const programIds = new Map<string, string>();
  for (const entity of registry.entities) if (entity.kind === 'program') {
    for (const link of entity.links) if (link.collection === 'programs') for (const key of link.source_record_keys) programIds.set(key, entity.id);
  }
  const groups = new Map<string, RequirementGroup>();
  const edges: RequirementEdge[] = [];
  const unresolved: IdentityCoverageIssue[] = [];
  const reported = new Set<string>();
  const report = (issue: IdentityCoverageIssue) => {
    const key = canonical(issue);
    if (!reported.has(key)) { reported.add(key); unresolved.push(issue); }
  };

  rows((programs as Row)?.schools).forEach((school, schoolIndex) => rows(school.majors).forEach((major, majorIndex) => {
    const name = text(major.name)?.trim() ?? '';
    const key = `${text(school.school)?.trim() ?? ''}:${name.replace(/\s+/g, ' ')}`;
    const programId = programIds.get(key);
    const sections = rows(major.requirements);
    if (!programId && sections.length) report({ entity: name, collection: 'programs', record: key, reason: 'The program has no identity, so its requirement groups are published without a program link.' });
    sections.forEach((section, sectionIndex) => {
      const path: Path = ['schools', schoolIndex, 'majors', majorIndex, 'requirements', sectionIndex];
      const content = sectionContent(section);
      const id = uuid5(REQUIREMENT_NAMESPACE, canonical(content));
      let group = groups.get(id);
      if (!group) {
        group = buildGroup(id, section, courseIds, (code, where) => report({ entity: name, collection: 'courses', record: code, reason: `Requirement "${text(section.section) ?? ''}" cites a code that is not a key in this release catalog (${where.join('.')}); it stays as published and unlinked.` }));
        const uninterpreted = uninterpretedNodes(group.rule);
        for (const node of uninterpreted) report({ entity: name, collection: 'programs', record: group.label, reason: `Published condition ${node.condition ?? 'none'} with count ${node.count ?? 'none'} and credits ${node.credits ?? 'none'} is kept as published and not interpreted.` });
        groups.set(id, group);
        edges.push(...optionEdges(group));
      }
      group.program_sections += 1;
      group.provenance.push({ artifact_key: 'programs', path, program: name, catalog_code: text(major.catalogCode) });
      if (programId) edges.push({ type: 'requirement_group', source: { entity_id: programId }, target: { record_id: id }, order: sectionIndex });
    });
  }));

  return {
    schema_version: 1,
    source: { artifact_key: 'programs' },
    semantics: {
      groups: 'One record per distinct published requirement section; identical sections are one shared record. The rule tree, counts and notes are kept as published.',
      choose: 'Derived only from unambiguous published forms: all, at_least N (of the node\'s items or sub-rules) or minimum_credits N. Null keeps the published condition, count and credits without interpretation.',
      requirement_group: 'The program lists this group among its requirements, at the given section order.',
      requirement_option: 'A catalog course that can satisfy part of the group at `path`, joined to its item\'s other courses by `logic`. It is not a required course on its own.',
    },
    groups: [...groups.values()].sort((a, b) => (a.id < b.id ? -1 : 1)),
    edges,
    unresolved,
  };
}

/** The published facts that identify a section, without derived fields or its location. */
function sectionContent(section: Row): unknown {
  const courses = (value: unknown) => rows(value).map(course => ({ code: course.code ?? null, name: course.name ?? null }));
  const rule = (node: Row): unknown => ({
    condition: node.condition ?? null, count: node.count ?? null, credits: node.credits ?? null,
    items: rows(node.items).map(item => ({ logic: item.logic ?? null, codes: courses(item.codes) })),
    sub_rules: rows(node.subRules).map(rule),
  });
  return {
    label: section.section ?? null, note: section.note ?? null,
    rule: section.rule && typeof section.rule === 'object' ? rule(section.rule as Row) : null,
    course_list: Array.isArray(section.courses) ? { select_count: section.selectCount ?? null, courses: courses(section.courses) } : null,
  };
}

function buildGroup(id: string, section: Row, courseIds: Map<string, string>, missing: (code: string, where: Path) => void): RequirementGroup {
  const refs = (value: unknown, where: Path): RequirementCourse[] => rows(value).map((course, index) => {
    const code = text(course.code) ?? '';
    const courseId = courseIds.get(code) ?? null;
    if (!courseId) missing(code, [...where, index]);
    return { code, name: text(course.name), course_id: courseId };
  });
  const rule = (node: Row, where: Path): RequirementRule => {
    const items = rows(node.items); const subRules = rows(node.subRules);
    const condition = text(node.condition); const count = number(node.count); const credits = number(node.credits);
    return {
      condition, count, credits, choose: chooseFor(condition, count, credits, items.length > 0, subRules.length > 0),
      items: items.map((item, index) => ({ logic: text(item.logic), courses: refs(item.codes, [...where, 'items', index, 'codes']) })),
      sub_rules: subRules.map((sub, index) => rule(sub, [...where, 'sub_rules', index])),
    };
  };
  const hasRule = section.rule && typeof section.rule === 'object';
  const selectCount = number(section.selectCount);
  const listed = Array.isArray(section.courses) ? refs(section.courses, ['course_list', 'courses']) : null;
  return {
    id, record_type: 'requirement_group', label: text(section.section) ?? 'Requirements',
    shape: hasRule ? 'rule' : listed ? 'course_list' : 'text',
    note: text(section.note),
    rule: hasRule ? rule(section.rule as Row, ['rule']) : null,
    course_list: listed ? {
      select_count: selectCount,
      choose: selectCount !== null && Number.isInteger(selectCount) && selectCount >= 1 ? { at_least: selectCount } : null,
      courses: listed,
    } : null,
    program_sections: 0,
    provenance: [],
  };
}

function uninterpretedNodes(rule: RequirementRule | null): RequirementRule[] {
  if (!rule) return [];
  return [...(rule.choose === null ? [rule] : []), ...rule.sub_rules.flatMap(uninterpretedNodes)];
}

function optionEdges(group: RequirementGroup): RequirementEdge[] {
  const edges: RequirementEdge[] = [];
  const add = (course: RequirementCourse, path: Path, logic: string | null) => {
    if (course.course_id) edges.push({ type: 'requirement_option', source: { record_id: group.id }, target: { entity_id: course.course_id }, path, logic, code: course.code });
  };
  const walk = (rule: RequirementRule, path: Path) => {
    rule.items.forEach((item, index) => item.courses.forEach((course, position) => add(course, [...path, 'items', index, 'courses', position], item.logic)));
    rule.sub_rules.forEach((sub, index) => walk(sub, [...path, 'sub_rules', index]));
  };
  if (group.rule) walk(group.rule, ['rule']);
  group.course_list?.courses.forEach((course, position) => add(course, ['course_list', 'courses', position], null));
  return edges;
}
