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

test('an office that is an Archway group too is filed in its category; a school is not', () => {
  const yearbook = club(4, 'Yearbook', 'office');
  const school = club(5, 'Anisfield School of Business', 'school');
  linkClubCategories([yearbook, school], [
    { source_key: 'archway-clubs', source_record_key: 'Yearbook', category: 'Student Organization - Media' },
    { source_key: 'archway-clubs', source_record_key: 'Anisfield School of Business', category: 'Academic Department' },
  ]);
  assert.deepEqual(yearbook.relationships?.map(r => 'target_entity_id' in r ? r.target_entity_id : null), [clubCategoryId('Student Organization')]);
  assert.equal(school.relationships, undefined);
});

test('a club page no club is named like joins the one Archway group whose own email it gives', () => {
  const csi: CampusIdentity = { id: '00000000-0000-4000-8000-000000000030', kind: 'office', name: 'Center for Student Involvement', aliases: [], links: [
    { collection: 'office_sections', source_key: 'office-pages', source_record_keys: ['ivcf', 'tau', 'sga', 'chess'].map(s => `www.ramapo.edu/clubs/organization/${s}/`) }] };
  const ivcf = club(1, 'InterVarsity Christian Fellowship');
  const tau = club(2, 'Tau Sigma');
  const ald = club(3, 'Alpha Lambda Delta');
  const sga = club(4, 'Student Government Association', 'office');
  const listing = (name: string, email: string) => ({ source_key: 'archway-clubs', source_record_key: name, listing: { name, email } });
  const result = linkClubPages([csi, ivcf, tau, ald, sga], [
    page('ivcf', 'Inter-Varsity Christian Fellowship (IVCF)', 'Small groups meet weekly. Email: IVCF@ramapo.edu (mailto:ivcf@ramapo.edu)'),
    page('tau', 'Tau Sigma National Honor Society', 'Advisor: mgregory@ramapo.edu'),
    page('sga', 'Student Government Association (SGA)', 'Email: sga@ramapo.edu'),
    page('chess', 'Ramapo Chess', 'Email: chess@ramapo.edu'),
  ], [
    listing('InterVarsity Christian Fellowship', 'ivcf@ramapo.edu'),
    // An adviser's own address two groups list names neither.
    listing('Tau Sigma', 'mgregory@ramapo.edu'), listing('Alpha Lambda Delta', 'mgregory@ramapo.edu'),
    listing('Student Government Association', 'sga@ramapo.edu'),
  ]);
  assert.deepEqual(ivcf.links[1], { collection: 'office_sections', source_key: 'office-pages', source_record_keys: ['www.ramapo.edu/clubs/organization/ivcf/'] });
  assert.deepEqual(ivcf.relationships, [{ type: 'listed_by', target_entity_id: csi.id, evidence: [{ collection: 'office_sections', source_key: 'office-pages',
    source_record_key: 'www.ramapo.edu/clubs/organization/ivcf/', field: 'email', source_url: 'https://www.ramapo.edu/clubs/organization/ivcf/' }] }]);
  assert.deepEqual([tau.links.length, ald.links.length, tau.relationships, ald.relationships], [1, 1, undefined, undefined]);
  // A group that is an office keeps its own site, as with a name.
  assert.deepEqual([sga.links.length, sga.relationships], [1, undefined]);
  assert.deepEqual(result.entities, []);
  assert.deepEqual(result.unresolved.map(u => u.entity), ['Tau Sigma National Honor Society', 'Ramapo Chess']);
  assert.match(result.unresolved[0].reason, /no Archway club has its name or its email/);
});

