/** Typed, deterministic shuttle capability for Hybrid V1. */

import type {
  ShuttleAppliedFilters,
  ShuttleQueryRequest,
  ShuttleQueryResponse,
  ShuttleSelection,
  ShuttleTimeScope,
  WireEvidence,
  WireShuttleQueryRecord,
  WireShuttleQueryStop,
  WireShuttleServiceDay,
} from '../contract';
import { getRepositoryV2 } from '../../src/data-v2/repositories/index';
import type { ShuttleTripRecord } from '../../src/data-v2/schemas';
import type { SourceReference } from '../../src/data-v2/types';
import { V2_SOURCES } from '../../src/data-v2/sources';
import { fail, ok, type ApiHandler } from '../http';
import { parseIsoDate, parseIsoInstant } from '../query';

const CAMPUS_TIME_ZONE = 'America/New_York';
const CAMPUS_STOP = 'Ramapo College';
const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 50;
const REQUEST_KEYS = new Set([
  'route',
  'origin',
  'destination',
  'serviceDate',
  'serviceDay',
  'asOf',
  'selection',
  'timeScope',
  'limit',
]);
const SELECTIONS = new Set<ShuttleSelection>(['first', 'next', 'all', 'current']);
const TIME_SCOPES = new Set<ShuttleTimeScope>(['full_day', 'remaining', 'at_time']);
const SERVICE_DAYS = new Set<WireShuttleServiceDay>(['weekday', 'saturday', 'sunday']);
const VALID_SCOPE_BY_SELECTION: Record<ShuttleSelection, ReadonlySet<ShuttleTimeScope>> = {
  first: new Set(['full_day']),
  next: new Set(['remaining']),
  all: new Set(['full_day', 'remaining']),
  current: new Set(['at_time']),
};

const V2_HEADERS = { 'Cache-Control': 'no-store' };
const SHUTTLE_ORDERING = [
  { field: 'serviceDate', direction: 'asc' as const },
  { field: 'matchedOrigin.time', direction: 'asc' as const },
  { field: 'route', direction: 'asc' as const },
];

interface ParsedQuery {
  request: ShuttleQueryRequest;
  asOf: Date;
  filters: ShuttleAppliedFilters;
  limit: number;
}

interface TimedStop {
  stop: WireShuttleQueryStop;
  minutes: number | null;
}

interface DatedTrip {
  trip: ShuttleTripRecord;
  serviceDate: string;
  serviceDay: WireShuttleServiceDay;
}

interface MatchedTrip {
  trip: ShuttleTripRecord;
  serviceDate: string;
  serviceDay: WireShuttleServiceDay;
  departure: TimedStop;
  stops: TimedStop[];
  arrival: TimedStop;
  origin: TimedStop;
  destination: TimedStop;
  originMinutes: number | null;
  destinationMinutes: number | null;
  originSortMinutes: number | null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function optionalBoundedString(
  body: Record<string, unknown>,
  key: 'route' | 'origin' | 'destination',
  maxLength = 120
): string | undefined | null {
  const value = body[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLength) return null;
  return trimmed;
}

function campusDate(at: Date): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: CAMPUS_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(at);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((entry) => entry.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

function serviceDayForDate(date: string): WireShuttleServiceDay {
  const weekday = new Date(`${date}T00:00:00.000Z`).getUTCDay();
  if (weekday === 6) return 'saturday';
  if (weekday === 0) return 'sunday';
  return 'weekday';
}

function previousDate(date: string): string {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day - 1)).toISOString().slice(0, 10);
}

