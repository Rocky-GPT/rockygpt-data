import type { QueryResultRow } from 'pg';
import { getRuntimePool } from '../db/runtime-pool';
import type {
  DataExplorerPayload,
  ExplorerColumn,
  ExplorerDataset,
  ExplorerRecords,
  ExplorerReleaseSummary,
  ExplorerValue,
} from './types';

const PAGE_SIZE = 500;
const MAX_SEARCH_LENGTH = 120;
const ACTIVE_DATASET_CTE = `
  WITH active_dataset AS (
    SELECT id
    FROM rockygpt_v2.dataset_versions
    WHERE status = 'active'
    LIMIT 1
  )
`;

interface DatasetDefinition {
  key: string;
  label: string;
  group: ExplorerDataset['group'];
  description: string;
  fromSql: string;
  selectSql: string;
  columns: ExplorerColumn[];
  searchSql: string[];
  orderBySql: string;
  sortSql?: Readonly<Record<string, string>>;
  defaultSort?: { key: string; direction: 'asc' | 'desc' };
  charted?: boolean;
}

function columns(...entries: Array<[string, string]>): ExplorerColumn[] {
  return entries.map(([key, label]) => ({ key, label }));
}

const DATASETS: readonly DatasetDefinition[] = [
  {
    key: 'critical-facts',
    label: 'Critical facts',
    group: 'Campus data',
    description: 'Human-verified values used for safety-sensitive and high-stakes answers.',
    fromSql:
      'rockygpt_v2.critical_facts t JOIN active_dataset a ON a.id = t.dataset_version_id JOIN rockygpt_v2.sources s ON s.id = t.source_id',
    selectSql:
      't.fact_key, t.fact_value, s.title AS source, t.verified_at, t.collected_at, t.valid_from, t.valid_until',
    columns: columns(
      ['fact_key', 'Fact'],
      ['fact_value', 'Value'],
      ['source', 'Source'],
      ['verified_at', 'Verified'],
      ['collected_at', 'Collected'],
      ['valid_from', 'Valid from'],
      ['valid_until', 'Valid until']
    ),
    searchSql: ['t.fact_key', 't.fact_value', 's.title'],
    orderBySql: 't.fact_key',
    charted: true,
  },
  {
    key: 'campus-contacts',
    label: 'Campus contacts',
    group: 'Campus data',
    description: 'Official campus directory records used by directory searches.',
    fromSql:
      'rockygpt_v2.campus_contacts t JOIN active_dataset a ON a.id = t.dataset_version_id JOIN rockygpt_v2.sources s ON s.id = t.source_id',
    selectSql:
      't.name, t.department, t.phone, t.email, t.office, s.title AS source, t.collected_at',
    columns: columns(
      ['name', 'Name'],
      ['department', 'Department'],
      ['phone', 'Phone'],
      ['email', 'Email'],
      ['office', 'Office'],
      ['source', 'Source'],
      ['collected_at', 'Collected']
    ),
    searchSql: ['t.name', 't.department', 't.phone', 't.email', 't.office'],
    orderBySql: 't.name',
    charted: true,
  },
  {
    key: 'campus-hours',
    label: 'Campus hours',
    group: 'Campus data',
    description: 'Opening schedules for campus facilities and services.',
    fromSql:
      'rockygpt_v2.campus_hours t JOIN active_dataset a ON a.id = t.dataset_version_id JOIN rockygpt_v2.sources s ON s.id = t.source_id',
    selectSql: 't.name, t.day, t.schedule, s.title AS source, t.collected_at',
    columns: columns(
      ['name', 'Location'],
      ['day', 'Day'],
      ['schedule', 'Schedule'],
      ['source', 'Source'],
      ['collected_at', 'Collected']
    ),
    searchSql: ['t.name', 't.day', 't.schedule'],
    orderBySql: 't.name, t.day',
    charted: true,
  },
  {
    key: 'dining-hours',
    label: 'Dining hours',
    group: 'Campus data',
    description: 'Published schedules for dining locations.',
    fromSql:
      'rockygpt_v2.dining_hours t JOIN active_dataset a ON a.id = t.dataset_version_id JOIN rockygpt_v2.sources s ON s.id = t.source_id',
    selectSql: 't.name, t.day, t.schedule, s.title AS source, t.collected_at',
    columns: columns(
      ['name', 'Location'],
      ['day', 'Day'],
      ['schedule', 'Schedule'],
      ['source', 'Source'],
      ['collected_at', 'Collected']
    ),
    searchSql: ['t.name', 't.day', 't.schedule'],
    orderBySql: 't.name, t.day',
    charted: true,
  },
  {
    key: 'menu-items',
    label: 'Menu items',
    group: 'Campus data',
    description: 'Current 7-day dining menu items, stations, dietary flags, and allergens.',
    fromSql:
      'rockygpt_v2.menu_items t JOIN active_dataset a ON a.id = t.dataset_version_id JOIN rockygpt_v2.sources s ON s.id = t.source_id',
    selectSql:
      't.valid_from AS date, t.meal, t.station, t.name, t.calories, t.vegan, t.vegetarian, t.allergens, s.title AS source, t.collected_at',
    columns: columns(
      ['date', 'Date'],
      ['meal', 'Meal'],
      ['station', 'Station'],
      ['name', 'Item'],
      ['calories', 'Calories'],
      ['vegan', 'Vegan'],
      ['vegetarian', 'Vegetarian'],
      ['allergens', 'Allergens'],
      ['source', 'Source'],
      ['collected_at', 'Collected']
    ),
    searchSql: ['t.valid_from::text', 't.meal', 't.station', 't.name', 't.calories', 't.allergens::text'],
    orderBySql: 't.valid_from, t.meal, t.station, t.name',
    charted: true,
  },
  {
    key: 'shuttle-routes',
    label: 'Shuttle routes',
    group: 'Campus data',
    description: 'Named transportation routes and their applicable service days.',
    fromSql:
      'rockygpt_v2.shuttle_routes t JOIN active_dataset a ON a.id = t.dataset_version_id JOIN rockygpt_v2.sources s ON s.id = t.source_id',
    selectSql: 't.name, t.service_day, s.title AS source, t.collected_at',
    columns: columns(
      ['name', 'Route'],
      ['service_day', 'Service day'],
      ['source', 'Source'],
      ['collected_at', 'Collected']
    ),
    searchSql: ['t.name', 't.service_day'],
    orderBySql: 't.service_day, t.name',
  },
  {
    key: 'shuttle-trips',
    label: 'Shuttle trips',
    group: 'Campus data',
    description: 'Individual shuttle departures, arrivals, and intermediate stops.',
    fromSql:
      'rockygpt_v2.shuttle_trips t JOIN active_dataset a ON a.id = t.dataset_version_id JOIN rockygpt_v2.shuttle_routes r ON r.id = t.route_id JOIN rockygpt_v2.sources s ON s.id = t.source_id',
    selectSql:
      'r.name AS route, r.service_day, t.sequence, t.departure, t.arrival, t.stops, s.title AS source, t.collected_at',
    columns: columns(
      ['route', 'Route'],
      ['service_day', 'Service day'],
      ['sequence', 'Sequence'],
      ['departure', 'Departure'],
      ['arrival', 'Arrival'],
      ['stops', 'Stops'],
      ['source', 'Source'],
      ['collected_at', 'Collected']
    ),
    searchSql: ['r.name', 'r.service_day', 't.departure', 't.arrival', 't.stops::text'],
    orderBySql: 'r.service_day, r.name, t.sequence',
    charted: true,
  },
  {
    key: 'academic-dates',
    label: 'Academic dates',
    group: 'Campus data',
    description: 'Academic calendar dates, deadlines, breaks, and term milestones.',
    fromSql:
      'rockygpt_v2.academic_dates t JOIN active_dataset a ON a.id = t.dataset_version_id JOIN rockygpt_v2.sources s ON s.id = t.source_id',
    selectSql:
      't.term, t.date_label, t.title, t.description, t.starts_at, s.title AS source, t.collected_at',
    columns: columns(
      ['term', 'Term'],
      ['date_label', 'Date'],
      ['title', 'Title'],
      ['description', 'Description'],
      ['starts_at', 'Starts'],
      ['source', 'Source'],
      ['collected_at', 'Collected']
    ),
    searchSql: ['t.term', 't.date_label', 't.title', 't.description'],
    orderBySql: 't.starts_at NULLS LAST, t.date_label, t.title',
    charted: true,
  },
  {
    key: 'campus-events',
    label: 'Campus events',
    group: 'Campus data',
    description: 'Upcoming campus events, organizers, times, and official links.',
    fromSql:
      'rockygpt_v2.campus_events t JOIN active_dataset a ON a.id = t.dataset_version_id JOIN rockygpt_v2.sources s ON s.id = t.source_id',
    selectSql:
      't.title, t.date_label, t.starts_at, t.start_time, t.end_time, t.organizer, t.description, t.event_url, s.title AS source',
    columns: columns(
      ['title', 'Event'],
      ['date_label', 'Date'],
      ['starts_at', 'Starts'],
      ['start_time', 'Start time'],
      ['end_time', 'End time'],
      ['organizer', 'Organizer'],
      ['description', 'Description'],
      ['event_url', 'URL'],
      ['source', 'Source']
    ),
    searchSql: ['t.title', 't.date_label', 't.organizer', 't.description'],
    orderBySql: 't.starts_at NULLS LAST, t.title',
    charted: true,
  },
  {
    key: 'clubs',
    label: 'Clubs',
    group: 'Campus data',
    description: 'Active student organizations and their categories and websites.',
    fromSql:
      'rockygpt_v2.clubs t JOIN active_dataset a ON a.id = t.dataset_version_id JOIN rockygpt_v2.sources s ON s.id = t.source_id',
    selectSql: 't.name, t.category, t.website_url, s.title AS source, t.collected_at',
    columns: columns(
      ['name', 'Club'],
      ['category', 'Category'],
      ['website_url', 'Website'],
      ['source', 'Source'],
      ['collected_at', 'Collected']
    ),
    searchSql: ['t.name', 't.category', 't.website_url'],
    orderBySql: 't.name',
    charted: true,
  },
  {
    key: 'programs',
    label: 'Programs',
    group: 'Campus data',
    description: 'Majors, minors, concentrations, degrees, and school groupings.',
    fromSql:
      'rockygpt_v2.programs t JOIN active_dataset a ON a.id = t.dataset_version_id JOIN rockygpt_v2.sources s ON s.id = t.source_id',
    selectSql:
      't.name, t.degree, t.program_kind, t.school, t.description, t.program_url, s.title AS source, t.collected_at',
    columns: columns(
      ['name', 'Program'],
      ['degree', 'Degree'],
      ['program_kind', 'Kind'],
      ['school', 'School'],
      ['description', 'Description'],
      ['program_url', 'URL'],
      ['source', 'Source'],
      ['collected_at', 'Collected']
    ),
    searchSql: ['t.name', 't.degree', 't.program_kind', 't.school', 't.description'],
    orderBySql: 't.name',
    charted: true,
  },
  {
    key: 'documents',
    label: 'Documents',
    group: 'Retrieval',
    description: 'Source documents prepared for lexical and semantic retrieval.',
    fromSql:
      'rockygpt_v2.documents t JOIN active_dataset a ON a.id = t.dataset_version_id JOIN rockygpt_v2.sources s ON s.id = t.source_id',
    selectSql:
      't.id, t.title, s.title AS source, LEFT(t.content, 600) AS content_preview, t.metadata, t.collected_at',
    columns: columns(
      ['id', 'ID'],
      ['title', 'Document'],
      ['source', 'Source'],
      ['content_preview', 'Content preview'],
      ['metadata', 'Metadata'],
      ['collected_at', 'Collected']
    ),
    searchSql: ['t.title', 't.content', 't.metadata::text', 's.title'],
    orderBySql: 't.title',
  },
  {
    key: 'document-chunks',
    label: 'Document chunks',
    group: 'Retrieval',
    description:
      'Searchable campus document sections and textual context chunks.',
    fromSql:
      'rockygpt_v2.document_chunks t JOIN rockygpt_v2.documents d ON d.id = t.document_id JOIN active_dataset a ON a.id = d.dataset_version_id',
    selectSql:
      't.id, d.title AS document, t.chunk_index, LEFT(t.content, 700) AS content_preview, t.content_hash, t.metadata',
    columns: columns(
      ['id', 'ID'],
      ['document', 'Document'],
      ['chunk_index', 'Chunk'],
      ['content_preview', 'Content preview'],
      ['content_hash', 'Content hash'],
      ['metadata', 'Metadata']
    ),
    searchSql: ['d.title', 't.content', 't.content_hash', 't.metadata::text'],
    orderBySql: 'd.title, t.chunk_index',
  },
  {
    key: 'sources',
    label: 'Sources',
    group: 'Releases',
    description: 'Configured source registry, trust tiers, freshness limits, and official URLs.',
    fromSql: 'rockygpt_v2.sources t',
    selectSql:
      't.source_key, t.title, t.domain, t.trust_tier, t.freshness_sla_hours, t.canonical_url',
    columns: columns(
      ['source_key', 'Key'],
      ['title', 'Source'],
      ['domain', 'Domain'],
      ['trust_tier', 'Trust tier'],
      ['freshness_sla_hours', 'Freshness hours'],
      ['canonical_url', 'Official URL']
    ),
    searchSql: ['t.source_key', 't.title', 't.domain', 't.trust_tier', 't.canonical_url'],
    orderBySql: 't.domain, t.title',
  },
  {
    key: 'dataset-versions',
    label: 'Dataset versions',
    group: 'Releases',
    description: 'All staged, active, retired, and failed dataset versions.',
    fromSql: 'rockygpt_v2.dataset_versions t',
    selectSql:
      't.id, t.version, t.status, t.created_at, t.activated_at, t.source_commit_sha, LEFT(t.quality_summary::text, 700) AS quality_summary_preview',
    columns: columns(
      ['id', 'ID'],
      ['version', 'Version'],
      ['status', 'Status'],
      ['created_at', 'Created'],
      ['activated_at', 'Activated'],
      ['source_commit_sha', 'Commit'],
      ['quality_summary_preview', 'Quality summary preview']
    ),
    searchSql: ['t.version', 't.status', 't.source_commit_sha'],
    orderBySql: 't.created_at DESC',
  },
  {
    key: 'releases',
    label: 'Releases',
    group: 'Releases',
    description: 'Release lineage and activation history.',
    fromSql: 'rockygpt_v2.releases t',
    selectSql:
      't.id, t.version, t.status, t.dataset_version_id, t.previous_release_id, t.created_at, t.activated_at, t.manifest_hash',
    columns: columns(
      ['id', 'ID'],
      ['version', 'Version'],
      ['status', 'Status'],
      ['dataset_version_id', 'Dataset ID'],
      ['previous_release_id', 'Previous release'],
      ['created_at', 'Created'],
      ['activated_at', 'Activated'],
      ['manifest_hash', 'Manifest hash']
    ),
    searchSql: ['t.version', 't.status', 't.manifest_hash'],
    orderBySql: 't.created_at DESC',
  },
  {
    key: 'ingestion-runs',
    label: 'Ingestion runs',
    group: 'Releases',
    description: 'Collector execution history, output counts, hashes, and errors.',
    fromSql: 'rockygpt_v2.ingestion_runs t JOIN rockygpt_v2.sources s ON s.id = t.source_id',
    selectSql:
      't.id, s.title AS source, t.status, t.started_at, t.completed_at, t.record_count, t.parser_version, t.raw_uri, t.output_hash, t.error_message',
    columns: columns(
      ['id', 'ID'],
      ['source', 'Source'],
      ['status', 'Status'],
      ['started_at', 'Started'],
      ['completed_at', 'Completed'],
      ['record_count', 'Records'],
      ['parser_version', 'Parser'],
      ['raw_uri', 'Raw URI'],
      ['output_hash', 'Output hash'],
      ['error_message', 'Error']
    ),
    searchSql: ['s.title', 't.status', 't.raw_uri', 't.output_hash', 't.error_message'],
    orderBySql: 't.started_at DESC',
  },
  {
    key: 'source-snapshots',
    label: 'Source snapshots',
    group: 'Releases',
    description: 'Content-addressed source snapshots referenced by releases.',
    fromSql: 'rockygpt_v2.source_snapshots t JOIN rockygpt_v2.sources s ON s.id = t.source_id',
    selectSql:
      't.id, s.title AS source, t.status, t.schema_version, t.collected_at, t.created_at, t.content_hash, t.ingestion_run_id',
    columns: columns(
      ['id', 'ID'],
      ['source', 'Source'],
      ['status', 'Status'],
      ['schema_version', 'Schema'],
      ['collected_at', 'Collected'],
      ['created_at', 'Created'],
      ['content_hash', 'Content hash'],
      ['ingestion_run_id', 'Ingestion run']
    ),
    searchSql: ['s.title', 't.status', 't.schema_version', 't.content_hash'],
    orderBySql: 't.collected_at DESC',
  },
  {
    key: 'source-runs',
    label: 'Active source runs',
    group: 'Releases',
    description: 'Per-source publication results for the active dataset.',
    fromSql: 'rockygpt_v2.source_runs t JOIN active_dataset a ON a.id = t.dataset_version_id',
    selectSql:
      't.id, t.source_key, t.status, t.started_at, t.completed_at, t.record_count, t.source_url, t.content_hash, t.error_message',
    columns: columns(
      ['id', 'ID'],
      ['source_key', 'Source'],
      ['status', 'Status'],
      ['started_at', 'Started'],
      ['completed_at', 'Completed'],
      ['record_count', 'Records'],
      ['source_url', 'URL'],
      ['content_hash', 'Content hash'],
      ['error_message', 'Error']
    ),
    searchSql: ['t.source_key', 't.status', 't.source_url', 't.content_hash', 't.error_message'],
    orderBySql: 't.started_at DESC',
  },
  {
    key: 'release-artifacts',
    label: 'Release artifacts',
    group: 'Releases',
    description: 'Browser-facing JSON projections attached to the active dataset.',
    fromSql: 'rockygpt_v2.release_artifacts t JOIN active_dataset a ON a.id = t.dataset_version_id',
    selectSql:
      't.artifact_key, pg_column_size(t.payload) AS payload_bytes, LEFT(t.payload::text, 700) AS payload_preview, t.content_hash, t.created_at',
    columns: columns(
      ['artifact_key', 'Artifact'],
      ['payload_bytes', 'Bytes'],
      ['payload_preview', 'Payload preview'],
      ['content_hash', 'Content hash'],
      ['created_at', 'Created']
    ),
    searchSql: ['t.artifact_key', 't.payload::text', 't.content_hash'],
    orderBySql: 't.artifact_key',
  },
] as const;

