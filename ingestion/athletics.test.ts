import assert from 'node:assert/strict';
import test from 'node:test';
import type { AthleticsPage } from '../src/data-v2/athletics';
import { ATHLETICS_GAP_MS, inSeasonOrDue, OFF_SEASON_KEEP_DAYS, trimPage } from './athletics';
import { siteRobots } from './site-guard';

// The athletics site's rules for every robot, as its robots.txt printed them on 2026-11-03.
const robots = `User-agent: Googlebot
Disallow: /admin/

User-agent: *
Disallow: /common/
Disallow: /images/
Disallow: /documents/
Disallow: /admin/
Disallow: /services/
DisAllow: /site/
DisAllow: /hidden/
Disallow: /*.js$
Disallow: /*.axd
Disallow: /*print=true*
Allow: /
Crawl-delay: 30
`;

test('the team pages are allowed, and the gap is the crawl delay robots.txt asks for', () => {
  const site = 'https://ramapoathletics.com';
  const rules = siteRobots(`${site}/robots.txt`, 200, robots);
  assert.equal(rules.delayMs, ATHLETICS_GAP_MS);
  assert.equal(rules.allows(`${site}/sports/mens-soccer/schedule`), true);
  assert.equal(rules.allows(`${site}/sports/mens-soccer/coaches`), true);
  assert.equal(rules.allows(`${site}/services/schedule_txt.ashx`), false);
  assert.equal(rules.allows(`${site}/sports/mens-soccer/schedule?print=true`), false);
  assert.equal(rules.allows(`${site}/main.js`), false);
  assert.equal(siteRobots(`${site}/robots.txt`, 200, 'User-agent: *\nDisallow: /sports/\n').allows(`${site}/sports/baseball/schedule`), false);
});

test('a saved page keeps its title, text and JSON-LD, but not scripts, styles or images', () => {
  const html = trimPage(`<html><head><title>2026 Baseball Schedule</title><style>.a{}</style><script>track()</script>
    <script type="application/ld+json">{"@type":"SportsEvent"}</script></head><body><img src="x.png"><svg></svg><!-- c --><p>Game  day</p></body></html>`);
  assert.match(html, /<title>2026 Baseball Schedule<\/title>/);
  assert.match(html, /SportsEvent/);
  assert.match(html, /<p>Game day<\/p>/);
  assert.doesNotMatch(html, /track\(\)|<style|<img|<svg|<!--/);
});

// One Sidearm schedule game, as the live list prints it (enough for parseSchedule's date).
const gameItem = (date: string) => `<li class="sidearm-schedule-game sidearm-schedule-home-game">
  <div class="sidearm-schedule-game-opponent-date"><span>${date}</span> <span>1:00 PM</span></div>
  <div class="sidearm-schedule-game-opponent-text"><div class="sidearm-schedule-game-opponent-name"><a href="#">Kean University</a></div></div>
  <div class="sidearm-schedule-game-location"><span class="sidearm-schedule-game-conference-vs"><span class="sidearm-schedule-game-at-vs">vs</span></span>
    <span>Mahwah, NJ</span> <span>Bradley Center</span></div></li>`;
const schedulePage = (season: string, dates: string[], fetchedAt: string, status = 200): AthleticsPage => ({
  team: 'baseball', url: 'https://ramapoathletics.com/sports/baseball/schedule', status, fetchedAt,
  html: `<html><head><title>${season} Baseball Schedule - Ramapo College of New Jersey Athletics</title></head><body>
    <ul class="sidearm-schedule-games-container">${dates.map(gameItem).join('')}</ul></body></html>`,
});

test('an out-of-season team keeps its last copy for a week, an in-season one is read every night', () => {
  const now = new Date('2026-11-18T08:00:00Z');
  const spring = schedulePage('2026', ['Mar 3 (Tue)', 'May 2 (Sat)'], '2026-11-15T08:00:00Z');
  assert.equal(inSeasonOrDue(spring, now), false);
  assert.equal(inSeasonOrDue({ ...spring, fetchedAt: '2026-11-10T08:00:00Z' }, now), true, `${OFF_SEASON_KEEP_DAYS} days old`);
  assert.equal(inSeasonOrDue(schedulePage('2026-2027', ['Nov 16 (Mon)'], '2026-11-17T08:00:00Z'), now), true, 'a result two days ago');
  assert.equal(inSeasonOrDue(schedulePage('2026-2027', ['Dec 1 (Tue)'], '2026-11-17T08:00:00Z'), now), true, 'a game within two weeks');
  assert.equal(inSeasonOrDue(schedulePage('2026-2027', ['Jan 20 (Wed)'], '2026-11-17T08:00:00Z'), now), false, 'the next game is two months off');
});

test('a team with no good last copy, or one whose games could not be read, is read again', () => {
  const now = new Date('2026-11-18T08:00:00Z');
  assert.equal(inSeasonOrDue(undefined, now), true);
  assert.equal(inSeasonOrDue(schedulePage('2026', ['Mar 3 (Tue)'], '2026-11-17T08:00:00Z', 404), now), true);
  assert.equal(inSeasonOrDue(schedulePage('2026', [], '2026-11-17T08:00:00Z'), now), true);
  assert.equal(inSeasonOrDue({ ...schedulePage('2026', ['Mar 3 (Tue)'], '2026-11-17T08:00:00Z'), html: undefined }, now), true);
});
