import { load } from 'cheerio';
import type { CampusIdentities, CampusIdentity, CampusIdentityRelationship } from './campus-identities';
import profileAliases from '../reference/campus-identity-url-aliases.json';

type Row = Record<string, unknown>;
type EntityRelationship = Extract<CampusIdentityRelationship, { target_entity_id: string }>;
interface ConvenerFieldEvidence {
  catalog_code: string; source_record_key: string; source_url: string;
  capture_source_url: string; collected_at: string; field: 'customFields.rJQmj'; raw_field: string;
}
interface VerifiedTarget { entity_id: string; name: string; source_profile_url: string; faculty_profile_url: string }
export interface ConvenerReplacementEvidence {
  relationship_key: string; program_id: string; program_name: string; previous_target_id: string;
  previous_target: VerifiedTarget; previous: ConvenerFieldEvidence;
  replacements: Array<{ target: VerifiedTarget; evidence: ConvenerFieldEvidence }>;
}
export interface ConvenerReplacementReview {
  replacements: ConvenerReplacementEvidence[];
  rejected: Array<{ program_id: string; previous_target_id: string; reason: string }>;
}

const row = (value: unknown): Row => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
const rows = (value: unknown): Row[] => Array.isArray(value) ? value.map(row) : [];
const text = (value: unknown): string => typeof value === 'string' ? value : '';
const url = (value: string): string => value.trim().replace(/\/+$/, '');
const reviewedUrl = (value: string): string => profileAliases.aliases.find(alias => alias.from === url(value))?.to || url(value);
const conveners = (entity: CampusIdentity): EntityRelationship[] => (entity.relationships || [])
  .filter((relation): relation is EntityRelationship => relation.type === 'convener');
const nameKey = (value: string): string => value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

function fieldText(html: string): string {
  const $ = load(html);
  $('br').replaceWith(' ');
  $('p,div,li,td,th,section,article,h1,h2,h3,h4,h5,h6').append(' ');
  return $.text();
}

function links(html: string): Array<{ profile_url: string; name: string }> {
  const $ = load(html);
  return $('a[href]').toArray().flatMap(element => {
    try {
      const parsed = new URL($(element).attr('href') || '', 'https://www.ramapo.edu');
      return parsed.protocol === 'https:' && parsed.hostname === 'www.ramapo.edu' && parsed.pathname.includes('/faculty/')
        ? [{ profile_url: url(parsed.toString()), name: $(element).text().trim() }] : [];
    } catch { return []; }
  });
}

function facultyOwners(registry: CampusIdentities): Map<string, Set<string>> {
  const owners = new Map<string, Set<string>>();
  for (const person of registry.entities.filter(entity => entity.kind === 'person')) {
    for (const key of person.links.filter(link => link.collection === 'faculty' && link.source_key === 'faculty')
      .flatMap(link => link.source_record_keys)) {
      const profile = reviewedUrl(key.split('#')[0]);
      const ids = owners.get(profile) || new Set<string>(); ids.add(person.id); owners.set(profile, ids);
    }
  }
  return owners;
}

function fieldEvidence(program: CampusIdentity, relation: EntityRelationship, artifact: unknown): ConvenerFieldEvidence | null {
  const capture = row(artifact);
  const references = relation.evidence.filter(ref => ref.collection === 'programs'
    && ref.source_key === 'academic-programs' && ref.field === 'customFields.rJQmj'
    && program.links.some(link => link.collection === ref.collection && link.source_key === ref.source_key
      && link.source_record_keys.includes(ref.source_record_key)));
  if (references.length !== 1 || !Number.isFinite(Date.parse(text(capture.collected_at)))
    || !text(capture.source_url).startsWith('https://')) return null;
  const ref = references[0];
  let code: string;
  try {
    const source = new URL(ref.source_url || '');
    if (source.protocol !== 'https:' || source.hostname !== 'catalog.ramapo.edu'
      || !/^\/programs\/[^/]+$/.test(source.pathname)) return null;
    code = decodeURIComponent(source.pathname.slice('/programs/'.length));
  } catch { return null; }
  if (ref.source_record_key.startsWith('catalog:') && ref.source_record_key !== `catalog:${code}`) return null;
  const matches = rows(capture.programs).filter(item => item.catalogCode === code && item.catalogUrl === ref.source_url);
  const rawField = matches.length === 1 ? text(row(matches[0].customFields).rJQmj) : '';
  if (!rawField.trim() || !links(rawField).length) return null;
  return { catalog_code: code, source_record_key: ref.source_record_key, source_url: ref.source_url!,
    capture_source_url: text(capture.source_url), collected_at: text(capture.collected_at),
    field: 'customFields.rJQmj', raw_field: rawField };
}

