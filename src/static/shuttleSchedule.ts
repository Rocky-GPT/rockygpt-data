/**
 * @module static/shuttleSchedule
 * Static transportation schedules for Ramapo's Roadrunner Express shuttle,
 * the Shortline bus, and the campus train loop.
 *
 * The timetables themselves live in `src/reference/shuttle-schedule.json`.
 * They are facts rather than code, and keeping them as data means a service
 * written in another language can read the same file instead of needing a
 * TypeScript parser. This module supplies the types and nothing else.
 *
 * Consumed by the repository layer for deterministic "next shuttle" answers,
 * and by the BusModal UI for schedule browsing.
 */

import scheduleData from '../reference/shuttle-schedule.json';

/** A scheduled stop within one Ramapo shuttle route. */
export interface ShuttleStop {
  location: string;
  time: string;
}

/** A complete shuttle trip with a campus departure, intermediate stops, and final arrival. */
export interface ShuttleRoute {
  departure: string;
  stops: ShuttleStop[];
  arrival: string;
  /** The NJ Transit trains a timetable row lists beside the trip, as published. */
  trains?: ShuttleTrains;
}

/** A timetable row's "Train Arrives from NYC" and "Train Leaves for NYC" cells. */
export interface ShuttleTrains {
  arrives_from_nyc: string[];
  leaves_for_nyc: string[];
  /** The row says "See express": its trains are listed on the mid-day express timetable. */
  see_express?: true;
}

/** Shortline departure times, as plain clock strings, per service day. */
export interface ShortlineTimetable {
  weekday: string[];
  saturday: string[];
  sunday: string[];
}

/** Every schedule this module publishes. */
export interface ShuttleSchedule {
  trainLoop: ShuttleRoute[];
  shortline: {
    toNYC: ShortlineTimetable;
    fromNYC: ShortlineTimetable;
  };
  weekday: ShuttleRoute[];
  saturday: ShuttleRoute[];
  sunday: ShuttleRoute[];
}

export const shuttleSchedule: ShuttleSchedule = scheduleData;
