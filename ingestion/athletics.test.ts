import assert from 'node:assert/strict';
import test from 'node:test';
import { ATHLETICS_GAP_MS, robotsAllows, robotsRules, trimPage } from './athletics';

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
  const rules = robotsRules(robots);
  assert.equal(rules.delaySeconds * 1000, ATHLETICS_GAP_MS);
  assert.equal(robotsAllows(rules, '/sports/mens-soccer/schedule'), true);
  assert.equal(robotsAllows(rules, '/sports/mens-soccer/coaches'), true);
  assert.equal(robotsAllows(rules, '/services/schedule_txt.ashx'), false);
  assert.equal(robotsAllows(rules, '/sports/mens-soccer/schedule?print=true'), false);
  assert.equal(robotsAllows(rules, '/main.js'), false);
  assert.equal(robotsAllows(robotsRules('User-agent: *\nDisallow: /sports/\n'), '/sports/baseball/schedule'), false);
});

test('a saved page keeps its title, text and JSON-LD, but not scripts, styles or images', () => {
  const html = trimPage(`<html><head><title>2026 Baseball Schedule</title><style>.a{}</style><script>track()</script>
    <script type="application/ld+json">{"@type":"SportsEvent"}</script></head><body><img src="x.png"><svg></svg><!-- c --><p>Game  day</p></body></html>`);
  assert.match(html, /<title>2026 Baseball Schedule<\/title>/);
  assert.match(html, /SportsEvent/);
  assert.match(html, /<p>Game day<\/p>/);
  assert.doesNotMatch(html, /track\(\)|<style|<img|<svg|<!--/);
});