function parseQuery(body: unknown): ParsedQuery | string {
  if (!isObject(body)) return 'Request body must be a JSON object.';
  const unknown = Object.keys(body).find((key) => !REQUEST_KEYS.has(key));
  if (unknown) return `Unknown request property: \`${unknown}\`.`;

  const route = optionalBoundedString(body, 'route');
  const origin = optionalBoundedString(body, 'origin');
  const destination = optionalBoundedString(body, 'destination');
  if (route === null || origin === null || destination === null) {
    return '`route`, `origin`, and `destination` must be non-empty strings of at most 120 characters.';
  }

  if (typeof body.asOf !== 'string' || body.asOf.length > 64) {
    return '`asOf` must be an ISO 8601 timestamp with an explicit timezone.';
  }
  const asOf = parseIsoInstant(body.asOf);
  if (!asOf) return '`asOf` must be an ISO 8601 timestamp with an explicit timezone.';

  if (typeof body.selection !== 'string' || !SELECTIONS.has(body.selection as ShuttleSelection)) {
    return '`selection` must be first, next, all, or current.';
  }
  const selection = body.selection as ShuttleSelection;
  if (typeof body.timeScope !== 'string' || !TIME_SCOPES.has(body.timeScope as ShuttleTimeScope)) {
    return '`timeScope` must be full_day, remaining, or at_time.';
  }
  const timeScope = body.timeScope as ShuttleTimeScope;
  if (!VALID_SCOPE_BY_SELECTION[selection].has(timeScope)) {
    return `\`selection=${selection}\` is incompatible with \`timeScope=${timeScope}\`.`;
  }

  let serviceDate = campusDate(asOf);
  if (body.serviceDate !== undefined) {
    if (typeof body.serviceDate !== 'string' || !parseIsoDate(body.serviceDate)) {
      return '`serviceDate` must be a valid YYYY-MM-DD date.';
    }
    serviceDate = body.serviceDate;
  }
  const derivedServiceDay = serviceDayForDate(serviceDate);
  if (body.serviceDay !== undefined && body.serviceDate === undefined) {
    return '`serviceDate` is required when `serviceDay` is supplied.';
  }
  if (
    body.serviceDay !== undefined &&
    (typeof body.serviceDay !== 'string' ||
      !SERVICE_DAYS.has(body.serviceDay as WireShuttleServiceDay))
  ) {
    return '`serviceDay` must be weekday, saturday, or sunday.';
  }
  if (body.serviceDay !== undefined && body.serviceDay !== derivedServiceDay) {
    return '`serviceDay` must agree with the weekday derived from `serviceDate`.';
  }

  let limit = selection === 'first' || selection === 'next' ? 1 : DEFAULT_LIMIT;
  if (body.limit !== undefined) {
    if (!Number.isInteger(body.limit) || (body.limit as number) < 1 || (body.limit as number) > MAX_LIMIT) {
      return `\`limit\` must be an integer from 1 to ${MAX_LIMIT}.`;
    }
    if (selection !== 'first' && selection !== 'next') limit = body.limit as number;
  }

  const request: ShuttleQueryRequest = {
    ...(route ? { route } : {}),
    ...(origin ? { origin } : {}),
    ...(destination ? { destination } : {}),
    serviceDate,
    serviceDay: derivedServiceDay,
    asOf: body.asOf,
    selection,
    timeScope,
    ...(body.limit === undefined ? {} : { limit: body.limit as number }),
  };
  const serviceDatesConsidered =
    serviceDate === campusDate(asOf) &&
    (timeScope === 'at_time' || timeScope === 'remaining')
      ? [serviceDate, previousDate(serviceDate)]
      : [serviceDate];
  const filters: ShuttleAppliedFilters = {
    ...(route ? { route } : {}),
    ...(origin ? { origin } : {}),
    ...(destination ? { destination } : {}),
    serviceDate,
    serviceDay: derivedServiceDay,
    serviceDatesConsidered,
    asOf: asOf.toISOString(),
    selection,
    timeScope,
  };
  return { request, asOf, filters, limit };
}