function toFiniteNumber(value: unknown, fallback = 0): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeValue(value: unknown): ExplorerValue {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'bigint') return value.toString();
  return JSON.stringify(value);
}

function normalizeRow(row: QueryResultRow): Record<string, ExplorerValue> {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [key, normalizeValue(value)])
  );
}

function datasetDefinition(key: string | undefined): DatasetDefinition {
  return DATASETS.find((dataset) => dataset.key === key) || DATASETS[0];
}

function normalizePage(page: number | undefined): number {
  if (!Number.isSafeInteger(page) || !page || page < 1) return 1;
  return Math.min(page, 10_000);
}

function normalizeSearch(search: string | undefined): string {
  return (search || '').trim().slice(0, MAX_SEARCH_LENGTH);
}

function recordFilterClause(
  definition: DatasetDefinition,
  search: string
): {
  sql: string;
  values: string[];
} {
  const clauses: string[] = [];
  const values: string[] = [];

  if (search) {
    values.push(`%${search}%`);
    clauses.push(
      `CONCAT_WS(' ', ${definition.searchSql.map((value) => `COALESCE(${value}, '')`).join(', ')}) ILIKE $${values.length}`
    );
  }

  return {
    sql: clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '',
    values,
  };
}

function normalizedSort(
  definition: DatasetDefinition,
  requestedSort: string | undefined,
  requestedDirection: string | undefined
): { key: string; direction: 'asc' | 'desc'; sql: string } {
  const defaultSort = definition.defaultSort;
  const key =
    requestedSort && definition.sortSql?.[requestedSort] ? requestedSort : defaultSort?.key || '';
  const direction =
    requestedDirection === 'asc' || requestedDirection === 'desc'
      ? requestedDirection
      : defaultSort?.direction || 'asc';
  const sortExpression = key ? definition.sortSql?.[key] : undefined;
  return {
    key,
    direction,
    sql: sortExpression
      ? `${sortExpression} ${direction.toUpperCase()} NULLS LAST, ${definition.orderBySql}`
      : definition.orderBySql,
  };
}

