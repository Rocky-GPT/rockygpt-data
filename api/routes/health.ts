/**
 * @module api/routes/health
 * Liveness and readiness.
 *
 * Liveness says the process is up. Readiness says it can actually serve campus
 * data — the database is reachable and a dataset is active — within a bounded
 * budget, so a probe cannot hang on a slow connection. Responses name failure
 * categories only, never connection or error detail.
 */

import { getRepositoryV2 } from '../../src/data-v2/repositories/index';
import { ok, type ApiHandler } from '../http';
import type { ServiceHealth, ServiceReadiness } from '../contract';

const startedAt = Date.now();
const PROBE_TIMEOUT_MS = 3_000;

export const getHealth: ApiHandler = () =>
  ok({
    status: 'healthy',
    service: 'rockygpt-data',
    uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
  } satisfies ServiceHealth);

function bounded<T>(work: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    work,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('probe timeout')), PROBE_TIMEOUT_MS);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

export const getReadiness: ApiHandler = async () => {
  const failing: Array<'database' | 'dataset'> = [];
  try {
    await bounded(getRepositoryV2().getDatasetContext());
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    failing.push(/no active dataset/i.test(message) ? 'dataset' : 'database');
  }

  if (failing.length) {
    return {
      status: 503,
      body: {
        status: 'unready',
        failing,
        timestamp: new Date().toISOString(),
      } satisfies ServiceReadiness,
    };
  }
  return ok({
    status: 'ready',
    timestamp: new Date().toISOString(),
  } satisfies ServiceReadiness);
};