test("a fraternity or sorority chapter's page joins the Archway chapter it names, Greek letters aside", () => {
  const fsl: CampusIdentity = { id: '00000000-0000-4000-8000-000000000031', kind: 'office', name: 'Office of Fraternity and Sorority Life', aliases: [], links: [
    { collection: 'office_sections', source_key: 'office-pages', source_record_keys: ['alpha-kappa-alpha', 'omega-psi-phi', 'alpha-chi-rho'].map(s => `www.ramapo.edu/greek/chapters/${s}/`) }] };
  const aka = club(1, 'Alpha Kappa Alpha Sorority, Inc.');
  const opp = club(2, 'Omega Psi Phi Fraternity, Inc.');
  const chapterPage = (slug: string, heading: string, text: string) => ({ ...page(slug, heading, text),
    source_record_key: `www.ramapo.edu/greek/chapters/${slug}/`, url: `https://www.ramapo.edu/greek/chapters/${slug}/`, site_folder: 'greek' });
  const result = linkClubPages([fsl, aka, opp], [
    chapterPage('alpha-kappa-alpha', 'Alpha Kappa Alpha Sorority, Inc. - ΑΚΑ', 'Founded 1908.'),
    chapterPage('omega-psi-phi', 'Omega Psi Phi Fraternity, Incorporated - ΩΨΦ', 'Founded 1911.'),
    chapterPage('alpha-chi-rho', 'Alpha Chi Rho - ΑΧΡ', `Disciplinary history for chapter. ${INACTIVE}`),
  ]);
  for (const [chapter, slug] of [[aka, 'alpha-kappa-alpha'], [opp, 'omega-psi-phi']] as const) {
    assert.deepEqual(chapter.links[1], { collection: 'office_sections', source_key: 'office-pages', source_record_keys: [`www.ramapo.edu/greek/chapters/${slug}/`] });
    assert.deepEqual(chapter.relationships?.map(r => [r.type, 'target_entity_id' in r ? r.target_entity_id : null, r.evidence[0].field]), [['listed_by', fsl.id, 'name']]);
    assert.equal(chapter.status, undefined);
  }
  // A chapter page no Archway chapter matches is reported, never made a node, whatever it says.
  assert.deepEqual(result.entities, []);
  assert.deepEqual(result.unresolved.map(u => [u.entity, u.kind]), [['Alpha Chi Rho', 'unlinked_record']]);
});

test("a council's page joins the Archway group named like it, or the one whose Archway site its abbreviation names, never by email", () => {
  const councils = ['cph', 'nphc', 'ifc', 'unrecognized-or-inactive-chapters'].map(s => `www.ramapo.edu/greek/chapters-councils/${s}/`);
  const fsl: CampusIdentity = { id: '00000000-0000-4000-8000-000000000031', kind: 'office', name: 'Office of Fraternity and Sorority Life', aliases: [], links: [
    { collection: 'office_sections', source_key: 'office-pages', source_record_keys: councils }] };
  const cph = club(1, 'College Panhellenic Council');
  const nphc = club(2, 'National Pan-Hellenic Conference');
  const tke = club(3, 'Tau Kappa Epsilon');
  const councilPage = (slug: string, heading: string, text: string) => ({ ...page(slug, heading, text),
    source_record_key: `www.ramapo.edu/greek/chapters-councils/${slug}/`, url: `https://www.ramapo.edu/greek/chapters-councils/${slug}/`, site_folder: 'greek' });
  const clubs = [
    { source_key: 'archway-clubs', source_record_key: 'College Panhellenic Council', website_url: 'https://archway.ramapo.edu/CPH/', listing: {} },
    { source_key: 'archway-clubs', source_record_key: 'National Pan-Hellenic Conference', website_url: 'https://archway.ramapo.edu/NPHC/', listing: {} },
    // The IFC president's own address is a chapter's Archway email; the IFC page must not join that chapter.
    { source_key: 'archway-clubs', source_record_key: 'Tau Kappa Epsilon', website_url: 'https://archway.ramapo.edu/TKE/', listing: { email: 'mcirill3@ramapo.edu' } },
  ];
  const result = linkClubPages([fsl, cph, nphc, tke], [
    councilPage('cph', 'College Panhellenic Council (CPH)', 'At Ramapo, there are six (6) NPC member sororities.'),
    councilPage('nphc', 'National Pan-Hellenic Council (NPHC)', 'At Ramapo, we currently have four (4) active NPHC chapters.'),
    councilPage('ifc', 'Interfraternity Council (IFC)', 'President E-mail: mcirill3@ramapo.edu'),
    councilPage('unrecognized-or-inactive-chapters', 'Unrecognized and Inactive Chapters', `Chapter closure. ${INACTIVE}`),
  ], clubs);
  for (const [council, slug, joined] of [[cph, 'cph', 'name'], [nphc, 'nphc', 'website_url']] as const) {
    assert.deepEqual(council.links[1], { collection: 'office_sections', source_key: 'office-pages', source_record_keys: [`www.ramapo.edu/greek/chapters-councils/${slug}/`] });
    assert.deepEqual(council.relationships?.map(r => [r.type, 'target_entity_id' in r ? r.target_entity_id : null, r.evidence[0].field]), [['listed_by', fsl.id, joined]]);
    assert.equal(council.status, undefined);
  }
  assert.deepEqual(tke.links.length, 1);
  assert.equal(tke.relationships, undefined);
  // A council no Archway group is named or sited like is reported; the inactive-chapters list is no council.
  assert.deepEqual(result.entities, []);
  assert.deepEqual(result.unresolved.map(u => [u.entity, u.kind]), [['Interfraternity Council', 'unlinked_record']]);
});
