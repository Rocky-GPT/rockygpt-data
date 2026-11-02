import assert from 'node:assert/strict';
import test from 'node:test';
import type { CampusIdentity } from './campus-identities';
import { clubCategoryId, clubPageIdentityId, linkClubCategories, linkClubPages } from './club-links';

const club = (n: number, name: string, kind: CampusIdentity['kind'] = 'club'): CampusIdentity => ({
  id: `00000000-0000-4000-8000-00000000002${n}`, kind, name, aliases: [],
  links: [{ collection: 'clubs', source_key: 'archway-clubs', source_record_keys: [name] }],
});
const page = (slug: string, heading: string, text: string) => ({
  source_key: 'office-pages', source_record_key: `www.ramapo.edu/clubs/organization/${slug}/`,
  url: `https://www.ramapo.edu/clubs/organization/${slug}/`, site_folder: 'clubs',
  sections: [{ heading: 'Related Resources', text: 'CSI' }, { heading, text }],
});
const INACTIVE = 'THIS IS NOT CURRENTLY AN ACTIVE CLUB AT RAMAPO COLLEGE AS OF 6/12/25. DETAILS BELOW EXPLAIN WHAT THE CLUB WAS.';

test('each Archway club is in the category Archway files it under', () => {
  const beta = club(1, 'Beta Alpha Psi');
  const math = club(2, 'Math Club');
  const athletics = club(3, 'Athletics', 'organization');
  const result = linkClubCategories([beta, math, athletics], [
    { source_key: 'archway-clubs', source_record_key: 'Beta Alpha Psi', category: 'Honor Society - Professional', website_url: 'https://archway.ramapo.edu/BAPsi/' },
    { source_key: 'archway-clubs', source_record_key: 'Math Club', category: 'Student Organization' },
    { source_key: 'archway-clubs', source_record_key: 'Athletics', category: '' },
  ], '2026-11-02T00:00:00Z');
  assert.deepEqual(result.entities.map(e => [e.id, e.kind, e.name]), [
    [clubCategoryId('Honor Society'), 'club_category', 'Honor Society'], [clubCategoryId('Student Organization'), 'club_category', 'Student Organization']]);
  assert.deepEqual(beta.relationships, [{ type: 'in_category', target_entity_id: clubCategoryId('Honor Society'), evidence: [
    { collection: 'clubs', source_key: 'archway-clubs', source_record_key: 'Beta Alpha Psi', field: 'category', source_url: 'https://archway.ramapo.edu/BAPsi/' }] }]);
  assert.equal(athletics.relationships, undefined);
  assert.deepEqual(result.records.rows.map(r => [r.source_record_key, r.filed_as]), [['Honor Society', ['Honor Society - Professional']], ['Student Organization', ['Student Organization']]]);
  assert.equal(result.records.collected_at, '2026-11-02T00:00:00Z');
});

test('the ramapo.edu club directory lists clubs, marks inactive ones, and adds inactive clubs Archway dropped', () => {
  const csi: CampusIdentity = { id: '00000000-0000-4000-8000-000000000030', kind: 'office', name: 'Center for Student Involvement', aliases: [], links: [
    { collection: 'office_sections', source_key: 'office-pages', source_record_keys: ['www.ramapo.edu/clubs/organization/math-club/', 'www.ramapo.edu/clubs/organization/garden-club/', 'www.ramapo.edu/clubs/organization/bass-fishing-club/', 'www.ramapo.edu/clubs/organization/debate-club/'] }] };
  const math = club(1, 'Math Club');
  const garden = club(2, 'Garden Club');
  const result = linkClubPages([csi, math, garden], [
    page('math-club', 'Math Club', 'Numbers.'), page('garden-club', 'Garden Club', INACTIVE),
    page('bass-fishing-club', 'Bass Fishing Club**', INACTIVE), page('debate-club', 'Debate Club', 'Argue.'),
  ]);
  assert.deepEqual(math.relationships?.map(r => [r.type, 'target_entity_id' in r ? r.target_entity_id : null]), [['listed_by', csi.id]]);
  assert.deepEqual(math.links[1], { collection: 'office_sections', source_key: 'office-pages', source_record_keys: ['www.ramapo.edu/clubs/organization/math-club/'] });
  assert.equal(math.status, undefined);
  assert.equal(garden.status?.state, 'inactive');
  assert.deepEqual(garden.status, { state: 'inactive', as_of: '2025-06-12', evidence: [{ collection: 'office_sections', source_key: 'office-pages',
    source_record_key: 'www.ramapo.edu/clubs/organization/garden-club/', field: 'status', source_url: 'https://www.ramapo.edu/clubs/organization/garden-club/' }] });
  // An inactive club Archway no longer lists is a node, so asking about it says it is not active.
  assert.deepEqual(result.entities.map(e => [e.id, e.name, e.status?.state]), [[clubPageIdentityId('www.ramapo.edu/clubs/organization/bass-fishing-club/'), 'Bass Fishing Club', 'inactive']]);
  // An active page with no Archway club is reported, never a second club.
  assert.deepEqual(result.unresolved.map(u => u.entity), ['Debate Club']);
});
