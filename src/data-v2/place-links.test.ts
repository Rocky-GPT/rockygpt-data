import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import type { CampusIdentity } from './campus-identities';
import { campusBuildingId, campusBuildingsArtifact } from './campus-buildings';
import { linkGroupWebsites, linkPlaces, linkReviewedPlacements, websiteOf, type ReviewedPlacement, type ReviewedPlacements } from './place-links';

const node = (n: number, kind: CampusIdentity['kind'], name: string, links: CampusIdentity['links'] = []): CampusIdentity =>
  ({ id: `00000000-0000-4000-8000-00000000050${n}`, kind, name, aliases: [], links });
const targets = (entity: CampusIdentity) => (entity.relationships ?? []).map(r => [r.type, 'target_entity_id' in r ? r.target_entity_id : null]);
const contact = (key: string, website: string) => [`campus-directory:${key}`, { normalization_metadata: { evidence: { website: { url: website } } } }] as const;
const group = (n: number, kind: CampusIdentity['kind'], name: string) => node(n, kind, name, [{ collection: 'clubs', source_key: 'archway-clubs', source_record_keys: [name] }]);
const club = (name: string, website: string) => ({ id: '61c703dc-1deb-4a9b-8c4e-7663c08b5295', source_key: 'archway-clubs', source_record_key: name, website_url: website });

test('a group whose website is a page inside one office\'s website is listed by that office', () => {
  const athletics = node(1, 'office', 'Athletics', [{ collection: 'contacts', source_key: 'campus-directory', source_record_keys: ['office:athletics'] }]);
  const success = node(2, 'office', 'Center for Student Success', [{ collection: 'contacts', source_key: 'campus-directory', source_record_keys: ['office:css'] }]);
  const career = node(3, 'office', 'Cahill Career Development Center', [{ collection: 'contacts', source_key: 'campus-directory', source_record_keys: ['office:career'] }]);
  const home = node(4, 'office', 'Ramapo College', [{ collection: 'contacts', source_key: 'campus-directory', source_record_keys: ['office:home'] }]);
  const baseball = group(5, 'club', 'RCNJ Baseball');
  const transfer = group(6, 'club', 'Transfer Connection');
  const cahill = group(7, 'organization', 'Cahill Career Center');
  const chess = group(8, 'club', 'Chess Club');
  const contacts = new Map<string, Record<string, unknown>>([contact('office:athletics', 'https://ramapoathletics.com/'),
    contact('office:css', 'https://www.ramapo.edu/studentsuccess/'), contact('office:career', 'https://www.ramapo.edu/careercenter/'),
    contact('office:home', 'https://www.ramapo.edu/')]);
  const clubs = [club('RCNJ Baseball', 'https://ramapoathletics.com/sports/baseball'), club('Transfer Connection', 'https://www.ramapo.edu/studentsuccess/transfer-connection'),
    club('Cahill Career Center', 'https://www.ramapo.edu/careercenter/'), club('Chess Club', 'https://www.ramapo.edu/clubs/organization/chess/')];
  const result = linkGroupWebsites([athletics, success, career, home, baseball, transfer, cahill, chess], clubs, contacts);
  assert.equal(result.linked, 2);
  assert.deepEqual(targets(baseball), [['listed_by', athletics.id]]);
  assert.deepEqual(baseball.relationships?.[0].evidence, [{ collection: 'clubs', source_key: 'archway-clubs', source_record_key: 'RCNJ Baseball',
    source_record_id: '61c703dc-1deb-4a9b-8c4e-7663c08b5295', field: 'website_url', source_url: 'https://ramapoathletics.com/sports/baseball' }]);
  assert.deepEqual(targets(transfer), [['listed_by', success.id]]);
  // A website that is an office's own website is a possible duplicate, reported and never linked;
  // the college's home page is no office's site in particular.
  assert.deepEqual(targets(cahill), []);
  assert.deepEqual(targets(chess), []);
  assert.deepEqual(result.unresolved.map(u => [u.entity, u.kind]), [['Cahill Career Center', 'note']]);
});

test('a group whose website is inside two offices\' websites is listed by neither', () => {
  const emergency = node(1, 'office', 'Public Safety (Emergency)', [{ collection: 'contacts', source_key: 'campus-directory', source_record_keys: ['office:a'] }]);
  const line = node(2, 'office', 'Public Safety (Non-Emergency)', [{ collection: 'contacts', source_key: 'campus-directory', source_record_keys: ['office:b'] }]);
  const patrol = group(3, 'organization', 'Student Patrol');
  const contacts = new Map<string, Record<string, unknown>>([contact('office:a', 'https://www.ramapo.edu/publicsafety/'), contact('office:b', 'https://www.ramapo.edu/publicsafety')]);
  const result = linkGroupWebsites([emergency, line, patrol], [club('Student Patrol', 'https://www.ramapo.edu/publicsafety/patrol/')], contacts);
  assert.equal(result.linked, 0);
  assert.deepEqual(targets(patrol), []);
  assert.deepEqual(result.unresolved.map(u => [u.entity, u.kind]), [['Student Patrol', 'missing_connection']]);
  assert.deepEqual(websiteOf('https://WWW.Ramapo.edu/PublicSafety?x=1'), { host: 'ramapo.edu', path: '/publicsafety/', url: 'https://WWW.Ramapo.edu/PublicSafety?x=1' });
});

