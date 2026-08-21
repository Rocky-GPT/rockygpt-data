/**
 * @module api/routes/dev
 * Endpoints behind the development-only pages: the entity registry, collector
 * status, and the data explorer.
 *
 * They read further into the database than anything else here, so they answer
 * 404 outside development — the same guard the pages themselves applied when
 * this logic lived inside the web app.
 */

import { buildEntityRegistry } from '../../src/data-v2/entity-registry';
import { getScrapeSourceStatuses, STATIC_DATA_NOT_SCRAPED } from '../../src/data-v2/scrape-status';
import { loadDataExplorer } from '../../src/data-explorer/server';
import { getRuntimePool } from '../../src/db/runtime-pool';
import { fail, ok, type ApiHandler } from '../http';

// Matches the guard inside the data explorer itself. A looser check here let a
// request through that the module below then refused, turning a clear 404 into
// an unavailable-service error.
const isDevelopment = () => process.env.NODE_ENV === 'development';

const notInDevelopment = () =>
  fail(404, 'NOT_FOUND', 'This endpoint is only available in development.');

/** Every entity in the active dataset, by its stable record key. */
export const getEntityRegistry: ApiHandler = async () => {
  if (!isDevelopment()) return notInDevelopment();

  const pool = getRuntimePool();
  if (!pool) {
    return fail(503, 'UNAVAILABLE', 'DATABASE_URL is not configured, so there is no active dataset to read.', true);
  }

  const active = await pool.query<{ id: string; version: string }>(
    `SELECT id::text, version FROM rockygpt_v2.dataset_versions WHERE status = 'active' LIMIT 1`
  );
  const dataset = active.rows[0];
  if (!dataset) return fail(503, 'UNAVAILABLE', 'No active dataset version.', true);

  return ok(await buildEntityRegistry(pool, dataset.id, dataset.version));
};

/** Freshness of every collector, for the data-sources page. */
export const getScrapeStatus: ApiHandler = () => {
  if (!isDevelopment()) return notInDevelopment();
  return ok({ sources: getScrapeSourceStatuses(), staticDataNotScraped: STATIC_DATA_NOT_SCRAPED });
};

/** The data explorer's payload: tables, rows, and query analytics. */
export const getDataExplorer: ApiHandler = async (request) => {
  if (!isDevelopment()) return notInDevelopment();
  const params = request.url.searchParams;
  const text = (name: string) => params.get(name) || undefined;
  return ok(
    await loadDataExplorer({
      datasetKey: text('dataset'),
      page: params.get('page') ? Number(params.get('page')) : undefined,
      search: text('search'),
      sort: text('sort'),
      direction: text('direction'),
      status: text('status'),
      topic: text('topic'),
      route: text('route'),
      dateFrom: text('dateFrom'),
      dateTo: text('dateTo'),
      origins: text('origins'),
    })
  );
};