async function loadDatasetCounts(): Promise<Map<string, number>> {
  const pool = getRuntimePool();
  if (!pool) throw new Error('DATABASE_URL is not configured.');

  const countSql = DATASETS.map(
    (dataset) =>
      `SELECT '${dataset.key}' AS dataset_key, count(*)::integer AS record_count FROM ${dataset.fromSql}`
  ).join('\nUNION ALL\n');
  const result = await pool.query(`${ACTIVE_DATASET_CTE}${countSql}`);
  return new Map(
    result.rows.map((row) => [String(row.dataset_key), toFiniteNumber(row.record_count)])
  );
}

async function loadRecords(
  definition: DatasetDefinition,
  page: number,
  search: string,
  requestedSort: string | undefined,
  requestedDirection: string | undefined,
  filters: ExplorerRecords['filters']
): Promise<ExplorerRecords> {
  const pool = getRuntimePool();
  if (!pool) throw new Error('DATABASE_URL is not configured.');

  const filter = recordFilterClause(definition, search);
  const sort = normalizedSort(definition, requestedSort, requestedDirection);
  const offset = (page - 1) * PAGE_SIZE;
  const countValues = [...filter.values];
  const rowValues = [...filter.values, PAGE_SIZE, offset];
  const limitParameter = filter.values.length + 1;
  const offsetParameter = filter.values.length + 2;

  const [countResult, rowsResult] = await Promise.all([
    pool.query(
      `${ACTIVE_DATASET_CTE}
       SELECT count(*)::integer AS record_count
       FROM ${definition.fromSql}${filter.sql}`,
      countValues
    ),
    pool.query(
      `${ACTIVE_DATASET_CTE}
       SELECT ${definition.selectSql}
       FROM ${definition.fromSql}${filter.sql}
       ORDER BY ${sort.sql}
       LIMIT $${limitParameter} OFFSET $${offsetParameter}`,
      rowValues
    ),
  ]);

  return {
    datasetKey: definition.key,
    rows: rowsResult.rows.map(normalizeRow),
    total: toFiniteNumber(countResult.rows[0]?.record_count),
    page,
    pageSize: PAGE_SIZE,
    search,
    sort: sort.key,
    direction: sort.direction,
    filters,
  };
}

