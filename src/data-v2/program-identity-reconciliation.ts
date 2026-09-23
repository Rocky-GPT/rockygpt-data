import { createHash } from 'node:crypto';
import type { CampusIdentities } from './campus-identities';

type Row = Record<string, unknown>;
export interface ProgramEvidence {
  pointer: string; sha256: string; code: string; name: string; id: string;
  programGroupId: string; status: string; academicLevel: string;
  changeNote: string; requirementIds: string[];
}
export interface CatalogEvidence { scrapedAt: string; sha256: string; programs: ProgramEvidence[] }
const text = (value: unknown): string => typeof value === 'string' ? value : '';
const object = (value: unknown): Row => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
const sha256 = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function requirementIds(value: unknown): string[] {
  if (Array.isArray(value)) return [...new Set(value.flatMap(requirementIds))].sort();
  const row = object(value);
  return [...new Set([...(text(row.id) ? [text(row.id)] : []), ...Object.values(row).flatMap(requirementIds)])].sort();
}

/** A compact source excerpt for an offline review; never an automatic runtime join. */
export function catalogEvidence(value: unknown): CatalogEvidence {
  const capture = object(value);
  if (!Array.isArray(capture.programs) || !Number.isFinite(Date.parse(text(capture.scrapedAt)))) throw new Error('Expected a dated catalog capture.');
  return { scrapedAt: text(capture.scrapedAt), sha256: sha256(value), programs: capture.programs.map((value, index) => {
    const row = object(value); const fields = object(row.customFields);
    if (!text(row.code)) throw new Error('Catalog program has no code.');
    return { pointer: `/programs/${index}`, sha256: sha256(value), code: text(row.code), name: text(row.name),
      id: text(row.id), programGroupId: text(row.programGroupId), status: text(row.status),
      academicLevel: text(fields.academicLevelCode), changeNote: text(fields.xtG6a), requirementIds: requirementIds(row.requisites) };
  }) };
}

/** Exact fields only. An equal generic name or school-prefix substitution is insufficient. */
export function programContinuityEvidence(previous: ProgramEvidence, current: ProgramEvidence): string[] {
  const evidence: string[] = [];
  const sameName = !!previous.name && previous.name === current.name;
  const sameSuffix = previous.code.split('-').slice(1).join('-') === current.code.split('-').slice(1).join('-');
  const shared = previous.requirementIds.filter(id => current.requirementIds.includes(id));
  const sameGroup = !!previous.programGroupId && previous.programGroupId === current.programGroupId;
  const sameLevel = !!previous.academicLevel && previous.academicLevel === current.academicLevel;
  const schoolChange = /school.*change|change.*school/i.test(current.changeNote);
  if (sameGroup && (sameName || sameSuffix || shared.length >= 2)) evidence.push('same_program_group');
  if (shared.length >= 2 && (sameName || sameSuffix)) evidence.push('retained_requirement_ids');
  if (sameName && sameSuffix && sameLevel && schoolChange) evidence.push('explicit_school_change');
  return evidence;
}

export interface ProgramReconciliationEntry {
  entityId: string; previousCode: string;
  classification: 'current' | 'inactive' | 'ambiguous' | 'unmatched';
  currentCode?: string; evidence?: string[];
  candidates: { code: string; status: string; evidence: string[] }[];
}

/** All acceptable active candidates must agree on one code and have one owner.
 * Inactive catalog versions are retained in the report, never called active or
 * removed from the seed merely to satisfy an identity continuity threshold.
 */
export function reconcileProgramIdentities(seed: CampusIdentities, previous: CatalogEvidence, current: CatalogEvidence): ProgramReconciliationEntry[] {
  const result: ProgramReconciliationEntry[] = seed.entities.filter(entity => entity.kind === 'program').map(entity => {
    const codes = entity.links.flatMap(link => link.selector?.field === 'catalog_code' ? link.selector.values : []);
    const originals = previous.programs.filter(row => codes.includes(row.code));
    if (originals.length !== 1) throw new Error(`Expected one previous source record for ${entity.id}.`);
    const old = originals[0];
    const candidates = current.programs.flatMap(row => {
      const evidence = programContinuityEvidence(old, row);
      return evidence.length ? [{ code: row.code, status: row.status, evidence }] : [];
    });
    const active = candidates.filter(row => row.status.toLowerCase() === 'active');
    const preferred = active.length ? active : candidates;
    const selected = preferred.length === 1 ? preferred[0] : undefined;
    return { entityId: entity.id, previousCode: old.code,
      classification: selected ? (active.length ? 'current' : 'inactive') : preferred.length ? 'ambiguous' : 'unmatched',
      ...(selected ? { currentCode: selected.code, evidence: selected.evidence } : {}), candidates };
  });
  const ownership = new Map<string, number>();
  for (const entry of result) if (entry.currentCode) ownership.set(entry.currentCode, (ownership.get(entry.currentCode) || 0) + 1);
  for (const entry of result) if (entry.currentCode && ownership.get(entry.currentCode)! > 1) {
    entry.classification = 'ambiguous'; delete entry.currentCode; delete entry.evidence;
  }
  return result;
}
