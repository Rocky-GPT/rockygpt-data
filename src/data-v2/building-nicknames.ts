import type { CampusIdentity } from './campus-identities';
import { readsAsOffice } from './campus-identities';
import { campusBuildingId, type CampusBuildingsArtifact } from './campus-buildings';
import { placeName } from './campus-map-places';
import type { IdentityCoverageIssue } from './compile-campus-identities';
import { noteAlias, type AliasLedger } from './identity-aliases';

/**
 * @module data-v2/building-nicknames
 * The campus map's search names as building nicknames (since November 3, 2026).
 *
 * The map's search box finds a building by short names it lists for it: "gym" for the Bill
 * Bradley Sports and Recreation Center, "d wing" for Academic Building D, "havemeyer" for the
 * Arch. Students say them too ("is the gym open?"), so each becomes an alias of its building,
 * citing the building record's `search_names` field. A search name that would name something
 * else is skipped, and the coverage report says why:
 *
 * - it starts with "a" or "an" ("a wing", "a building"), which reads as plain English;
 * - the map lists it for two buildings ("laurel hall" for both Laurel Hall buildings);
 * - another node, or a place the map lists inside a building, is called it, compared as
 *   `placeName` compares names: "library" is the Library office's other name, "atrium" The
 *   Atrium's, "bradley center" the lounge's directory name;
 * - a place outside the building has it in its name: "fitness center" is in the Lodge Fitness
 *   Center's name, in The Lodge, so a question about that one would be taken for the building.
 *   Places inside the building may share it ("h wing" in the H-Wing Auditorium, in H).
 *
 * Run after the other alias rules and before the map's places are matched by name, so an
 * event listed at "D Wing" is placed by it too.
 */

type Row = Record<string, unknown>;
const text = (value: unknown): string => typeof value === 'string' ? value.trim() : '';
const decode = (value: string): string => value.replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();
/** A name's words, case, "&" and punctuation aside, and no word dropped: "H-Wing" is "h wing". */
export const spokenName = (value: string): string => decode(value).toLowerCase().replace(/&/g, ' and ')
  .replace(/[’']/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const ARTICLE = /^(a|an)\s/i;
/** Kinds a student asks for as a place to go: their names are what a nickname must not take. */
const PLACES = ['office', 'venue', 'facility'];

export interface BuildingNicknames { applied: number; unresolved: IdentityCoverageIssue[] }

export function applyBuildingNicknames(entities: CampusIdentity[], artifact: CampusBuildingsArtifact, map: unknown,
  ledger: AliasLedger): BuildingNicknames {
  const unresolved: IdentityCoverageIssue[] = [];
  const byId = new Map(entities.map(entity => [entity.id, entity]));
  // Every name a node or a map place goes by, as placeName and as said, with who goes by it.
  const called = new Map<string, Map<string, string>>();
  const call = (name: string, owner: string, label: string) => {
    for (const key of new Set([placeName(name), spokenName(name)])) if (key) called.set(key, (called.get(key) ?? new Map()).set(owner, label));
  };
  for (const entity of entities) for (const name of [entity.name, ...entity.aliases]) call(name, entity.id, `${entity.kind} "${entity.name}"`);
  const mapPlaces = (Array.isArray((map as Row)?.offices) ? (map as Row).offices as Row[] : [])
    .map(row => ({ name: decode(text(row.name)), building: text(row.buildingKey) })).filter(place => place.name);
  for (const place of mapPlaces) call(place.name, `map:${place.name}`, `map place "${place.name}"`);
  // Places a student asks for, each with the buildings it is in: its located_at links, and the
  // map entry of its name (the map places are joined to nodes after this runs).
  const byMapKey = new Map(artifact.buildings.map(building => [building.map_key, campusBuildingId(building)]));
  const mapIn = new Map<string, Set<string>>();
  for (const place of mapPlaces) {
    const building = byMapKey.get(place.building);
    if (building) mapIn.set(placeName(place.name), new Set([...mapIn.get(placeName(place.name)) ?? [], building]));
  }
  const places = [
    ...entities.filter(entity => PLACES.includes(entity.kind) || readsAsOffice(entity)).map(entity => ({
      label: `${entity.kind} "${entity.name}"`, names: [entity.name, ...entity.aliases],
      in: new Set([...(entity.relationships ?? []).flatMap(r => r.type === 'located_at' && 'target_entity_id' in r ? [r.target_entity_id] : []),
        ...mapIn.get(placeName(entity.name)) ?? []]),
    })),
    ...mapPlaces.map(place => ({ label: `map place "${place.name}"`, names: [place.name],
      in: new Set(byMapKey.has(place.building) ? [byMapKey.get(place.building)!] : []) })),
  ];
  const listed = new Map<string, number>();
  for (const building of artifact.buildings) for (const name of new Set((building.search_names ?? []).map(placeName))) listed.set(name, (listed.get(name) ?? 0) + 1);
  let applied = 0;
  for (const building of artifact.buildings) {
    const id = campusBuildingId(building);
    const entity = byId.get(id);
    if (!entity) continue;
    for (const nickname of building.search_names ?? []) {
      const said = spokenName(nickname);
      if (!said || [entity.name, ...entity.aliases].some(name => spokenName(name) === said)) continue;
      const others = [...new Set([placeName(nickname), said])].flatMap(key => [...called.get(key) ?? []]).filter(([owner]) => owner !== id).map(([, label]) => label);
      const outside = places.find(place => !place.in.has(id) && place.names.some(name => ` ${spokenName(name)} `.includes(` ${said} `)));
      const reason = ARTICLE.test(nickname) ? 'starts with "a" or "an" and reads as plain English'
        : (listed.get(placeName(nickname)) ?? 0) > 1 ? 'is listed for more than one building'
          : others.length ? `is already the name of ${[...new Set(others)].slice(0, 3).join(' and ')}`
            : outside ? `is part of the name of ${outside.label}, which is not in this building`
              : entity.aliases.length >= 32 ? 'does not fit: the building already has 32 aliases' : null;
      if (reason) {
        unresolved.push({ entity: building.name, collection: 'buildings', record: building.record_key, reason: `The campus map's search name "${nickname}" ${reason}; it is not a nickname of this building.`, kind: 'note' });
        continue;
      }
      entity.aliases = [...entity.aliases, nickname];
      noteAlias(ledger, id, nickname, { basis: 'map_search_name', evidence: { collection: 'buildings', source_key: artifact.source.source_key,
        source_record_key: building.record_key, field: 'search_names', source_url: building.map_url } });
      call(nickname, id, `building "${building.name}"`);
      applied++;
    }
  }
  return { applied, unresolved };
}
