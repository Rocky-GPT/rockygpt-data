/**
 * @module api/contract
 * The wire contract for the campus data service.
 *
 * This module imports nothing. A caller — the web app, a native client, or a
 * service written in another language — can depend on these shapes without
 * pulling in the repository layer, a database driver, or anything else that
 * only makes sense inside this package.
 *
 * Everything here must survive `JSON.stringify`.
 */

/** A source the data was drawn from, echoed so a client can cite it. */
export interface WireSource {
  sourceId: string;
  title: string;
  url: string;
  collectedAt?: string;
}

/** The immutable campus-data release one request was pinned to. */
export interface WireDatasetContext {
  id: string;
  version: string;
  activatedAt: string;
}

/** A structured repository search, with records retaining their own sources. */
export interface SearchResponse<TRecord extends Record<string, unknown> = Record<string, unknown>> {
  dataset: WireDatasetContext;
  records: TRecord[];
}

/** Emergency facts used by deterministic safety replies. */
export interface SafetyResourcesResponse {
  dataset: WireDatasetContext;
  emergencyPhone: string | null;
  sources: {
    safety: WireSource;
    counseling: WireSource;
  };
}

/** The published datasets a client can request wholesale. */
export type ArtifactKey = 'calendar' | 'clubs' | 'courses' | 'events' | 'hours' | 'programs';

/** One scheduled stop within a shuttle trip. */
export interface WireShuttleStop {
  location: string;
  time: string;
}

/** One shuttle trip: a campus departure, its stops, and its arrival. */
export interface WireShuttleTrip {
  departure: string;
  stops: WireShuttleStop[];
  arrival: string;
}

/** Every shuttle and bus timetable the service publishes. */
export interface ShuttleResponse {
  trainLoop: WireShuttleTrip[];
  shortline: {
    toNYC: { weekday: string[]; saturday: string[]; sunday: string[] };
    fromNYC: { weekday: string[]; saturday: string[]; sunday: string[] };
  };
  weekday: WireShuttleTrip[];
  saturday: WireShuttleTrip[];
  sunday: WireShuttleTrip[];
}

/** A place on the campus map, with whatever identifiers it is known by. */
export interface WireMapLocation {
  key: string;
  name: string;
  kind: string;
  aliases?: string[];
  building?: string;
  room?: string;
  latitude?: number;
  longitude?: number;
  [field: string]: unknown;
}

/** The campus map, and the resolution a query asked for. */
export interface MapResponse {
  locations: WireMapLocation[];
  /** Present only when the request carried a `q` parameter. */
  resolved?: WireMapLocation | null;
}

/** Every failure this service reports. */
export interface ApiError {
  error: {
    code: 'NOT_FOUND' | 'INVALID_REQUEST' | 'UNAVAILABLE';
    message: string;
    retryable: boolean;
  };
}

/** Liveness, for probes and compose healthchecks. */
export interface ServiceHealth {
  status: 'healthy';
  service: 'rockygpt-data';
  uptimeSeconds: number;
}

/** Whether the service can actually serve campus data, not merely respond. */
export interface ServiceReadiness {
  status: 'ready' | 'degraded';
  datasetVersion?: string;
  detail?: string;
}
