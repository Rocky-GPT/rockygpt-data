/** Structured campus searches used by the brain and any future client. */

import { getRepositoryV2 } from '../../src/data-v2/repositories/index';
import type { ShuttleServiceDay } from '../../src/data-v2/schemas';
import { V2_SOURCES } from '../../src/data-v2/sources';
import { fail, ok, PUBLIC_READ_HEADERS, type ApiHandler } from '../http';

const CAMPUS_TIME_ZONE = 'America/New_York';
const SERVICE_DAYS = new Set<ShuttleServiceDay>(['weekday', 'saturday', 'sunday']);

function text(request: Parameters<ApiHandler>[0], key: string): string {
  return request.url.searchParams.get(key)?.trim() ?? '';
}

function instant(request: Parameters<ApiHandler>[0]): Date | null {
  const raw = text(request, 'at');
  if (!raw) return new Date();
  const value = new Date(raw);
  return Number.isNaN(value.getTime()) ? null : value;
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
  const at = instant(request);
  if (!at) return fail(400, 'INVALID_REQUEST', '`at` must be an ISO 8601 timestamp.');

  const repository = getRepositoryV2();
  const dataset = await repository.getDatasetContext();
  const pinned = repository.withDataset(dataset);
  const query = text(request, 'q');
  const path = request.url.pathname;

  if (path === '/v1/search/campus-hours') {
    const day = text(request, 'day') || campusWeekday(at);
    return response(dataset, await pinned.findCampusHours(query, day, at));
  }
  if (path === '/v1/search/dining-hours') {
    const day = text(request, 'day') || campusWeekday(at);
    return response(dataset, await pinned.findDiningHours(query, day, at));
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
    const requested = text(request, 'serviceDay');
    if (requested && !SERVICE_DAYS.has(requested as ShuttleServiceDay)) {
      return fail(400, 'INVALID_REQUEST', '`serviceDay` must be weekday, saturday, or sunday.');
    }
    return response(
      dataset,
      await pinned.getShuttleTrips(
        text(request, 'route') || undefined,
        (requested as ShuttleServiceDay) || undefined
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