function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/\broute\b/g, 'route')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function routeAliases(route: string): Set<string> {
  const aliases = new Set([normalize(route)]);
  if (/roadrunner/i.test(route)) {
    aliases.add('roadrunner');
    aliases.add('roadrunner express');
    aliases.add('ramapo roadrunner express');
  }
  if (/ramsey.*17/i.test(route)) {
    for (const alias of [
      'ramsey',
      'ramsey express',
      'ramsey route 17',
      'ramsey route 17 express',
      'route 17 express',
      'train loop',
      'express train loop',
    ]) aliases.add(alias);
  }
  return aliases;
}

function routeMatches(route: string, requested: string | undefined): boolean {
  return !requested || routeAliases(route).has(normalize(requested));
}

function stopAliases(location: string): Set<string> {
  const normalized = normalize(location);
  const withoutRole = normalize(location.replace(/\((?:drop[- ]?off|pick[- ]?up)\)/gi, ''));
  const aliases = new Set([normalized, withoutRole]);
  if (normalized === normalize(CAMPUS_STOP)) {
    for (const alias of [
      'campus',
      'ramapo',
      'ramapo campus',
      'ramapo college campus',
      'bradley center',
      'health services',
    ]) aliases.add(alias);
  }
  if (normalized.includes('ramsey rt 17')) {
    for (const alias of [
      'ramsey',
      'ramsey station',
      'ramsey train station',
      'ramsey rt 17',
      'ramsey rt 17 station',
      'ramsey route 17',
      'ramsey route 17 station',
      'route 17 station',
    ]) aliases.add(alias);
  }
  if (normalized === 'garden state plaza') aliases.add('gsp');
  if (normalized.includes('barnes and noble')) {
    aliases.add('barnes and noble');
    aliases.add('barnes noble');
    aliases.add('fashion center');
  }
  if (normalized.includes('citymd')) aliases.add('city md ramsey');
  return aliases;
}

function stopMatches(location: string, requested: string): boolean {
  return stopAliases(location).has(normalize(requested));
}

/** "7:25 AM" and "13:05" become campus-local wall-clock minutes. */
function clockMinutes(value: string): number | null {
  const twelveHour = /^(\d{1,2})(?::\s?(\d{2}))?\s*([ap])\.?\s*m\.?$/i.exec(value.trim());
  if (twelveHour) {
    const rawHour = Number(twelveHour[1]);
    const minute = Number(twelveHour[2] ?? 0);
    if (rawHour < 1 || rawHour > 12 || minute > 59) return null;
    const hour = rawHour % 12 + (twelveHour[3].toLowerCase() === 'p' ? 12 : 0);
    return hour * 60 + minute;
  }
  const twentyFourHour = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!twentyFourHour) return null;
  const hour = Number(twentyFourHour[1]);
  const minute = Number(twentyFourHour[2]);
  return hour <= 23 && minute <= 59 ? hour * 60 + minute : null;
}

function monotonicStops(stops: WireShuttleQueryStop[]): TimedStop[] {
  let previous: number | null = null;
  return stops.map((stop) => {
    let minutes = clockMinutes(stop.time);
    if (minutes !== null && previous !== null) {
      while (minutes < previous) minutes += 24 * 60;
    }
    if (minutes !== null) previous = minutes;
    return { stop, minutes };
  });
}

