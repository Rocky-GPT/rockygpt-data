import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const specification = fs.readFileSync('api/openapi.yaml', 'utf8');

test('OpenAPI documents every public production route', () => {
  for (const path of [
    '/health',
    '/readiness',
    '/v1/menu',
    '/v1/menu/browse',
    '/v1/dining-hours',
    '/v1/directory',
    '/v1/search/campus-hours',
    '/v1/search/dining-hours',
    '/v1/search/menu',
    '/v1/search/contacts',
    '/v1/search/clubs',
    '/v1/search/events',
    '/v1/search/programs',
    '/v1/search/academic-dates',
    '/v1/search/shuttles',
    '/v1/safety-resources',
    '/v1/map',
    '/v1/shuttle',
    '/v1/data/{artifact}',
    '/v2/capabilities/shuttle/query',
    '/v2/retrieve',
  ]) {
    assert.match(specification, new RegExp(`^  ${path.replace(/[{}]/g, '\\$&')}:$`, 'm'), path);
  }
});

test('V2 contract exposes typed outcomes, evidence, completeness, and untrusted retrieval', () => {
  assert.match(specification, /^    V2Outcome:$/m);
  assert.match(specification, /enum: \[success, empty, no_match, needs_clarification, unsupported, unavailable, error\]/);
  assert.match(specification, /^    V2Completeness:$/m);
  assert.match(specification, /^    V2Evidence:$/m);
  assert.match(specification, /contentTrust: \{ type: string, enum: \[untrusted\] \}/);
  assert.match(specification, /selection: \{ type: string, enum: \[first, next, all, current\] \}/);
  assert.match(specification, /timeScope: \{ type: string, enum: \[full_day, remaining, at_time\] \}/);
  assert.match(specification, /serviceDay: \[serviceDate\]/);
  assert.match(specification, /enum: \[limit, top_k, entity_no_match, no_remaining, not_current, dataset_empty, dependency_unavailable\]/);
  assert.match(specification, /serviceDatesConsidered:/);
  const shuttlePath = specification.slice(
    specification.indexOf('  /v2/capabilities/shuttle/query:'),
    specification.indexOf('  /v2/retrieve:')
  );
  assert.match(shuttlePath, /'503':[\s\S]*ShuttleQueryResponse/);
  assert.match(shuttlePath, /'503':[\s\S]*X-RockyGPT-Release/);
  const retrievePath = specification.slice(
    specification.indexOf('  /v2/retrieve:'),
    specification.indexOf('\ncomponents:')
  );
  assert.match(retrievePath, /'503':[\s\S]*RetrieveResponse/);
  assert.match(retrievePath, /'503':[\s\S]*X-RockyGPT-Release/);
});

test('map contract exposes the actual type discriminator', () => {
  const mapSchema = specification.slice(
    specification.indexOf('    MapLocation:'),
    specification.indexOf('    MapResponse:')
  );
  assert.match(mapSchema, /required: \[key, name, type,/);
  assert.doesNotMatch(mapSchema, /\bkind:/);
});
