/**
 * @module api/routes/shuttle
 * The shuttle and bus timetables.
 *
 * These were previously imported straight into the web app's bus modal, which
 * meant they existed only inside a JavaScript bundle. Any other client — a
 * native app, a script, a service in another language — had no way to reach
 * them. They are campus facts, so they are served like the rest.
 */

import { shuttleSchedule } from '../../src/static/shuttleSchedule';
import { ok, PUBLIC_READ_HEADERS, type ApiHandler } from '../http';
import type { ShuttleResponse } from '../contract';

export const getShuttle: ApiHandler = () => ok(shuttleSchedule as ShuttleResponse, PUBLIC_READ_HEADERS);
