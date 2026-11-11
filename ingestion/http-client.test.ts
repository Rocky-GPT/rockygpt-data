import assert from 'node:assert/strict';
import test from 'node:test';

import { MENU_ATTEMPTS } from './birch-menu';
import { DEFAULT_USER_AGENT, fetchWithPolicy } from './http-client';

test('a request without its own user agent sends a browser one that does not name the project', async () => {
  const original = globalThis.fetch;
  const sent: Array<string | null> = [];
  globalThis.fetch = async (_input, init) => {
    sent.push(new Headers(init?.headers).get('user-agent'));
    return new Response('ok');
  };
  try {
    await fetchWithPolicy('https://example.edu/a', {}, { attempts: 1 });
    await fetchWithPolicy('https://example.edu/b', { headers: { 'User-Agent': 'Custom/1.0' } }, { attempts: 1 });
  } finally {
    globalThis.fetch = original;
  }
  assert.equal(sent[0], DEFAULT_USER_AGENT);
  assert.match(DEFAULT_USER_AGENT, /^Mozilla\/5\.0 /);
  assert.doesNotMatch(DEFAULT_USER_AGENT, /rocky/i);
  assert.equal(sent[1], 'Custom/1.0');
});

test('a request that hangs is asked again, as many times as its caller allows', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  let hangs = 0;
  // Sodexo's menu service on 2026-11-10: a request hangs until it is cut off, the next answers at once.
  globalThis.fetch = async (_input, init) => {
    calls++;
    if (calls <= hangs) {
      await new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal?.reason)));
    }
    return new Response('{"menu":[]}', { headers: { 'content-type': 'application/json' } });
  };
  const ask = (attempts?: number) => fetchWithPolicy('https://menus.example.test/day', {}, { attempts, timeoutMs: 15, backoffBaseMs: 1 });
  try {
    // Seven hung tries, then an answer: the menu collector's eight tries get the day's menu.
    hangs = MENU_ATTEMPTS - 1;
    assert.deepEqual((await ask(MENU_ATTEMPTS)).json(), { menu: [] });
    assert.equal(calls, MENU_ATTEMPTS);
    // The usual three tries give up on the same service.
    calls = 0;
    await assert.rejects(ask(), /HTTP collection failed for GET https:\/\/menus\.example\.test\/day: Request timed out after 15ms\./);
    assert.equal(calls, 3);
  } finally {
    globalThis.fetch = original;
  }
});
