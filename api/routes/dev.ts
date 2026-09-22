/**
 * @module api/routes/dev
 * Endpoints behind the development-only pages: collector status and the data
 * explorer.
 *
 * They read further into the database than anything else here, so they answer
 * 404 outside development — the same guard the pages themselves applied when
 * this logic lived inside the web app.
 */

import { getScrapeSourceStatuses, STATIC_DATA_NOT_SCRAPED } from '../../src/data-v2/scrape-status';
import { loadDataExplorer } from '../../src/data-explorer/server';
import { fail, ok, type ApiHandler } from '../http';
import { parseIsoDate, validateQueryLengths } from '../query';

// Matches the guard inside the data explorer itself. A looser check here let a
// request through that the module below then refused, turning a clear 404 into
// an unavailable-service error.
const isDevelopment = () => process.env.NODE_ENV === 'development';

const notInDevelopment = () =>
  fail(404, 'NOT_FOUND', 'This endpoint is only available in development.');

/** Freshness of every collector, for the data-sources page. */
export const getScrapeStatus: ApiHandler = () => {
  if (!isDevelopment()) return notInDevelopment();
  return ok({ sources: getScrapeSourceStatuses(), staticDataNotScraped: STATIC_DATA_NOT_SCRAPED });
};

/** The data explorer's payload: campus tables, rows, and release metadata. */
export const getDataExplorer: ApiHandler = async (request) => {
  if (!isDevelopment()) return notInDevelopment();
  const invalidLength = validateQueryLengths(request, {
    dataset: 80,
    page: 8,
    search: 120,
    sort: 80,
    direction: 4,
    status: 40,
    topic: 80,
    route: 120,
    dateFrom: 10,
    dateTo: 10,
    origins: 400,
  });
  if (invalidLength) return invalidLength;

  const params = request.url.searchParams;
  const pageText = params.get('page');
  const page = pageText ? Number(pageText) : undefined;
  if (page !== undefined && (!Number.isInteger(page) || page < 1 || page > 10_000)) {
    return fail(400, 'INVALID_REQUEST', '`page` must be an integer from 1 to 10000.');
  }
  for (const name of ['dateFrom', 'dateTo'] as const) {
    const date = params.get(name);
    if (date && !parseIsoDate(date)) {
      return fail(400, 'INVALID_REQUEST', `\`${name}\` must be a real YYYY-MM-DD date.`);
    }
  }
  const direction = params.get('direction');
  if (direction && direction !== 'asc' && direction !== 'desc') {
    return fail(400, 'INVALID_REQUEST', '`direction` must be asc or desc.');
  }
  const text = (name: string) => params.get(name) || undefined;
  return ok(
    await loadDataExplorer({
      datasetKey: text('dataset'),
      page,
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
