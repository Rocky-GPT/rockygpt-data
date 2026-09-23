/**
 * @module api/routes/shuttle
 * The shuttle and bus timetables.
 *
 * These were previously imported straight into the web app's bus modal, which
 * meant they existed only inside a JavaScript bundle. Any other client — a
 * native app, a script, a service in another language — had no way to reach
 * them. They are campus facts, so they are served like the rest.
 */

import { getRepositoryV2 } from '../../src/data-v2/repositories';
import { ok, PUBLIC_READ_HEADERS, type ApiHandler } from '../http';
import type { ShuttleResponse } from '../contract';

export const getShuttle: ApiHandler = async () => {
  const repository = getRepositoryV2();
  const pinned = repository.withDataset(await repository.getDatasetContext());
  const [weekday, saturday, sunday, trainLoop] = await Promise.all([
    pinned.getShuttleTrips(undefined, 'weekday'), pinned.getShuttleTrips(undefined, 'saturday'),
    pinned.getShuttleTrips(undefined, 'sunday'), pinned.getShuttleTrips('Ramsey Route 17', 'weekday'),
  ]);
  const trips = (records: typeof weekday) => records.map(({ departure, arrival, stops }) => ({ departure, arrival, stops }));
  return ok({ weekday: trips(weekday), saturday: trips(saturday), sunday: trips(sunday), trainLoop: trips(trainLoop),
    // No captured official Shortline timetable supports the old bundled values.
    shortline: { toNYC: { weekday: [], saturday: [], sunday: [] }, fromNYC: { weekday: [], saturday: [], sunday: [] } },
  } satisfies ShuttleResponse, PUBLIC_READ_HEADERS);
};
