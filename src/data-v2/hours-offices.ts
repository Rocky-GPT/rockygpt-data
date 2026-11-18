import type { CampusIdentity } from './campus-identities';
import type { IdentityCoverageIssue } from './compile-campus-identities';
import { normalizeName } from './archway-identities';
import { pythonJsonStrings, uuid5 } from './course-identities';

type Row = Record<string, unknown>;
const text = (value: unknown): string => typeof value === 'string' ? value.trim() : '';
const NAMESPACE_URL = Buffer.from('6ba7b8119dad11d180b400c04fd430c8', 'hex');
const DESK_KINDS: ReadonlyArray<CampusIdentity['kind']> = ['office', 'venue', 'facility', 'organization', 'club'];

/** The office a schedule belongs to: its name without the season or audience in brackets ("(Summer)"). */
export function hoursOfficeName(scheduleName: string): string {
  return scheduleName.replace(/\s*\([^)]*\)\s*$/, '').trim();
}

export function hoursOfficeId(name: string): string {
  return uuid5(NAMESPACE_URL, pythonJsonStrings(['rockygpt', 'hours-office', normalizeName(name)]));
}

/**
 * Hours no identity holds, by the office name their own hours page gives (audit 2026-11-17, cause 5).
 * Office names came only from reviewed lists and the Archway club list, so an office renamed on
 * Archway lost its hours: on 11-17 the Multicultural Center's and the Veterans Lounge's hours were
 * collected, but no node held them and no answer could give them. Now each such schedule joins the
 * one desk already named exactly like its office, or a new office node of that name; two desks of
 * that name are reported instead of guessed between. Runs before linkHoursDesks, which then lists a
 * new desk under the office whose page its hours are read from.
 */
export function linkHoursOffices(entities: CampusIdentity[], hours: readonly Row[], unresolved: IdentityCoverageIssue[]):
  { created: number; joined: number } {
  const held = new Set(entities.flatMap((entity) => entity.links.filter((link) => link.collection === 'campus_hours')
    .flatMap((link) => link.source_record_keys.map((key) => `${link.source_key}:${key}`))));
  const groups = new Map<string, { name: string; source: string; keys: string[] }>();
  for (const row of hours) {
    const source = text(row.source_key); const key = text(row.source_record_key); const name = hoursOfficeName(text(row.name));
    if (!source || !key || !name || held.has(`${source}:${key}`)) continue;
    const group = groups.get(`${source}:${normalizeName(name)}`) ?? { name, source, keys: [] };
    group.keys.push(key);
    groups.set(`${source}:${normalizeName(name)}`, group);
  }
  const count = { created: 0, joined: 0 };
  const linked = new Set<string>();
  for (const group of groups.values()) {
    const named = entities.filter((entity) => DESK_KINDS.includes(entity.kind)
      && [entity.name, ...entity.aliases].some((alias) => normalizeName(alias) === normalizeName(group.name)));
    const link = { collection: 'campus_hours' as const, source_key: group.source, source_record_keys: [...group.keys].sort() };
    if (named.length > 1) {
      unresolved.push({ entity: group.name, collection: 'campus_hours', record: link.source_record_keys.join(', '), kind: 'missing_connection',
        reason: `${named.length} nodes are named ${group.name}; its hours are not given to either.` });
      continue;
    }
    if (named.length === 1) {
      const existing = named[0].links.find((candidate) => candidate.collection === 'campus_hours' && candidate.source_key === group.source);
      if (existing) existing.source_record_keys = [...new Set([...existing.source_record_keys, ...link.source_record_keys])].sort();
      else named[0].links.push(link);
      count.joined++;
    } else {
      entities.push({ id: hoursOfficeId(group.name), kind: 'office', name: group.name, aliases: [], links: [link] });
      count.created++;
    }
    for (const key of group.keys) linked.add(key);
  }
  // Hours an identity now holds are no longer reported as held by none.
  for (let index = unresolved.length - 1; index >= 0; index--) {
    const issue = unresolved[index];
    if (issue.kind !== 'unlinked_record' || issue.collection !== 'campus_hours') continue;
    if (linked.has(issue.record ?? '') || entities.some((entity) => entity.links.some((candidate) =>
      candidate.collection === 'campus_hours' && candidate.source_record_keys.includes(issue.record ?? '')))) unresolved.splice(index, 1);
  }
  return count;
}
