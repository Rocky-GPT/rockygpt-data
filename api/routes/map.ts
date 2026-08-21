/**
 * @module api/routes/map
 * The campus map, and the query resolution the assistant and the UI both use.
 *
 * Matching a phrase like "the Bradley Center" to a map key is real logic, not
 * just data, so it is answered here rather than reimplemented by every client.
 * A native client asks the same question over HTTP that the web app does.
 */

import { MAP_LOCATIONS, resolveMapLocation } from '../../src/map-locations';
import { ok, PUBLIC_READ_HEADERS, type ApiHandler } from '../http';
import type { MapResponse, WireMapLocation } from '../contract';

export const getMap: ApiHandler = (request) => {
  const query = request.url.searchParams.get('q');
  const payload: MapResponse = {
    locations: MAP_LOCATIONS as unknown as WireMapLocation[],
  };
  // Only answered when asked, so a client fetching the whole map is not also
  // paying for a resolution it did not request.
  if (query) {
    payload.resolved = (resolveMapLocation(query) as unknown as WireMapLocation) ?? null;
  }
  return ok(payload, PUBLIC_READ_HEADERS);
};
