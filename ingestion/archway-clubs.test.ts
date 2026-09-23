import assert from 'node:assert/strict';
import test from 'node:test';
import { rebuildClubsFromRaw, toNormalizedClub } from './archway-clubs';
import { validateArchwayClubs } from './schema';
import type { RawDatasetV1, RawPageV1 } from './raw-types';

test('normalization retains the published group ID used to resolve organizer relationships', () => {
  const normalized = validateArchwayClubs([toNormalizedClub({ name: 'Sports Club', clubId: '62965', category: 'Student Organization', sourceUrl: 'https://archway.ramapo.edu/club_signup?view=all&', websiteUrl: 'https://archway.ramapo.edu/Sport/' })]);
  assert.equal(normalized[0].clubId, '62965');
});

test('offline club rebuild retains scoped successful detail contacts but ignores error and other club pages', () => {
  const seeds = [{ name: 'Sports Club', clubId: '62965', websiteUrl: 'https://archway.ramapo.edu/Sport/' }];
  const page: RawPageV1 = { url: 'https://archway.ramapo.edu/Sport/contact-us/', sourceType: 'detail', fetchedAt: '2026-09-23T00:00:00Z', statusCode: 200, title: 'Contact', links: [], externalLinks: ['https://instagram.com/sportsclub'], sections: [], lists: [], tables: [], contacts: [{ email: 'sportsclub@ramapo.edu' }], documents: [] };
  const details: RawDatasetV1 = { version: '1.0', dataset: 'clubs-detail', collectedAt: page.fetchedAt, seedUrls: [], stats: { pagesFetched: 1, pagesFailed: 1, externalLinksSeen: 1 }, pages: [page, { ...page, url: 'https://archway.ramapo.edu/Other/contact-us/', contacts: [{ email: 'other@ramapo.edu' }] }] };
  const clubs = rebuildClubsFromRaw(seeds, details);
  assert.equal(clubs[0].clubId, '62965');
  assert.equal(clubs[0].email, 'sportsclub@ramapo.edu');
  assert.equal(clubs[0].instagramUrl, 'https://instagram.com/sportsclub');
  page.statusCode = 404;
  assert.equal(rebuildClubsFromRaw(seeds, details)[0].email, undefined);
});