function verifyTarget(entity: CampusIdentity | undefined, field: ConvenerFieldEvidence,
  owners: Map<string, Set<string>>): VerifiedTarget | null {
  if (!entity || entity.kind !== 'person') return null;
  const matches = links(field.raw_field).filter(link => {
    const ids = owners.get(reviewedUrl(link.profile_url));
    return ids?.size === 1 && ids.has(entity.id);
  });
  if (!matches.length) return null;
  return { entity_id: entity.id, name: entity.name, source_profile_url: matches[0].profile_url,
    faculty_profile_url: reviewedUrl(matches[0].profile_url) };
}

/** A changed relationship alone is insufficient: both catalog fields and the
 * replacement's unique, published faculty identity must establish the change.
 * Missing fields, unresolved URLs, surviving old names and collisions fail closed.
 */
export function reviewConvenerReplacements(previous: CampusIdentities, candidate: CampusIdentities,
  previousCatalog: unknown, candidateCatalog: unknown): ConvenerReplacementReview {
  const review: ConvenerReplacementReview = { replacements: [], rejected: [] };
  const oldEntities = new Map(previous.entities.map(entity => [entity.id, entity]));
  const newEntities = new Map(candidate.entities.map(entity => [entity.id, entity]));
  const oldOwners = facultyOwners(previous); const newOwners = facultyOwners(candidate);
  for (const before of previous.entities.filter(entity => entity.kind === 'program')) {
    const after = newEntities.get(before.id);
    if (!after || after.kind !== 'program') continue;
    for (const relation of conveners(before)) {
      if (!newEntities.has(relation.target_entity_id) || conveners(after).some(current => current.target_entity_id === relation.target_entity_id)) continue;
      const reject = (reason: string) => review.rejected.push({ program_id: before.id, previous_target_id: relation.target_entity_id, reason });
      const previousField = fieldEvidence(before, relation, previousCatalog);
      const previousPerson = oldEntities.get(relation.target_entity_id);
      const previousTarget = previousField ? verifyTarget(previousPerson, previousField, oldOwners) : null;
      if (!previousField || !previousTarget || !previousPerson) { reject('Previous relationship lacks unique catalog and faculty evidence.'); continue; }
      const replacementFields = conveners(after).map(current => ({ relation: current, field: fieldEvidence(after, current, candidateCatalog) }));
      if (!replacementFields.length || replacementFields.some(item => !item.field)) { reject('No complete current Convener-field evidence for a replacement.'); continue; }
      const oldNames = [previousPerson.name, ...previousPerson.aliases, ...links(previousField.raw_field)
        .filter(link => reviewedUrl(link.profile_url) === previousTarget.faculty_profile_url).map(link => link.name)]
        .map(nameKey).filter(Boolean);
      const retainsOld = replacementFields.some(({ field }) => {
        const content = field!.raw_field;
        const plain = ` ${nameKey(fieldText(content))} `;
        return links(content).some(link => reviewedUrl(link.profile_url) === previousTarget.faculty_profile_url)
          || oldNames.some(name => plain.includes(` ${name} `));
      });
      if (retainsOld) { reject('Current Convener field still names or links the previous target.'); continue; }
      const replacements = replacementFields.flatMap(({ relation: current, field }) => {
        const target = verifyTarget(newEntities.get(current.target_entity_id), field!, newOwners);
        return target ? [{ target, evidence: field! }] : [];
      });
      if (!replacements.length) { reject('Current Convener links have no uniquely verified replacement target.'); continue; }
      review.replacements.push({ relationship_key: JSON.stringify([before.id, 'convener', 'entity', relation.target_entity_id]),
        program_id: before.id, program_name: before.name, previous_target_id: relation.target_entity_id,
        previous_target: previousTarget, previous: previousField, replacements });
    }
  }
  return review;
}
