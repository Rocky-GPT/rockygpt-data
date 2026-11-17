import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { FileRepositoryV2 } from './file-repository';

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
    assert.ok(saturday[0].stops.every(stop => stop.location === 'Ramsey Rt 17 Train'));
    const first = await repository.getCriticalFact('shuttle.ramsey_route17.express.first_departure');
    const last = await repository.getCriticalFact('shuttle.ramsey_route17.express.last_dropoff');
    assert.equal(first?.value, '6:10 AM');
    assert.equal(last?.value, '6:20 AM');
    assert.equal(first?.verifiedAt, capturedAt);
    fs.unlinkSync(path.join(root, 'data/normalized/transportation.json'));
    await assert.rejects(repository.listShuttleTrips('weekday'), /ENOENT/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
