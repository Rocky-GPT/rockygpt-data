import type { CampusIdentities, CampusIdentityRelationship } from './campus-identities';
import { createHash } from 'node:crypto';
import { courseSubjectCode, subjectIdentityId } from './course-subjects';
import type { ConvenerReplacementReview } from './convener-continuity';

/**
 * @module data-v2/identity-continuity
 * Persistent identity IDs exist so a campus entity keeps its ID across releases.
 * Row-count floors cannot see an identity that silently disappears, such as a
 * reviewed selector that stops matching after a source rename, or IDs that all
 * change because their derivation changed. This compares a candidate registry
 * with the active release's registry before activation.
 *
 * Expected churn does not count as a loss: event occurrences whose linked rows
 * have all started, and identities deliberately removed from the reviewed Git
 * seed. The quality-checked current catalog may also explicitly mark a missing
 * course Inactive: only a unique exact course row explains its subject link's
 * removal. A derived subject can disappear when every prior course has that
 * proof and neither raw nor published current courses remain under its code.
 * This describes catalog inclusion, not institutional subject retirement.
 * A convener replacement needs both captured Convener fields and uniquely
 * verified old/new faculty targets; missing source evidence remains a loss.
 * A changed kind for the same ID fails, except a club becoming an
 * organization or back (Archway recategorized the same group). Otherwise a kind or
 * relationship type fails only when it loses more than 10% of its previous
 * members (at least 2), so one departure does not stop a daily refresh while a
 * broken source or ID derivation does. Every unexpected loss is reported.
 */

export const LOSS_RATIO = 0.1;
/** Archway recategorizes groups; a club becoming an organization is the same group. */
const KIND_FAMILIES: Record<string, string> = { club: 'archway-group', organization: 'archway-group' };
const family = (kind: string): string => KIND_FAMILIES[kind] ?? kind;
export const LOSS_MINIMUM = 2;
const REPORTED_LOSSES = 100;

export interface IdentityLoss { id: string; kind: string; name: string }
export interface IdentityContinuityEvidence {
  /** The complete catalog capture already accepted by source quality/provenance gates. */
  catalog?: unknown;
  /** The actual candidate release's courses artifact, never inferred from the raw capture. */
  candidateCourses?: unknown;
  /** Proofs produced by reviewConvenerReplacements from both release artifacts. */
  convenerReplacements?: ConvenerReplacementReview;
}
interface InactiveCourseEvidence { course_key: string; raw_pointer: string; status: 'Inactive' }
export interface IdentityContinuityReport {
  baseline: 'active_release' | 'none';
  /** Why an existing active registry could not serve as the baseline. */
  baseline_note?: string;
  previous_entities: number;
  candidate_entities: number;
  added_entities: number;
  expected_losses: { past_event_occurrences: number; retired_in_seed: number; inactive_catalog_subjects: number };
  expected_relationship_losses_by_type: Record<string, number>;
  convener_replacement_evidence?: ConvenerReplacementReview;
  /** Catalog inclusion changed; this does not assert institutional subject retirement. */
  inactive_catalog_evidence?: {
    collected_at: string; content_hash: string; courses: InactiveCourseEvidence[];
    subjects: { id: string; code: string; previous_course_keys: string[] }[];
  };
  lost_by_kind: Record<string, number>;
  lost: IdentityLoss[];
  lost_truncated: boolean;
  kind_changes: { id: string; from: string; to: string }[];
  lost_relationships_by_type: Record<string, number>;
  failures: string[];
}

export function allowedLoss(previous: number): number {
  return Math.max(LOSS_MINIMUM, Math.floor(previous * LOSS_RATIO));
}

/** Evidence row IDs are regenerated in every release; the fact is source, type and target. */
function relationshipKey(source: string, relation: CampusIdentityRelationship): string {
  const target = 'target_record' in relation
    ? ['record', relation.target_record.collection, relation.target_record.source_key, relation.target_record.source_record_key]
    : ['entity', relation.target_entity_id];
  return JSON.stringify([source, relation.type, ...target]);
}

