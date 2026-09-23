import type { CampusIdentities, CampusIdentityRelationship } from './campus-identities';

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
 * seed. A changed kind for the same ID fails, except a club becoming an
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
export interface IdentityContinuityReport {
  baseline: 'active_release' | 'none';
  /** Why an existing active registry could not serve as the baseline. */
  baseline_note?: string;
  previous_entities: number;
  candidate_entities: number;
  added_entities: number;
  expected_losses: { past_event_occurrences: number; retired_in_seed: number };
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
): IdentityContinuityReport {
  const report: IdentityContinuityReport = {
    baseline: previous ? 'active_release' : 'none',
    previous_entities: previous?.entities.length ?? 0,
    candidate_entities: candidate.entities.length,
    added_entities: 0,
    expected_losses: { past_event_occurrences: 0, retired_in_seed: 0 },
    lost_by_kind: {},
    lost: [],
    lost_truncated: false,
    kind_changes: [],
    lost_relationships_by_type: {},
    failures: [],
  };
  if (!previous) return report;
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
        report.lost_relationships_by_type[relation.type] = (report.lost_relationships_by_type[relation.type] || 0) + 1;
      }
    }
  }

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
