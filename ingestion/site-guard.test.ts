import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { fetchWithPolicy } from './http-client';
import {
  ALLOW_SITE_FETCH_ENV,
  assertSiteFetchAllowed,
  BLOCKED_PAGES_NOTE_ENV,
  everyRobotDisallows,
  forgetSiteRobots,
  isRamapoHost,
  noteSiteDownloads,
  SITE_DOWNLOADS_NOTE_ENV,
  startSiteDownloadsNote,
  RAMAPO_CONCURRENCY,
  RAMAPO_REQUEST_GAP_MS,
  RobotsDisallowedError,
  SiteFetchBlockedError,
  siteFetchAllowed,
  siteRobots,
} from './site-guard';

/** Runs with the given environment values, putting the old ones back after. */
async function withEnv(values: Record<string, string | undefined>, run: () => Promise<void>): Promise<void> {
  const saved = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    await run();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("Ramapo's hosts are ramapo.edu and every name under it, and nothing that only ends the same way", () => {
  for (const host of ['ramapo.edu', 'www.ramapo.edu', 'archway.ramapo.edu', 'catalog.ramapo.edu', 'WWW.Ramapo.EDU.']) {
    assert.equal(isRamapoHost(host), true, host);
  }
  assert.equal(isRamapoHost('ramapoathletics.com'), true);
  assert.equal(isRamapoHost('notramapoathletics.com'), false);
  for (const host of ['notramapo.edu', 'ramapo.edu.example.com', 'ramapo.sodexomyway.com', 'example.edu']) {
    assert.equal(isRamapoHost(host), false, host);
  }
});

test('only the daily data run, or a run told to, may download from Ramapo', () => {
  assert.equal(siteFetchAllowed({ GITHUB_ACTIONS: 'true' }), true);
  assert.equal(siteFetchAllowed({ [ALLOW_SITE_FETCH_ENV]: '1' }), true);
  assert.equal(siteFetchAllowed({}), false);
  assert.equal(siteFetchAllowed({ GITHUB_ACTIONS: 'false', [ALLOW_SITE_FETCH_ENV]: 'yes' }), false);
  // The workflow's dev build reuses production's pages and never downloads, even in Actions.
  assert.equal(siteFetchAllowed({ GITHUB_ACTIONS: 'true', ROCKYGPT_BUILD_TARGET: 'dev' }), false);
  assert.equal(siteFetchAllowed({ ROCKYGPT_BUILD_TARGET: 'dev', [ALLOW_SITE_FETCH_ENV]: '1' }), false);
  assert.equal(siteFetchAllowed({ GITHUB_ACTIONS: 'true', ROCKYGPT_BUILD_TARGET: 'production' }), true);
  assert.throws(() => assertSiteFetchAllowed('https://www.ramapo.edu/registrar/', {}), SiteFetchBlockedError);
  assert.throws(() => assertSiteFetchAllowed('https://www.ramapo.edu/registrar/', {}), /data:bootstrap -- --require-raw/);
  assertSiteFetchAllowed('https://example.edu/registrar/', {});
  assertSiteFetchAllowed('https://www.ramapo.edu/registrar/', { GITHUB_ACTIONS: 'true' });
});

test('a laptop request to Ramapo stops before anything is sent, and other hosts are untouched', async () => {
  const original = globalThis.fetch;
  const sent: string[] = [];
  globalThis.fetch = async input => {
    sent.push(String(input));
    return new Response('ok');
  };
  try {
    await withEnv({ GITHUB_ACTIONS: undefined, [ALLOW_SITE_FETCH_ENV]: undefined }, async () => {
      await assert.rejects(() => fetchWithPolicy('https://www.ramapo.edu/finaid/', {}, { attempts: 3 }), SiteFetchBlockedError);
      await fetchWithPolicy('https://example.edu/finaid/', {}, { attempts: 1 });
    });
    await withEnv({ GITHUB_ACTIONS: undefined, [ALLOW_SITE_FETCH_ENV]: '1' }, async () => {
      await fetchWithPolicy('https://guard-allowed.ramapo.edu/finaid/', {}, { attempts: 1 });
    });
  } finally {
    globalThis.fetch = original;
  }
  assert.deepEqual(sent, ['https://example.edu/finaid/', 'https://guard-allowed.ramapo.edu/robots.txt',
    'https://guard-allowed.ramapo.edu/finaid/']);
});

test('Ramapo gets at most two open requests, each started half a second after the last, whatever a collector asks', async () => {
  const original = globalThis.fetch;
  let open = 0;
  let mostOpen = 0;
  const starts: number[] = [];
  globalThis.fetch = async () => {
    starts.push(Date.now());
    open += 1;
    mostOpen = Math.max(mostOpen, open);
    await new Promise(resolve => setTimeout(resolve, 50));
    open -= 1;
    return new Response('ok');
  };
  try {
    await withEnv({ [ALLOW_SITE_FETCH_ENV]: '1' }, async () => {
      await Promise.all([1, 2, 3, 4].map(page =>
        fetchWithPolicy(`https://pace-test.ramapo.edu/${page}`, {}, { attempts: 1, perHostConcurrency: 8 })));
    });
  } finally {
    globalThis.fetch = original;
  }
  assert.ok(mostOpen <= RAMAPO_CONCURRENCY);
  starts.sort((a, b) => a - b);
  for (let index = 1; index < starts.length; index += 1) {
    assert.ok(starts[index] - starts[index - 1] >= RAMAPO_REQUEST_GAP_MS - 20, `gap ${starts[index] - starts[index - 1]}ms`);
  }
});

test('a download note line is printed and kept for the end of the run', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rocky-site-note-'));
  const note = path.join(dir, 'review', 'site-downloads.txt');
  try {
    noteSiteDownloads('office-pages: 2300 of 2320 pages unchanged', note);
    noteSiteDownloads('Event pages: 180 of 240 reused', note);
    assert.equal(fs.readFileSync(note, 'utf8'), 'office-pages: 2300 of 2320 pages unchanged\nEvent pages: 180 of 240 reused\n');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('outside a refresh the line is only printed; a refresh starts the note for its collectors', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rocky-site-note-'));
  const note = path.join(dir, 'review', 'site-downloads.txt');
  const before = process.env[SITE_DOWNLOADS_NOTE_ENV];
  const blockedBefore = process.env[BLOCKED_PAGES_NOTE_ENV];
  try {
    delete process.env[SITE_DOWNLOADS_NOTE_ENV];
    noteSiteDownloads('a test run');
    assert.equal(fs.existsSync(note), false);
    fs.mkdirSync(path.dirname(note), { recursive: true });
    fs.writeFileSync(note, 'last night\n');
    startSiteDownloadsNote(note);
    assert.equal(process.env[SITE_DOWNLOADS_NOTE_ENV], note);
    noteSiteDownloads('Collectors run tonight: fetch:menu.');
    assert.equal(fs.readFileSync(note, 'utf8'), 'Collectors run tonight: fetch:menu.\n');
    assert.equal(process.env[BLOCKED_PAGES_NOTE_ENV], path.join(dir, 'review', 'blocked-pages.jsonl'));
  } finally {
    if (before === undefined) delete process.env[SITE_DOWNLOADS_NOTE_ENV]; else process.env[SITE_DOWNLOADS_NOTE_ENV] = before;
    if (blockedBefore === undefined) delete process.env[BLOCKED_PAGES_NOTE_ENV];
    else process.env[BLOCKED_PAGES_NOTE_ENV] = blockedBefore;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ramapo.edu's rules as its robots.txt printed them on 2026-11-18, and Archway's on 2026-11-05.
const RAMAPO_ROBOTS = 'User-Agent: *\nDisallow: /catalog_05_06/\n';
const ARCHWAY_ROBOTS = [
  'User-agent: *', 'Disallow: /upload/', 'Disallow: /student_docs/', 'Disallow: /downloads/',
  'Disallow: /mobile_ws/v17/', 'Disallow: /mobile_ws/v18/', 'Disallow: *ajax_widget_new', '',
].join('\n');

test("robots.txt rules: ramapo.edu's old catalog and Archway's phone-app feeds are refused, the rest is allowed", () => {
  const ramapo = siteRobots('https://www.ramapo.edu/robots.txt', 200, RAMAPO_ROBOTS);
  assert.equal(ramapo.allows('https://www.ramapo.edu/registrar/'), true);
  assert.equal(ramapo.allows('https://www.ramapo.edu/catalog_05_06/index.html'), false);
  assert.equal(ramapo.delayMs, 0);
  const archway = siteRobots('https://archway.ramapo.edu/robots.txt', 200, ARCHWAY_ROBOTS);
  assert.equal(archway.allows('https://archway.ramapo.edu/ics_helper'), true);
  assert.equal(archway.allows('https://archway.ramapo.edu/mobile_ws/v17/mobile_events_list'), false);
  assert.equal(archway.allows('https://archway.ramapo.edu/x/ajax_widget_new?id=1'), false);
});

test('a missing robots.txt allows everything; one that cannot be read refuses everything this run', () => {
  assert.equal(siteRobots('https://a.ramapo.edu/robots.txt', 404).allows('https://a.ramapo.edu/x'), true);
  for (const status of [500, 503, 429, undefined]) {
    const robots = siteRobots('https://a.ramapo.edu/robots.txt', status);
    assert.equal(robots.allows('https://a.ramapo.edu/x'), false);
    assert.match(robots.unreadable ?? '', /could not be read/);
  }
});

test('every Ramapo request is checked against robots.txt, read once a run, and a refused page is never sent', async () => {
  const original = globalThis.fetch;
  const sent: string[] = [];
  globalThis.fetch = async input => {
    sent.push(String(input));
    if (String(input).endsWith('/robots.txt')) return new Response('User-agent: *\nDisallow: /private/\n');
    return new Response('ok');
  };
  forgetSiteRobots();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rocky-blocked-'));
  const blocked = path.join(dir, 'blocked-pages.jsonl');
  try {
    await withEnv({ [ALLOW_SITE_FETCH_ENV]: '1', [BLOCKED_PAGES_NOTE_ENV]: blocked }, async () => {
      await fetchWithPolicy('https://robots-test.ramapo.edu/open', {}, { attempts: 1 });
      await assert.rejects(() => fetchWithPolicy('https://robots-test.ramapo.edu/private/page', {}, { attempts: 3 }),
        RobotsDisallowedError);
      await fetchWithPolicy('https://robots-test.ramapo.edu/open-again', {}, { attempts: 1 });
      await fetchWithPolicy('https://example.edu/private/page', {}, { attempts: 1 });
    });
  } finally {
    globalThis.fetch = original;
    forgetSiteRobots();
  }
  assert.deepEqual(sent, ['https://robots-test.ramapo.edu/robots.txt', 'https://robots-test.ramapo.edu/open',
    'https://robots-test.ramapo.edu/open-again', 'https://example.edu/private/page']);
  // The run's blocked list: the site's rules once, and the page it refused.
  const notes = fs.readFileSync(blocked, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  fs.rmSync(dir, { recursive: true, force: true });
  assert.deepEqual(notes, [
    { type: 'site', site: 'https://robots-test.ramapo.edu', status: 200, refuses: ['/private/'], crawlDelaySeconds: 0 },
    { type: 'refused', url: 'https://robots-test.ramapo.edu/private/page', reason: 'robots.txt disallows it' },
  ]);
});

test('the blocked list shows the lines robots.txt gives every robot, not another robot\'s', () => {
  const athletics = [
    'User-agent: Googlebot', 'Disallow: /admin/', '', 'User-agent: *', 'Disallow: /common/',
    'DisAllow: /site/', 'Disallow: /*print=true* # print views', 'Allow: /', 'Crawl-delay: 30', '',
  ].join('\n');
  assert.deepEqual(everyRobotDisallows(athletics), ['/common/', '/site/', '/*print=true*']);
  assert.deepEqual(everyRobotDisallows(RAMAPO_ROBOTS), ['/catalog_05_06/']);
  assert.deepEqual(everyRobotDisallows('User-agent: *\nAllow: /\n'), []);
});
