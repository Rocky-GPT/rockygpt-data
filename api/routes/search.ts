/** Structured campus searches used by the brain and any future client. */

import { getRepositoryV2 } from '../../src/data-v2/repositories/index';
import type { AcademicDateRecord, ShuttleServiceDay } from '../../src/data-v2/schemas';
import { V2_SOURCES } from '../../src/data-v2/sources';
import { scheduleStatusAt } from '../../src/data-v2/schedule-status';
import { fail, ok, PUBLIC_READ_HEADERS, type ApiHandler } from '../http';
import { parseIsoDate, parseIsoInstant, validateQueryLengths } from '../query';
import {
  CALENDAR_FAMILIES,
  CALENDAR_KINDS,
  type CalendarFamily,
  type CalendarKind,
} from '../../src/data-v2/calendar-concepts';

const CAMPUS_TIME_ZONE = 'America/New_York';
const SERVICE_DAYS = new Set<ShuttleServiceDay>(['weekday', 'saturday', 'sunday']);
const WEEKDAYS = new Map(
  ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'].map((day) => [
    day.toLowerCase(),
    day,
  ])
);

function text(request: Parameters<ApiHandler>[0], key: string): string {
  return request.url.searchParams.get(key)?.trim() ?? '';
}

function instant(request: Parameters<ApiHandler>[0]): Date | null {
  const raw = text(request, 'at');
  if (!raw) return new Date();
  return parseIsoInstant(raw);
}

function campusWeekday(at: Date): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: CAMPUS_TIME_ZONE,
    weekday: 'long',
  }).format(at);
}

function campusServiceDay(at: Date): ShuttleServiceDay {
  const weekday = campusWeekday(at);
  if (weekday === 'Saturday') return 'saturday';
  if (weekday === 'Sunday') return 'sunday';
  return 'weekday';
}

function campusMinutesOfDay(at: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: CAMPUS_TIME_ZONE,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(at);
  const hour = Number(parts.find((part) => part.type === 'hour')?.value ?? '0');
  const minute = Number(parts.find((part) => part.type === 'minute')?.value ?? '0');
  return (hour % 24) * 60 + minute;
}

/** "7:00 AM" -> minutes past midnight. Null when the text is not a clock time. */
function departureMinutes(departure: string): number | null {
  const match = /(\d{1,2})(?::(\d{2}))?\s*([ap])\.?\s*m\.?/i.exec(departure.trim());
  if (!match) return null;
  const hour = Number(match[1]) % 12;
  const minute = Number(match[2] ?? 0);
  return (match[3].toLowerCase() === 'p' ? hour + 12 : hour) * 60 + minute;
}

/**
 * The trips a caller asking "at" this moment can still catch, in departure
 * order.
 *
 * `at` was previously accepted, length-checked, and then dropped before it
 * reached retrieval, so this endpoint answered every question about a service
 * day with that day's entire timetable — including trips that had already left.
 * Callers had no way to ask for the remainder of the day.
 *
 * Filtering applies only when the requested timetable is the one `at` actually
 * falls on. "After now" means nothing for a question about Saturday asked on a
 * Tuesday: that asks for the whole Saturday timetable, and gets it. A departure
 * whose text does not parse is kept rather than dropped, so a format this
 * function does not recognise cannot silently remove real service.
 */
function upcomingTrips<T extends { departure: string }>(
  trips: T[],
  at: Date,
  requestedServiceDay: ShuttleServiceDay
): T[] {
  const ordered = [...trips].sort((left, right) => {
    const a = departureMinutes(left.departure);
    const b = departureMinutes(right.departure);
    if (a === null || b === null) return 0;
    return a - b;
  });
  if (requestedServiceDay !== campusServiceDay(at)) return ordered;
  const nowMinutes = campusMinutesOfDay(at);
  return ordered.filter((trip) => {
    const minutes = departureMinutes(trip.departure);
    return minutes === null || minutes > nowMinutes;
  });
}

/**
 * Attaches computed open/closed status to hours records.
 *
 * Only when the row describes the day `at` actually falls on. A question about
 * Saturday's hours asked on a Tuesday wants the published schedule, not a
 * status derived from Tuesday afternoon — attaching one there would be a
 * confident wrong answer rather than a missing field.
 *
 * Interval semantics and the unparseable case are owned by
 * `src/data-v2/schedule-status.ts`.
 */
function withScheduleStatus<T extends { day: string; schedule: string }>(
  records: T[],
  at: Date,
  requestedDay: string
): T[] {
  if (requestedDay !== campusWeekday(at)) return records;
  const minutes = campusMinutesOfDay(at);
  return records.map((record) => ({ ...record, ...scheduleStatusAt(record.schedule, minutes) }));
}

function response(dataset: { id: string; version: string; activatedAt: string }, records: unknown[]) {
  return ok(
    { dataset, records },
    { ...PUBLIC_READ_HEADERS, 'X-RockyGPT-Release': dataset.version }
  );
}

function academicDatesFor(
  request: Parameters<ApiHandler>[0],
  records: AcademicDateRecord[]
): AcademicDateRecord[] {
  const exact = (field: 'family' | 'kind' | 'termId' | 'sessionId'): string =>
    text(request, field).toLowerCase();
  const family = exact('family');
  const kind = exact('kind');
  const termId = exact('termId');
  const sessionId = exact('sessionId');
  const wantedDate = text(request, 'date');
  const startsAfter = text(request, 'startsAfter').slice(0, 10);
  const startsBefore = text(request, 'startsBefore').slice(0, 10);

  return records.filter((record) => {
    if (family && record.family !== family) return false;
    if (kind && record.kind !== kind) return false;
    if (termId && record.termId.toLowerCase() !== termId) return false;
    if (sessionId && record.sessionId?.toLowerCase() !== sessionId) return false;
    const recordDate = record.startsAt?.slice(0, 10) || '';
    if (wantedDate && recordDate !== wantedDate) return false;
    if (startsAfter && (!recordDate || recordDate < startsAfter)) return false;
    if (startsBefore && (!recordDate || recordDate >= startsBefore)) return false;
    return true;
  });
}