async function loadReleaseSummary(counts: Map<string, number>): Promise<ExplorerReleaseSummary> {
  const pool = getRuntimePool();
  if (!pool) throw new Error('DATABASE_URL is not configured.');

  const result = await pool.query<{
    version: string;
    status: string;
    activated_at: Date | null;
    quality_summary: unknown;
  }>(
    `SELECT version, status, activated_at, quality_summary
     FROM rockygpt_v2.dataset_versions
     WHERE status = 'active'
     LIMIT 1`
  );
  const active = result.rows[0];
  if (!active) throw new Error('No active RockyGPT dataset is available.');

  const quality =
    active.quality_summary && typeof active.quality_summary === 'object'
      ? (active.quality_summary as { sources?: unknown })
      : {};
  const sourceStatuses = new Map<string, number>();
  if (Array.isArray(quality.sources)) {
    for (const source of quality.sources) {
      if (!source || typeof source !== 'object' || !('status' in source)) continue;
      const status = String(source.status);
      sourceStatuses.set(status, (sourceStatuses.get(status) || 0) + 1);
    }
  }

  const structuredRecordCount = DATASETS.filter((dataset) => dataset.charted).reduce(
    (total, dataset) => total + (counts.get(dataset.key) || 0),
    0
  );

  return {
    version: active.version,
    status: active.status,
    activatedAt: active.activated_at?.toISOString() || null,
    sourceCount: counts.get('sources') || 0,
    structuredRecordCount,
    documentCount: counts.get('documents') || 0,
    chunkCount: counts.get('document-chunks') || 0,
    sourceStatuses: [...sourceStatuses.entries()]
      .map(([status, count]) => ({ status, count }))
      .sort((left, right) => right.count - left.count),
  };
}

