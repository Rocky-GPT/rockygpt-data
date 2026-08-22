import assert from 'node:assert/strict';
import test from 'node:test';
import type { ApiRequest } from './http';
import { parseIsoDate, parseIsoInstant, validateQueryLengths } from './query';
import { getDiningHours } from './routes/dining-hours';
import { getMap } from './routes/map';
import { getMenuBrowse } from './routes/menu-browse';
import { getSearch } from './routes/search';

function request(url: string): ApiRequest {
  return {
    method: 'GET',
    url: new URL(url),
    headers: new Headers(),
    signal: new AbortController().signal,
  };
}

test('date-only queries reject impossible calendar dates', () => {
  assert.ok(parseIsoDate('2026-08-22'));
  assert.equal(parseIsoDate('2026-02-30'), null);
  assert.equal(parseIsoDate('2026-8-2'), null);
});

test('instant queries require an explicit timezone', () => {
  assert.ok(parseIsoInstant('2026-08-22T12:30:00Z'));
  assert.ok(parseIsoInstant('2026-08-22T08:30:00-04:00'));
  assert.equal(parseIsoInstant('2026-02-30T12:30:00Z'), null);
  assert.equal(parseIsoInstant('2026-08-22'), null);
  assert.equal(parseIsoInstant('2026-08-22T12:30:00'), null);
});

test('query bounds reject duplicate and oversized values', () => {
  assert.equal(validateQueryLengths(request('http://local.test/?q=short'), { q: 5 }), null);
  assert.equal(
    validateQueryLengths(request('http://local.test/?q=one&q=two'), { q: 10 })?.status,
    400
  );
  assert.equal(
    validateQueryLengths(request('http://local.test/?q=toolong'), { q: 5 })?.status,
    400
  );
});

test('routes reject invalid parameters before accessing release storage', async () => {
  assert.equal(
    (await getSearch(request('http://local.test/v1/search/campus-hours?day=Funday'))).status,
    400
  );
  assert.equal(
    (await getDiningHours(request('http://local.test/v1/dining-hours?date=2026-02-30')))
      .status,
    400
  );
  assert.equal(
    (await getMenuBrowse(request('http://local.test/v1/menu/browse?date=2026-02-30'))).status,
    400
  );
  assert.equal(
    (await getMap(request(`http://local.test/v1/map?q=${'x'.repeat(201)}`))).status,
    400
  );
});
