import assert from 'node:assert/strict';
import test from 'node:test';
import { markdown, summarize } from '../scripts/review/show-blocked-pages';

test("the blocked list keeps each site's last rules and each refused page once, with the reviewed list", () => {
  const summary = summarize([
    JSON.stringify({ type: 'site', site: 'https://www.ramapo.edu', status: 200, refuses: ['/catalog_05_06/'], crawlDelaySeconds: 0 }),
    JSON.stringify({ type: 'site', site: 'https://ramapoathletics.com', status: 200, refuses: ['/services/'], crawlDelaySeconds: 30 }),
    JSON.stringify({ type: 'refused', url: 'https://www.ramapo.edu/catalog_05_06/a.html', reason: 'robots.txt disallows it' }),
    JSON.stringify({ type: 'refused', url: 'https://www.ramapo.edu/catalog_05_06/a.html', reason: 'robots.txt disallows it' }),
    'not json', '',
  ], new Date('2026-11-18T20:00:00Z'));
  assert.deepEqual(summary.sites.map(site => site.site), ['https://ramapoathletics.com', 'https://www.ramapo.edu']);
  assert.equal(summary.refused.length, 1);
  assert.ok(summary.reviewed.some(source => source.site === 'myssb.ramapo.edu'));
  const text = markdown(summary);
  assert.match(text, /\*\*https:\/\/ramapoathletics\.com\*\* \(robots\.txt answered 200, 30 s between pages\): blocks `\/services\/`/);
  assert.match(text, /- https:\/\/www\.ramapo\.edu\/catalog_05_06\/a\.html: robots\.txt disallows it/);
  assert.match(text, /\| myssb\.ramapo\.edu \| Banner Self-Service class search/);
});

test('a run that read no Ramapo site still lists the reviewed blocks', () => {
  const text = markdown(summarize([]));
  assert.match(text, /No Ramapo site was read this run\./);
  assert.match(text, /## Pages this run wanted but was refused\n\nNone\./);
});