const map = { buildings: [
  { key: 'building_c', name: 'Academic Building C', mapUrl: 'https://map.ramapo.edu/?id=2292#!m/1133370?sbc/', roomPrefixes: ['C'] },
  { key: 'building_e', name: 'Academic Building E', mapUrl: 'https://map.ramapo.edu/?id=2292#!m/1133372?sbc/', roomPrefixes: ['E'] },
] };
const ovpPage = { source_key: 'office-pages', source_record_key: 'www.ramapo.edu/csi/ovp/', url: 'https://www.ramapo.edu/csi/ovp/', sections: [
  { heading: 'Office of Violence Prevention', text: 'Location:  C-216 (near the fishbowl) Phone: (201) 684-7430' }] };
const placement = (over: Partial<ReviewedPlacement> = {}): ReviewedPlacement => ({ node: 'Office of Violence Prevention', building: 'Academic Building C', room: 'C-216',
  url: 'https://www.ramapo.edu/csi/ovp/', section: 'Office of Violence Prevention', quote: 'Location: C-216 (near the fishbowl)', reviewed_at: '2026-11-03', note: '', ...over });

test('a reviewed placement places its node while its section still gives the room, cited to the building\'s reviewed locations', () => {
  const artifact = campusBuildingsArtifact(map);
  const ovp = node(1, 'organization', 'Office of Violence Prevention');
  const result = linkReviewedPlacements([ovp], [ovpPage], { placements: [placement()] }, artifact);
  assert.equal(result.linked, 1);
  assert.deepEqual(result.unresolved, []);
  const buildingC = artifact.buildings.find(b => b.name === 'Academic Building C')!;
  assert.deepEqual(targets(ovp), [['located_at', campusBuildingId(buildingC)]]);
  assert.deepEqual(ovp.relationships?.[0].evidence, [{ collection: 'buildings', source_key: 'campus-map', source_record_key: '1133370', field: 'reviewed_locations', source_url: 'https://www.ramapo.edu/csi/ovp/' }]);
  assert.deepEqual(buildingC.reviewed_locations, [{ entity_id: ovp.id, entity: 'Office of Violence Prevention', statement: 'Location: C-216 (near the fishbowl)',
    source_url: 'https://www.ramapo.edu/csi/ovp/', reviewed_at: '2026-11-03' }]);
});

test('a reviewed placement is withheld when its words are gone, its room is not theirs or not its building\'s, or its node is two', () => {
  const run = (reviewed: ReviewedPlacements, entities = [node(1, 'organization', 'Office of Violence Prevention')]) => {
    const artifact = campusBuildingsArtifact(map);
    const result = linkReviewedPlacements(entities, [ovpPage], reviewed, artifact);
    return { result, entities, locations: artifact.buildings.flatMap(b => b.reviewed_locations ?? []) };
  };
  for (const reviewed of [
    { placements: [placement({ quote: 'Location: C-216 (behind the fishbowl)' })] },
    { placements: [placement({ section: 'Contact' })] },
    { placements: [placement({ room: 'C-217' })] },
    { placements: [placement({ building: 'Academic Building E' })] },
    { placements: [placement({ building: 'Academic Building Z' })] },
  ]) {
    const { result, entities, locations } = run(reviewed);
    assert.equal(result.linked, 0);
    assert.equal(result.unresolved.length, 1);
    assert.deepEqual(targets(entities[0]), []);
    assert.deepEqual(locations, []);
  }
  const twice = run({ placements: [placement()] }, [node(1, 'organization', 'Office of Violence Prevention'), node(2, 'office', 'Office of Violence Prevention')]);
  assert.equal(twice.result.linked, 0);
  assert.deepEqual(twice.entities.map(targets), [[], []]);
  const person = run({ placements: [placement()] }, [node(1, 'person', 'Office of Violence Prevention')]);
  assert.equal(person.result.linked, 0);
});

test('linkPlaces runs both and returns what each linked', () => {
  const ovp = node(1, 'organization', 'Office of Violence Prevention');
  const result = linkPlaces([ovp], [], new Map(), [ovpPage], { placements: [placement()] }, campusBuildingsArtifact(map));
  assert.deepEqual([result.listed_by, result.located_at, result.unresolved.length], [0, 1, 0]);
});

test('every reviewed placement gives its room in its quote, and the committed map gives the room\'s prefix to its building', async () => {
  const reviewed = (await import('../reference/reviewed-listings.json')).default as ReviewedPlacements;
  const committed = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../data/map/campus-map-data.json'), 'utf8'));
  const artifact = campusBuildingsArtifact(committed);
  assert.ok((reviewed.placements ?? []).length > 0);
  for (const entry of reviewed.placements ?? []) {
    assert.ok(entry.quote.includes(entry.room), `${entry.node}: the quote gives ${entry.room}`);
    const building = artifact.buildings.filter(b => b.name === entry.building);
    assert.equal(building.length, 1, `${entry.building} is one building on the committed map`);
    assert.ok(building[0].room_prefixes.includes(entry.room.split('-')[0]), `${entry.room} is a room of ${entry.building}`);
    for (const field of ['url', 'section', 'reviewed_at', 'note'] as const) assert.ok(entry[field].trim(), `${entry.node}: ${field}`);
  }
});
