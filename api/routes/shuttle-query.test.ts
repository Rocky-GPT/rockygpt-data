import assert from 'node:assert/strict';
import test from 'node:test';
import type { ShuttleQueryResponse } from '../contract';
import type { ApiRequest } from '../http';
import { FileRepositoryV2 } from '../../src/data-v2/repositories/file-repository';
import { setRepositoryV2ForTests } from '../../src/data-v2/repositories/index';
import { postShuttleQuery } from './shuttle-query';

function request(body: Record<string, unknown>): ApiRequest {
  return {
    method: 'POST',
    url: new URL('http://local.test/v2/capabilities/shuttle/query'),
    headers: new Headers({ 'content-type': 'application/json' }),
    body,
    signal: new AbortController().signal,
  };
}

async function query(body: Record<string, unknown>) {
  setRepositoryV2ForTests(new FileRepositoryV2(process.cwd()));
  try {
    return await postShuttleQuery(request(body));
  } finally {
    setRepositoryV2ForTests(null);
  }
}

const monday = {
  serviceDate: '2026-08-24',
  serviceDay: 'weekday',
  asOf: '2026-08-24T06:00:00-04:00',
};

test('first and next select against a fixed campus-local clock', async () => {
  const first = await query({
    ...monday,
    route: 'Roadrunner Express',
    selection: 'first',
    timeScope: 'full_day',
  });
  assert.equal(first.status, 200);
  const firstBody = first.body as ShuttleQueryResponse;
  assert.equal(firstBody.records.length, 1);
  assert.equal(firstBody.records[0].departure.time, '7:00 AM');
  assert.equal(firstBody.completeness.limit, 1);

  const next = await query({
    ...monday,
    asOf: '2026-08-24T08:00:00-04:00',
    route: 'Roadrunner Express',
    selection: 'next',
    timeScope: 'remaining',
  });
  const nextBody = next.body as ShuttleQueryResponse;
  assert.equal(nextBody.records.length, 1);
  assert.equal(nextBody.records[0].departure.time, '8:25 AM');
});

test('route and destination are distinct filters', async () => {
  const mistakenRoute = await query({
    ...monday,
    route: 'Garden State Plaza',
    selection: 'first',
    timeScope: 'full_day',
  });
  assert.equal((mistakenRoute.body as ShuttleQueryResponse).outcome, 'no_match');

  const destination = await query({
    ...monday,
    destination: 'Garden State Plaza',
    selection: 'first',
    timeScope: 'full_day',
  });
  const body = destination.body as ShuttleQueryResponse;
  assert.equal(body.outcome, 'success');
  assert.equal(body.records[0].route, 'Weekday Roadrunner Express');
  assert.equal(body.records[0].matchedDestination.location, 'Garden State Plaza');
});

test('next compares asOf with the selected origin stop, not route departure', async () => {
  const result = await query({
    ...monday,
    asOf: '2026-08-24T07:36:00-04:00',
    route: 'Ramsey Route 17 Express',
    origin: 'Ramsey Route 17 Station',
    destination: 'campus',
    selection: 'next',
    timeScope: 'remaining',
  });
  const body = result.body as ShuttleQueryResponse;
  assert.equal(body.outcome, 'success');
  assert.equal(body.records[0].departure.time, '7:50 AM');
  assert.equal(body.records[0].matchedOrigin.time, '8:07 AM');
  assert.equal(body.records[0].matchedDestination.location, 'Ramapo College');
});

test('service day is derived from service date and mismatches are rejected', async () => {
  const inconsistent = await query({
    ...monday,
    serviceDate: '2026-08-23',
    serviceDay: 'weekday',
    selection: 'all',
    timeScope: 'full_day',
  });
  assert.equal(inconsistent.status, 400);

  const derived = await query({
    serviceDate: '2026-08-23',
    asOf: '2026-08-22T12:00:00-04:00',
    selection: 'first',
    timeScope: 'full_day',
  });
  assert.equal((derived.body as ShuttleQueryResponse).appliedFilters.serviceDay, 'sunday');
});

test('current uses a half-open trip interval and all declares limit truncation', async () => {
  const current = await query({
    ...monday,
    asOf: '2026-08-24T07:40:00-04:00',
    route: 'Roadrunner',
    selection: 'current',
    timeScope: 'at_time',
  });
  assert.equal((current.body as ShuttleQueryResponse).records[0].departure.time, '7:00 AM');

  const atArrival = await query({
    ...monday,
    asOf: '2026-08-24T07:55:00-04:00',
    route: 'Roadrunner',
    selection: 'current',
    timeScope: 'at_time',
  });
  assert.equal((atArrival.body as ShuttleQueryResponse).outcome, 'no_match');

  const bounded = await query({
    ...monday,
    route: 'Roadrunner',
    selection: 'all',
    timeScope: 'full_day',
    limit: 2,
  });
  const boundedBody = bounded.body as ShuttleQueryResponse;
  assert.equal(boundedBody.records.length, 2);
  assert.equal(boundedBody.completeness.state, 'partial');
  assert.equal(boundedBody.completeness.truncated, true);
  assert.ok((boundedBody.completeness.matched ?? 0) > 2);
});

test('a valid no-remaining result keeps authoritative negative-claim evidence', async () => {
  const result = await query({
    ...monday,
    asOf: '2026-08-24T23:59:00-04:00',
    route: 'Roadrunner',
    selection: 'next',
    timeScope: 'remaining',
  });
  const body = result.body as ShuttleQueryResponse;
  assert.equal(body.outcome, 'no_match');
  assert.deepEqual(body.records, []);
  assert.ok(body.evidence.length > 0);
  assert.equal(body.evidence[0].sourceId, 'transportation');
});

test('selection/timeScope pairings and unknown request fields are strict', async () => {
  assert.equal((await query({
    ...monday,
    selection: 'next',
    timeScope: 'full_day',
  })).status, 400);
  assert.equal((await query({
    ...monday,
    selection: 'first',
    timeScope: 'full_day',
    destinationRoute: 'Garden State Plaza',
  })).status, 400);
});