export async function loadDataExplorer(input: {
  datasetKey?: string;
  page?: number;
  search?: string;
  sort?: string;
  direction?: string;
  status?: string;
  topic?: string;
  route?: string;
  dateFrom?: string;
  dateTo?: string;
  origins?: string;
}): Promise<DataExplorerPayload> {
  if (process.env.NODE_ENV !== 'development') {
    throw new Error('The data explorer is only available in development.');
  }

  const definition = datasetDefinition(input.datasetKey);
  const page = normalizePage(input.page);
  const search = normalizeSearch(input.search);
  const filters: ExplorerRecords['filters'] = {
    status: '',
    topic: '',
    route: '',
    dateFrom: '',
    dateTo: '',
    origins: [],
  };
  const [counts, records] = await Promise.all([
    loadDatasetCounts(),
    loadRecords(definition, page, search, input.sort, input.direction, filters),
  ]);
  const release = await loadReleaseSummary(counts);

  const datasets: ExplorerDataset[] = DATASETS.map((dataset) => ({
    key: dataset.key,
    label: dataset.label,
    group: dataset.group,
    description: dataset.description,
    columns: dataset.columns,
    count: counts.get(dataset.key) || 0,
  }));

  return {
    generatedAt: new Date().toISOString(),
    datasets,
    records,
    filterOptions: { topics: [], routes: [] },
    release,
  };
}
