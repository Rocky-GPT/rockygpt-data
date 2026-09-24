import assert from 'node:assert/strict';
import test from 'node:test';

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
