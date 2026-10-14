import type { CampusIdentity } from './campus-identities';
import type { IdentityCoverageIssue } from './compile-campus-identities';
import { uuid5 } from './course-identities';

type Row = Record<string, unknown>;

/** The namespace of shuttle route identities. Fixed: a route keeps its ID release to release. */
const ROUTE_NAMESPACE = Buffer.from('3b4f8f6a8c2d4f0e9a53b07c6e1d2a94', 'hex');

export const routeIdentityId = (name: string): string => uuid5(ROUTE_NAMESPACE, `transportation:route:${name}`);

const text = (value: unknown): string => typeof value === 'string' ? value.trim() : '';

/**
 * One identity per published shuttle timetable, linked to the trips of that timetable by their
 * exact record keys. A route is derived from the rows the publisher wrote, never named by hand:
 * the four timetables are the four routes, and a trip belongs to exactly the route that lists it.
 *
 * Stops are not identities. A stop is a place a trip's `stops` list names, so a reader that
 * wants "the train station" matches the published stop names, not a registry entry.
 */
export function compileRouteIdentities(routes: Row[], trips: Row[]): { routes: CampusIdentity[]; unresolved: IdentityCoverageIssue[] } {
  const unresolved: IdentityCoverageIssue[] = [];
  const identities: CampusIdentity[] = [];
  const tripsByRoute = new Map<string, Row[]>();
  for (const trip of trips) {
    const routeId = text(trip.route_id);
    tripsByRoute.set(routeId, [...(tripsByRoute.get(routeId) ?? []), trip]);
  }
  const named = new Set<string>();
  for (const route of routes) {
    const name = text(route.name);
    if (!name) continue;
    if (named.has(name)) {
      unresolved.push({ entity: name, collection: 'shuttle_trips', reason: 'Two published timetables share this route name; only the first is an identity.', kind: 'missing_connection' });
      continue;
    }
    named.add(name);
    const own = tripsByRoute.get(text(route.id)) ?? [];
    const keys = [...new Set(own.map(trip => text(trip.source_record_key)).filter(Boolean))].sort();
    const sources = new Set(own.map(trip => text(trip.source_key)).filter(Boolean));
    if (!keys.length || sources.size !== 1) {
      unresolved.push({ entity: name, collection: 'shuttle_trips', reason: keys.length ? 'The timetable\'s trips come from more than one source.' : 'The timetable has no trips in this release.', kind: 'no_records' });
      continue;
    }
    identities.push({ id: routeIdentityId(name), kind: 'route', name, aliases: [], links: [
      { collection: 'shuttle_trips', source_key: [...sources][0], source_record_keys: keys },
    ] });
  }
  return { routes: identities, unresolved };
}