function matchTrip(
  datedTrip: DatedTrip,
  originQuery: string | undefined,
  destinationQuery: string | undefined
): MatchedTrip | null {
  const { trip, serviceDate, serviceDay } = datedTrip;
  const arrivalLocation = clockMinutes(trip.arrival) === null ? 'End of service' : CAMPUS_STOP;
  const timed = monotonicStops([
    { location: CAMPUS_STOP, time: trip.departure },
    ...trip.stops,
    { location: arrivalLocation, time: trip.arrival },
  ]);
  const departure = timed[0];
  const arrival = timed[timed.length - 1];

  let originIndex = 0;
  if (originQuery) {
    const candidates = timed
      .map((entry, index) => ({ entry, index }))
      .filter(({ entry }) => stopMatches(entry.stop.location, originQuery));
    if (candidates.length === 0) return null;
    // Campus means the outbound departure. Repeated off-campus stops mean a
    // pickup when used as an origin, so choose their final occurrence.
    originIndex = stopMatches(CAMPUS_STOP, originQuery)
      ? candidates[0].index
      : candidates[candidates.length - 1].index;
  }

  let destinationIndex = timed.length - 1;
  if (destinationQuery) {
    const candidates = timed
      .map((entry, index) => ({ entry, index }))
      .filter(
        ({ entry, index }) =>
          index > originIndex && stopMatches(entry.stop.location, destinationQuery)
      );
    if (candidates.length === 0) return null;
    // Campus is the return arrival. A repeated off-campus stop means the first
    // drop-off after the chosen origin when used as a destination.
    destinationIndex = stopMatches(CAMPUS_STOP, destinationQuery)
      ? candidates[candidates.length - 1].index
      : candidates[0].index;
  }
  if (destinationIndex <= originIndex) return null;

  const origin = timed[originIndex];
  const destination = timed[destinationIndex];
  const lastKnownMinute = [...timed].reverse().find((entry) => entry.minutes !== null)?.minutes ?? null;
  return {
    trip,
    serviceDate,
    serviceDay,
    departure,
    stops: timed.slice(1, -1),
    arrival,
    origin,
    destination,
    originMinutes: origin.minutes,
    destinationMinutes: destination.minutes ?? lastKnownMinute,
    originSortMinutes:
      origin.minutes === null ? null : dateOrdinal(serviceDate) * 24 * 60 + origin.minutes,
  };
}

function campusMinutes(at: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: CAMPUS_TIME_ZONE,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(at);
  const hour = Number(parts.find((entry) => entry.type === 'hour')?.value ?? 0) % 24;
  const minute = Number(parts.find((entry) => entry.type === 'minute')?.value ?? 0);
  return hour * 60 + minute;
}

function dateOrdinal(date: string): number {
  const [year, month, day] = date.split('-').map(Number);
  return Math.floor(Date.UTC(year, month - 1, day) / 86_400_000);
}

function referenceMinutes(asOf: Date, serviceDate: string): number {
  const asOfDate = campusDate(asOf);
  return (dateOrdinal(asOfDate) - dateOrdinal(serviceDate)) * 24 * 60 + campusMinutes(asOf);
}

function sourceEvidenceId(sourceId: string): string {
  return `source:${sourceId}`;
}

function sourceEvidence(sources: SourceReference[]): WireEvidence[] {
  const byId = new Map<string, WireEvidence>();
  for (const source of sources) {
    if (!byId.has(source.sourceId)) {
      byId.set(source.sourceId, {
        evidenceId: sourceEvidenceId(source.sourceId),
        sourceId: source.sourceId,
        title: source.title,
        url: source.url,
        ...(source.collectedAt ? { collectedAt: source.collectedAt } : {}),
      });
    }
  }
  return [...byId.values()].sort((left, right) => left.evidenceId.localeCompare(right.evidenceId));
}

function toWireRecord(
  matched: MatchedTrip
): WireShuttleQueryRecord {
  return {
    route: matched.trip.route,
    serviceDate: matched.serviceDate,
    serviceDay: matched.serviceDay,
    departure: matched.departure.stop,
    stops: matched.stops.map(({ stop }) => stop),
    arrival: matched.arrival.stop,
    matchedOrigin: matched.origin.stop,
    matchedDestination: matched.destination.stop,
    evidenceIds: [sourceEvidenceId(matched.trip.source.sourceId)],
  };
}

