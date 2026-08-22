import assert from 'node:assert/strict';
import test from 'node:test';
import type { ApiRequest } from '../http';
import {
  getDataExplorer,
  getEntityRegistry,
  getEntityRows,
  getScrapeStatus,
} from './dev';

function request(path: string): ApiRequest {
  return {
    method: 'GET',
    url: new URL(path, 'http://local.test'),
    headers: new Headers(),
    signal: new AbortController().signal,
  };
}

test('development data inspectors return 404 in production', async () => {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    const responses = await Promise.all([
      getEntityRegistry(request('/v1/dev/entity-registry')),
      getEntityRows(request('/v1/dev/entity-rows?kind=clubs&key=test')),
      getScrapeStatus(request('/v1/dev/scrape-status')),
      getDataExplorer(request('/v1/dev/data-explorer')),
    ]);
    assert.deepEqual(responses.map((response) => response.status), [404, 404, 404, 404]);
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  }
});