/**
 * Resolves one repository operation while pinning every read to the dataset
 * that was active when the request began.
 */
export const getSearch: ApiHandler = async (request) => {
  const invalidLength = validateQueryLengths(request, {
    q: 200,
    day: 16,
    at: 64,
    meal: 64,
    route: 120,
    serviceDay: 16,
    family: 64,
    kind: 64,
    termId: 120,
    sessionId: 120,
    date: 10,
    startsAfter: 64,
    startsBefore: 64,
  });
  if (invalidLength) return invalidLength;

  const at = instant(request);
  if (!at) return fail(400, 'INVALID_REQUEST', '`at` must be an ISO 8601 timestamp.');

  const path = request.url.pathname;
  const requestedDay = text(request, 'day');
  const day = requestedDay ? WEEKDAYS.get(requestedDay.toLowerCase()) : campusWeekday(at);
  if (
    (path === '/v1/search/campus-hours' || path === '/v1/search/dining-hours') &&
    !day
  ) {
    return fail(400, 'INVALID_REQUEST', '`day` must be a weekday name.');
  }
  const requestedServiceDay = text(request, 'serviceDay');
  if (
    path === '/v1/search/shuttles' &&
    requestedServiceDay &&
    !SERVICE_DAYS.has(requestedServiceDay as ShuttleServiceDay)
  ) {
    return fail(400, 'INVALID_REQUEST', '`serviceDay` must be weekday, saturday, or sunday.');
  }
  if (path === '/v1/search/academic-dates') {
    const family = text(request, 'family');
    const kind = text(request, 'kind');
    const date = text(request, 'date');
    const startsAfter = text(request, 'startsAfter');
    const startsBefore = text(request, 'startsBefore');
    if (family && !CALENDAR_FAMILIES.has(family as CalendarFamily)) {
      return fail(400, 'INVALID_REQUEST', '`family` is not a canonical calendar family.');
    }
    if (kind && !CALENDAR_KINDS.has(kind as CalendarKind)) {
      return fail(400, 'INVALID_REQUEST', '`kind` is not a canonical calendar kind.');
    }
    if (date && !parseIsoDate(date)) {
      return fail(400, 'INVALID_REQUEST', '`date` must be an ISO 8601 date.');
    }
    if (startsAfter && !parseIsoInstant(startsAfter)) {
      return fail(400, 'INVALID_REQUEST', '`startsAfter` must be an ISO 8601 timestamp.');
    }
    if (startsBefore && !parseIsoInstant(startsBefore)) {
      return fail(400, 'INVALID_REQUEST', '`startsBefore` must be an ISO 8601 timestamp.');
    }
  }

  const repository = getRepositoryV2();
  const dataset = await repository.getDatasetContext();
  const pinned = repository.withDataset(dataset);
  const query = text(request, 'q');

  if (path === '/v1/search/campus-hours') {
    return response(
      dataset,
      withScheduleStatus(await pinned.findCampusHours(query, day!, at), at, day!)
    );
  }
  if (path === '/v1/search/dining-hours') {
    return response(
      dataset,
      withScheduleStatus(await pinned.findDiningHours(query, day!, at), at, day!)
    );
  }
  if (path === '/v1/search/menu') {
    return response(dataset, await pinned.findMenuItems(query, text(request, 'meal') || undefined));
  }
  if (path === '/v1/search/contacts') {
    return response(dataset, await pinned.findContacts(query));
  }
  if (path === '/v1/search/clubs') {
    return response(dataset, await pinned.findClubs(query));
  }
  if (path === '/v1/search/events') {
    return response(dataset, await pinned.findEvents(query, at));
  }
  if (path === '/v1/search/courses') {
    return response(dataset, await pinned.findCourses(query));
  }
  if (path === '/v1/search/programs') {
    return response(dataset, await pinned.findPrograms(query));
  }
  if (path === '/v1/search/academic-dates') {
    return response(dataset, academicDatesFor(request, await pinned.findAcademicDates(query)));
  }
  if (path === '/v1/search/shuttles') {
    // With no explicit serviceDay, the timetable that applies is the one `at`
    // falls on — not the repository's weekday default, which answered Sunday
    // questions with the weekday schedule.
    const serviceDay = (requestedServiceDay as ShuttleServiceDay) || campusServiceDay(at);
    const trips = await pinned.getShuttleTrips(text(request, 'route') || undefined, serviceDay);
    return response(dataset, upcomingTrips(trips, at, serviceDay));
  }

  return fail(404, 'NOT_FOUND', `Unknown campus search: ${path}`);
};

/** Critical campus contacts and their official source references. */
export const getSafetyResources: ApiHandler = async () => {
  const repository = getRepositoryV2();
  const dataset = await repository.getDatasetContext();
  const pinned = repository.withDataset(dataset);
  const emergency = await pinned.getCriticalFact('safety.emergency_phone');
  return ok(
    {
      dataset,
      emergencyPhone: emergency?.value ?? null,
      sources: {
        safety: V2_SOURCES.safety,
        counseling: V2_SOURCES.counseling,
      },
    },
    { ...PUBLIC_READ_HEADERS, 'X-RockyGPT-Release': dataset.version }
  );
};