/** retrieve -> filter -> sort -> semantic select -> bound -> completeness */
export const postShuttleQuery: ApiHandler = async (apiRequest) => {
  const parsed = parseQuery(apiRequest.body);
  if (typeof parsed === 'string') return fail(400, 'INVALID_REQUEST', parsed);

  const repository = getRepositoryV2();
  const dataset = await repository.getDatasetContext();
  const pinned = repository.withDataset(dataset);
  let allTrips: DatedTrip[];
  try {
    const byDate = await Promise.all(
      parsed.filters.serviceDatesConsidered.map(async (serviceDate) => {
        const serviceDay = serviceDayForDate(serviceDate);
        const trips = await pinned.listShuttleTrips(serviceDay);
        return trips.map((trip) => ({ trip, serviceDate, serviceDay }));
      })
    );
    allTrips = byDate.flat();
  } catch {
    const unavailable: ShuttleQueryResponse = {
      outcome: 'unavailable',
      records: [],
      completeness: {
        state: 'unknown',
        returned: 0,
        limit: parsed.limit,
        truncated: false,
        reason: 'dependency_unavailable',
      },
      appliedFilters: parsed.filters,
      ordering: SHUTTLE_ORDERING,
      dataset,
      evidence: sourceEvidence([V2_SOURCES.transportation]),
      safeErrorCode: 'SHUTTLE_DATA_UNAVAILABLE',
    };
    return {
      status: 503,
      body: unavailable,
      headers: { ...V2_HEADERS, 'X-RockyGPT-Release': dataset.version },
    };
  }
  const entityMatches = allTrips
    .filter(({ trip }) => routeMatches(trip.route, parsed.request.route))
    .flatMap((datedTrip) => {
      const match = matchTrip(datedTrip, parsed.request.origin, parsed.request.destination);
      return match ? [match] : [];
    });
  const timeMatches = entityMatches
    .filter((match) => {
      if (parsed.filters.timeScope === 'full_day') return true;
      if (match.originMinutes === null) return false;
      const reference = referenceMinutes(parsed.asOf, match.serviceDate);
      if (parsed.filters.timeScope === 'remaining') return match.originMinutes > reference;
      return (
        match.destinationMinutes !== null &&
        match.originMinutes <= reference &&
        reference < match.destinationMinutes
      );
    });
  let selectedMatches = timeMatches
    .sort((left, right) => {
      const byTime = (left.originSortMinutes ?? Number.POSITIVE_INFINITY) -
        (right.originSortMinutes ?? Number.POSITIVE_INFINITY);
      if (byTime !== 0) return byTime;
      const byRoute = left.trip.route.localeCompare(right.trip.route);
      return byRoute || left.trip.departure.localeCompare(right.trip.departure);
    });

  if (parsed.filters.selection === 'first' || parsed.filters.selection === 'next') {
    selectedMatches = selectedMatches.slice(0, 1);
  }
  const matched = selectedMatches.length;
  const bounded = selectedMatches.slice(0, parsed.limit);
  const truncated = bounded.length < matched;
  const records = bounded.map(toWireRecord);
  const negativeReason = allTrips.length === 0
    ? 'dataset_empty' as const
    : entityMatches.length === 0
      ? 'entity_no_match' as const
      : parsed.filters.timeScope === 'remaining'
        ? 'no_remaining' as const
        : 'not_current' as const;
  const body: ShuttleQueryResponse = {
    outcome: records.length > 0
      ? 'success'
      : entityMatches.length === 0 && allTrips.length > 0
        ? 'no_match'
        : 'empty',
    records,
    completeness: {
      state: truncated ? 'partial' : 'complete',
      returned: records.length,
      matched,
      limit: parsed.limit,
      truncated,
      ...(truncated ? { reason: 'limit' as const } : records.length === 0 ? { reason: negativeReason } : {}),
    },
    appliedFilters: parsed.filters,
    ordering: SHUTTLE_ORDERING,
    dataset,
    evidence: records.length > 0
      ? sourceEvidence(bounded.map((match) => match.trip.source))
      : sourceEvidence([V2_SOURCES.transportation]),
  };
  return ok(body, { ...V2_HEADERS, 'X-RockyGPT-Release': dataset.version });
};
