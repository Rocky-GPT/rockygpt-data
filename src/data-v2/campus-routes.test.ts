import assert from 'node:assert/strict';
import test from 'node:test';
import { validateCampusIdentities } from './campus-identities';
import { compileRouteIdentities, routeIdentityId } from './campus-routes';
import { compileCampusIdentities, type IdentitySnapshot } from './compile-campus-identities';

const routes = [
  { id: 'r1', name: 'Weekday Roadrunner Express', service_day: 'weekday' },
  { id: 'r2', name: 'Saturday Roadrunner Express', service_day: 'saturday' },
];
const trips = [
  { id: 't1', route_id: 'r1', source_key: 'transportation', source_record_key: 'Weekday Roadrunner Express:1:8:00 AM' },
  { id: 't0', route_id: 'r1', source_key: 'transportation', source_record_key: 'Weekday Roadrunner Express:0:7:00 AM' },
  { id: 't2', route_id: 'r2', source_key: 'transportation', source_record_key: 'Saturday Roadrunner Express:0:9:00 AM' },
];

test('each published timetable is one route identity linked to exactly its own trips', () => {
  const { routes: found, unresolved } = compileRouteIdentities(routes, trips);
  assert.equal(unresolved.length, 0);
  assert.deepEqual(found.map(route => route.name), ['Weekday Roadrunner Express', 'Saturday Roadrunner Express']);
  assert.deepEqual(found[0].links, [{ collection: 'shuttle_trips', source_key: 'transportation', source_record_keys: [
    'Weekday Roadrunner Express:0:7:00 AM', 'Weekday Roadrunner Express:1:8:00 AM'] }]);
  assert.deepEqual(found[1].links[0].source_record_keys, ['Saturday Roadrunner Express:0:9:00 AM']);
  assert.ok(found.every(route => route.kind === 'route' && route.aliases.length === 0));
  // A route keeps its ID from release to release.
  assert.equal(found[0].id, routeIdentityId('Weekday Roadrunner Express'));
  validateCampusIdentities({ schema_version: 1, entities: found });
});

test('a timetable with no trips, or trips from two sources, is reported and not made an identity', () => {
  const result = compileRouteIdentities(
    [...routes, { id: 'r3', name: 'Empty Route' }],
    [...trips, { id: 't9', route_id: 'r2', source_key: 'other', source_record_key: 'x' }]);
  assert.deepEqual(result.routes.map(route => route.name), ['Weekday Roadrunner Express']);
  assert.deepEqual(result.unresolved.map(issue => issue.entity).sort(), ['Empty Route', 'Saturday Roadrunner Express']);
  assert.ok(result.unresolved.every(issue => issue.kind === 'no_records' && issue.collection === 'shuttle_trips'));
});

test('a release without shuttle rows has no routes, and one with them gets the routes in its registry', () => {
  const empty: IdentitySnapshot = { campus_contacts: [], campus_hours: [], dining_hours: [], menu_items: [], programs: [], artifacts: {} };
  const none = compileCampusIdentities({ schema_version: 1, entities: [] }, empty);
  assert.equal(none.report.identities_by_kind.route, undefined);
  const withRoutes = compileCampusIdentities({ schema_version: 1, entities: [] }, { ...empty, shuttle_routes: routes, shuttle_trips: trips });
  assert.equal(withRoutes.report.identities_by_kind.route, 2);
  assert.equal(withRoutes.report.linked_records.shuttle_trips, 3);
  assert.deepEqual(withRoutes.registry.entities.filter(entity => entity.kind === 'route').map(entity => entity.name),
    ['Weekday Roadrunner Express', 'Saturday Roadrunner Express']);
});
