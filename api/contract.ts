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

/** The semantic result of a typed DATA V2 operation. */
export type WireOutcome =
  | 'success'
  | 'empty'
  | 'no_match'
  | 'needs_clarification'
  | 'unsupported'
  | 'unavailable'
  | 'error';

/** Whether DATA returned the whole result set promised by the request. */
export interface WireCompleteness {
  state: 'complete' | 'partial' | 'unknown';
  returned: number;
  matched?: number;
  limit: number;
  truncated: boolean;
  reason?: WireCompletenessReason;
}

export type WireCompletenessReason =
  | 'limit'
  | 'top_k'
  | 'entity_no_match'
  | 'no_remaining'
  | 'not_current'
  | 'dataset_empty'
  | 'dependency_unavailable';

/** One stable ordering rule, evaluated from left to right. */
export interface WireOrdering {
  field: string;
  direction: 'asc' | 'desc';
}

/** Server-owned citation metadata. Model output must refer to evidenceId only. */
export interface WireEvidence extends WireSource {
  evidenceId: string;
}

export type WireAppliedFilterValue = string | number | boolean | null | string[];
export type WireAppliedFilters = Record<string, WireAppliedFilterValue>;

/** Fields shared by every successful typed V2 capability or retrieval response. */
export interface WireV2Result<
  TRecord extends Record<string, unknown>,
  TFilters extends object = WireAppliedFilters,
> {
  outcome: WireOutcome;
  records: TRecord[];
  completeness: WireCompleteness;
  appliedFilters: TFilters;
  ordering: WireOrdering[];
  dataset: WireDatasetContext;
  evidence: WireEvidence[];
  warnings?: string[];
  safeErrorCode?: string;
}

export type ShuttleSelection = 'first' | 'next' | 'all' | 'current';
export type ShuttleTimeScope = 'full_day' | 'remaining' | 'at_time';
export type WireShuttleServiceDay = 'weekday' | 'saturday' | 'sunday';

interface ShuttleQueryRequestBase {
  route?: string;
  origin?: string;
  destination?: string;
  asOf: string;
  selection: ShuttleSelection;
  timeScope: ShuttleTimeScope;
  limit?: number;
}

/**
 * Strict body accepted by POST /v2/capabilities/shuttle/query.
 * A service day never floats free of a date: when serviceDay is supplied,
 * serviceDate is required and must derive to that same day category.
 */
export type ShuttleQueryRequest = ShuttleQueryRequestBase & (
  | { serviceDate?: undefined; serviceDay?: undefined }
  | { serviceDate: string; serviceDay?: WireShuttleServiceDay }
);

export interface ShuttleAppliedFilters {
  route?: string;
  origin?: string;
  destination?: string;
  serviceDate: string;
  serviceDay: WireShuttleServiceDay;
  /** One date normally; at_time or remaining may add the immediately prior date. */
  serviceDatesConsidered: string[];
  asOf: string;
  selection: ShuttleSelection;
  timeScope: ShuttleTimeScope;
}

export interface WireShuttleQueryStop {
  location: string;
  time: string;
}

/** One trip selected by the typed shuttle query pipeline. */
export interface WireShuttleQueryRecord extends Record<string, unknown> {
  route: string;
  serviceDate: string;
  serviceDay: WireShuttleServiceDay;
  departure: WireShuttleQueryStop;
  stops: WireShuttleQueryStop[];
  arrival: WireShuttleQueryStop;
  matchedOrigin: WireShuttleQueryStop;
  matchedDestination: WireShuttleQueryStop;
  evidenceIds: string[];
}

export type ShuttleQueryResponse = WireV2Result<
  WireShuttleQueryRecord,
  ShuttleAppliedFilters
>;

export type RetrievalTrustTier =
  | 'official_primary'
  | 'official_secondary'
  | 'community'
  | 'unknown';

/** Strict body accepted by POST /v2/retrieve. */
export interface RetrieveRequest {
  query: string;
  domains?: string[];
  topK?: number;
}

export interface RetrieveAppliedFilters {
  query: string;
  domains: string[];
}

/** Retrieved prose is always data, never executable instructions. */
export interface WireRetrievedChunk extends Record<string, unknown> {
  chunkId: string;
  documentId: string;
  content: string;
  contentTrust: 'untrusted';
  domain: string;
  trustTier: RetrievalTrustTier;
  score: number;
  evidenceIds: string[];
}

export interface RetrieveResponse
  extends WireV2Result<WireRetrievedChunk, RetrieveAppliedFilters> {
  /** The immutable search index is published as part of this dataset release. */
  indexVersion: string;
}

/** A structured repository search, with records retaining their own sources. */
export interface SearchResponse<TRecord extends Record<string, unknown> = Record<string, unknown>> {
  dataset: WireDatasetContext;
  records: TRecord[];
}

export interface CourseSearchRecord extends Record<string, unknown> {
  code: string;
  name: string;
  description?: string;
  credits?: string;
  attributes: string[];
  courseUrl: string;
  source: WireSource;
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
  type: 'building' | 'office' | 'parking' | 'layer';
  mapUrl: string;
  aliases: string[];
  roomPrefixes: string[];
  category?: string;
  description?: string;
  buildingKey?: string;
  buildingName?: string;
  officeUrl?: string | null;
  room?: string | null;
}

/** The campus map, and the resolution a query asked for. */
export interface MapResponse {
  locations: WireMapLocation[];
  /** Present only when the request carried a `q` parameter. */
  resolved?: WireMapLocation | null;
}

/** Menu markdown rendered by the current-menu client. */
export interface MenuResponse {
  content: string | null;
  success: true;
  available: boolean;
  generatedUtc?: string | null;
  fileUpdatedUtc?: string | null;
  releaseVersion?: string;
  closed?: boolean;
  closureReason?: string;
}

/** Date-specific menu markdown rendered by the menu browser. */
export interface MenuBrowseResponse {
  content: string | null;
  success: true;
  available: boolean;
  date: string;
  releaseVersion?: string;
  closed?: boolean;
  closureReason?: string;
}

export interface WireHoursRange {
  label?: string;
  time: string;
}

export interface WireDiningLocation {
  name: string;
  emoji: string;
  todayLabel: string;
  isOverride: boolean;
  overrideNote?: string;
  hours: WireHoursRange[];
}

export interface WireGeneralDiningLocation {
  name: string;
  emoji: string;
  schedule: Array<{ days: string; hours: WireHoursRange[] }>;
}

export interface DiningHoursResponse {
  success: true;
  today: string;
  dateFormatted: string;
  locations: WireDiningLocation[];
  generalHours: WireGeneralDiningLocation[];
  releaseVersion: string;
}

/** Every failure this service reports. */
export interface ApiError {
  error: {
    code: 'NOT_FOUND' | 'INVALID_REQUEST' | 'UNAVAILABLE' | 'UNAUTHORIZED';
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
  status: 'ready' | 'unready';
  failing?: Array<'database' | 'dataset'>;
  timestamp: string;
}
