import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { fetchWithPolicy } from './http-client';
import {
  ALLOW_SITE_FETCH_ENV,
  assertSiteFetchAllowed,
  isRamapoHost,
  noteSiteDownloads,
  RAMAPO_CONCURRENCY,
  RAMAPO_REQUEST_GAP_MS,
  SiteFetchBlockedError,
  siteFetchAllowed,
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
  assert.deepEqual(sent, ['https://example.edu/finaid/', 'https://guard-allowed.ramapo.edu/finaid/']);
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
