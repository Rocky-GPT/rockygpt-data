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
  ]) {
    assert.match(specification, new RegExp(`^  ${path.replace(/[{}]/g, '\\$&')}:$`, 'm'), path);
  }
});

test('map contract exposes the actual type discriminator', () => {
  const mapSchema = specification.slice(
    specification.indexOf('    MapLocation:'),
    specification.indexOf('    MapResponse:')
  );
  assert.match(mapSchema, /required: \[key, name, type,/);
  assert.doesNotMatch(mapSchema, /\bkind:/);
});