export function compareIdentityRegistries(
  previous: CampusIdentities | null,
  candidate: CampusIdentities,
  seed: CampusIdentities,
  pastEventIds: ReadonlySet<string> = new Set(),
  evidence: IdentityContinuityEvidence = {},
): IdentityContinuityReport {
  const report: IdentityContinuityReport = {
    baseline: previous ? 'active_release' : 'none',
    previous_entities: previous?.entities.length ?? 0,
    candidate_entities: candidate.entities.length,
    added_entities: 0,
    expected_losses: { past_event_occurrences: 0, retired_in_seed: 0, inactive_catalog_subjects: 0 },
    expected_relationship_losses_by_type: {},
    lost_by_kind: {},
    lost: [],
    lost_truncated: false,
    kind_changes: [],
    lost_relationships_by_type: {},
    failures: [],
  };
  if (!previous) return report;
  const convenerReplacements = new Set(evidence.convenerReplacements?.replacements.map(proof => proof.relationship_key));
  if (evidence.convenerReplacements) report.convener_replacement_evidence = evidence.convenerReplacements;
  const catalog = evidence.catalog as { scrapedAt?: unknown; courses?: unknown } | undefined;
  const candidateCourses = evidence.candidateCourses;
  const validCatalog = catalog && typeof catalog.scrapedAt === 'string' && Number.isFinite(Date.parse(catalog.scrapedAt))
    && Array.isArray(catalog.courses) && candidateCourses && typeof candidateCourses === 'object' && !Array.isArray(candidateCourses);
  const inactive = new Map<string, InactiveCourseEvidence>();
  const currentRawSubjects = new Set<string>();
  const candidateCourseKeys = new Set(Object.keys(candidateCourses && typeof candidateCourses === 'object' ? candidateCourses : {}));
  if (validCatalog) {
    const byCode = new Map<string, { index: number; status: unknown }[]>();
    for (const [index, value] of (catalog.courses as unknown[]).entries()) {
      if (!value || typeof value !== 'object' || typeof (value as { code?: unknown }).code !== 'string') continue;
      const row = value as { code: string; status?: unknown };
      const code = row.code.replace(/\s+/g, '').replace(/([A-Z]+)(\d)/, '$1 $2').trim();
      byCode.set(code, [...(byCode.get(code) || []), { index, status: row.status }]);
      if (row.status !== 'Inactive') {
        const subject = courseSubjectCode(code); if (subject) currentRawSubjects.add(subject);
      }
    }
    for (const [code, rows] of byCode) if (rows.length === 1 && rows[0].status === 'Inactive' && !candidateCourseKeys.has(code)) {
      inactive.set(code, { course_key: code, raw_pointer: `/courses/${rows[0].index}`, status: 'Inactive' });
    }
    report.inactive_catalog_evidence = { collected_at: catalog.scrapedAt as string,
      content_hash: createHash('sha256').update(JSON.stringify(catalog)).digest('hex'), courses: [], subjects: [] };
  }
  const usedInactive = new Map<string, InactiveCourseEvidence>();
  const inactiveTarget = (relation: CampusIdentityRelationship): string | undefined => {
    if (relation.type !== 'includes_course' || !('target_record' in relation)) return undefined;
    const target = relation.target_record;
    return target.collection === 'courses' && target.source_key === 'academic-programs' && inactive.has(target.source_record_key)
      ? target.source_record_key : undefined;
  };
  const acceptInactiveSubject = (entity: CampusIdentities['entities'][number]): boolean => {
    if (!report.inactive_catalog_evidence || entity.kind !== 'subject') return false;
    const codes = entity.links.filter(link => link.collection === 'subjects' && link.source_key === 'course-subjects').flatMap(link => link.source_record_keys);
    if (codes.length !== 1 || entity.id !== subjectIdentityId(codes[0]) || currentRawSubjects.has(codes[0])
      || [...candidateCourseKeys].some(key => courseSubjectCode(key) === codes[0])) return false;
    const relations = (entity.relationships || []).filter(relation => relation.type === 'includes_course');
    const keys = relations.map(inactiveTarget);
    if (!keys.length || keys.some(key => !key || courseSubjectCode(key) !== codes[0])) return false;
    for (const key of keys as string[]) usedInactive.set(key, inactive.get(key)!);
    report.inactive_catalog_evidence.subjects.push({ id: entity.id, code: codes[0], previous_course_keys: keys as string[] });
    return true;
  };
  const current = new Map(candidate.entities.map(entity => [entity.id, entity]));
  const previousIds = new Set(previous.entities.map(entity => entity.id));
  const seedIds = new Set(seed.entities.map(entity => entity.id));
  // Kinds the reviewed seed governs; clubs and events are compiled from source IDs.
  const seedKinds = new Set(seed.entities.map(entity => entity.kind));
  const previousByKind: Record<string, number> = {};
  const lost: IdentityLoss[] = [];
  for (const entity of previous.entities) {
    previousByKind[entity.kind] = (previousByKind[entity.kind] || 0) + 1;
    const now = current.get(entity.id);
    if (now) {
      if (now.kind !== entity.kind) report.kind_changes.push({ id: entity.id, from: entity.kind, to: now.kind });
    } else if (entity.kind === 'event' && pastEventIds.has(entity.id)) {
      report.expected_losses.past_event_occurrences += 1;
    } else if (seedKinds.has(entity.kind) && !seedIds.has(entity.id)) {
      report.expected_losses.retired_in_seed += 1;
    } else if (acceptInactiveSubject(entity)) {
      report.expected_losses.inactive_catalog_subjects += 1;
    } else {
      lost.push({ id: entity.id, kind: entity.kind, name: entity.name });
      report.lost_by_kind[entity.kind] = (report.lost_by_kind[entity.kind] || 0) + 1;
    }
  }
  report.added_entities = candidate.entities.filter(entity => !previousIds.has(entity.id)).length;
  report.lost = lost.slice(0, REPORTED_LOSSES);
  report.lost_truncated = lost.length > REPORTED_LOSSES;

  const candidateRelationships = new Set(candidate.entities.flatMap(entity =>
    (entity.relationships || []).map(relation => relationshipKey(entity.id, relation))));
  const comparable: Record<string, number> = {};
  for (const entity of previous.entities) {
    if (!current.has(entity.id)) continue; // Already counted as an identity change.
    for (const relation of entity.relationships || []) {
      if ('target_entity_id' in relation && !current.has(relation.target_entity_id)) continue;
      comparable[relation.type] = (comparable[relation.type] || 0) + 1;
      if (!candidateRelationships.has(relationshipKey(entity.id, relation))) {
        if (relation.type === 'convener' && convenerReplacements.has(relationshipKey(entity.id, relation))) {
          report.expected_relationship_losses_by_type.convener = (report.expected_relationship_losses_by_type.convener || 0) + 1;
          continue;
        }
        const inactiveCode = entity.kind === 'subject' ? inactiveTarget(relation) : undefined;
        if (inactiveCode) {
          usedInactive.set(inactiveCode, inactive.get(inactiveCode)!);
          report.expected_relationship_losses_by_type.includes_course = (report.expected_relationship_losses_by_type.includes_course || 0) + 1;
          continue;
        }
        report.lost_relationships_by_type[relation.type] = (report.lost_relationships_by_type[relation.type] || 0) + 1;
      }
    }
  }
  if (report.inactive_catalog_evidence) report.inactive_catalog_evidence.courses = [...usedInactive.values()].sort((a, b) => a.course_key.localeCompare(b.course_key));

  for (const change of report.kind_changes) {
    if (family(change.from) !== family(change.to)) {
      report.failures.push(`identity ${change.id} changed kind from ${change.from} to ${change.to}`);
    }
  }
  for (const [kind, count] of Object.entries(report.lost_by_kind)) {
    const limit = allowedLoss(previousByKind[kind]);
    if (count > limit) report.failures.push(`${count} of ${previousByKind[kind]} ${kind} identities disappeared (at most ${limit} allowed)`);
  }
  for (const [type, count] of Object.entries(report.lost_relationships_by_type)) {
    const limit = allowedLoss(comparable[type]);
    if (count > limit) report.failures.push(`${count} of ${comparable[type]} ${type} relationships disappeared (at most ${limit} allowed)`);
  }
  return report;
}
