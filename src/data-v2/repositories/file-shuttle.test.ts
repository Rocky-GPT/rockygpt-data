import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { FileRepositoryV2 } from './file-repository';
import { setRepositoryV2ForTests } from './index';
import { getShuttle } from '../../../api/routes/shuttle';
import type { ShuttleResponse } from '../../../api/contract';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rocky-source-shuttle-'));
  const capturedAt = '2026-09-22T12:00:00Z';
  const pages = ['ramapo-roadrunner-express-shuttle', 'saturday-shuttle-schedule', 'sunday-shuttle-schedule', 'shuttle-mid-day-weekday-express-train-schedule'].map(slug => ({
    url: `https://www.ramapo.edu/about/transportation-services/${slug}/`, sourceType: 'detail', fetchedAt: capturedAt,
    statusCode: 200, title: 'Fall 2026 Shuttle Schedule', links: [], externalLinks: [], lists: [], sections: [], contacts: [], documents: [],
    tables: [{ headers: ['Leave Ramapo', 'Arrive Ramsey Rt 17 Train', 'Depart Ramsey Rt 17 Train', 'Arrive on Campus'],
      rows: [['6:10 AM', '6:20 AM', '6:25 AM', '6:35 AM']] }],
  }));
  fs.mkdirSync(path.join(root, 'data/normalized'), { recursive: true });
  fs.writeFileSync(path.join(root, 'data/normalized/transportation.json'), JSON.stringify({ version: '1.0', dataset: 'transportation', collectedAt: capturedAt, seedUrls: [], stats: { pagesFetched: 4, pagesFailed: 0, externalLinksSeen: 0 }, pages }));
  return { root, capturedAt, repository: new FileRepositoryV2(root) };
}

test('file shuttle reads and exact facts use captured rows, stop columns, URLs, and timestamps', async () => {
  const { root, repository, capturedAt } = fixture();
  try {
    const saturday = await repository.listShuttleTrips('saturday');
    assert.equal(saturday[0].departure, '6:10 AM');
    assert.equal(saturday[0].stops.length, 2);
    assert.equal(saturday[0].source.collectedAt, capturedAt);
    assert.match(saturday[0].source.url, /saturday-shuttle-schedule/);
    assert.equal((await repository.getShuttleTrips('Ramsey Route 17', 'sunday')).length, 0);
    const first = await repository.getCriticalFact('shuttle.ramsey_route17.express.first_departure');
    const last = await repository.getCriticalFact('shuttle.ramsey_route17.express.last_dropoff');
    assert.equal(first?.value, '6:10 AM');
    assert.equal(last?.value, '6:20 AM');
    assert.equal(first?.verifiedAt, capturedAt);
    fs.unlinkSync(path.join(root, 'data/normalized/transportation.json'));
    await assert.rejects(repository.listShuttleTrips('weekday'), /ENOENT/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('legacy shuttle endpoint reads the repository and leaves unsupported Shortline timetables empty', async () => {
  const { root, repository } = fixture();
  setRepositoryV2ForTests(repository);
  try {
    const result = await getShuttle({ method: 'GET', url: new URL('http://localhost/v1/shuttle'), headers: new Headers(), signal: new AbortController().signal });
    assert.equal(result.status, 200);
    const body = result.body as ShuttleResponse;
    assert.equal(body.weekday[0].departure, '6:10 AM');
    assert.equal(body.trainLoop[0].departure, '6:10 AM');
    assert.deepEqual(body.shortline.toNYC, { weekday: [], saturday: [], sunday: [] });
    assert.deepEqual(body.shortline.fromNYC, { weekday: [], saturday: [], sunday: [] });
  } finally { setRepositoryV2ForTests(null); fs.rmSync(root, { recursive: true, force: true }); }
});
