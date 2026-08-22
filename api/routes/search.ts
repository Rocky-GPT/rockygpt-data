/** Structured campus searches used by the brain and any future client. */

import { getRepositoryV2 } from '../../src/data-v2/repositories/index';
import type { ShuttleServiceDay } from '../../src/data-v2/schemas';
import { V2_SOURCES } from '../../src/data-v2/sources';
import { fail, ok, PUBLIC_READ_HEADERS, type ApiHandler } from '../http';
import { parseIsoInstant, validateQueryLengths } from '../query';

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

function response(dataset: { id: string; version: string; activatedAt: string }, records: unknown[]) {
  return ok(
    { dataset, records },
    { ...PUBLIC_READ_HEADERS, 'X-RockyGPT-Release': dataset.version }
  );
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

  const repository = getRepositoryV2();
  const dataset = await repository.getDatasetContext();
  const pinned = repository.withDataset(dataset);
  const query = text(request, 'q');

  if (path === '/v1/search/campus-hours') {
    return response(dataset, await pinned.findCampusHours(query, day!, at));
  }
  if (path === '/v1/search/dining-hours') {
    return response(dataset, await pinned.findDiningHours(query, day!, at));
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
  if (path === '/v1/search/programs') {
    return response(dataset, await pinned.findPrograms(query));
  }
  if (path === '/v1/search/academic-dates') {
    return response(dataset, await pinned.findAcademicDates(query));
  }
  if (path === '/v1/search/shuttles') {
    return response(
      dataset,
      await pinned.getShuttleTrips(
        text(request, 'route') || undefined,
        (requestedServiceDay as ShuttleServiceDay) || undefined
      )
    );
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
