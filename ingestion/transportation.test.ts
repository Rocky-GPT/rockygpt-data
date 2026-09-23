import assert from 'node:assert/strict';
import test from 'node:test';
import { parseShuttleTable, parseTransportationSchedules } from './transportation-schedule';
import { generateTransportationMarkdown } from './generate-transportation-md';
import type { RawDatasetV1 } from './raw-types';

test('timetable columns retain both outbound and return visits to the same stop', () => {
  const trips = parseShuttleTable({ headers: ['Leave Ramapo', 'Ramsey Rt 17 Train', 'Interstate Plaza', 'Ramsey Rt 17 Train', 'Arrive on Campus', 'Train Arrives from NYC'], rows: [['9:00 AM', '9:10 AM', '9:15 AM', '9:25 AM', '9:35 AM', '9:00 AM']] });
  assert.deepEqual(trips[0], { departure: '9:00 AM', stops: [{ location: 'Ramsey Rt 17 Train', time: '9:10 AM' }, { location: 'Interstate Plaza', time: '9:15 AM' }, { location: 'Ramsey Rt 17 Train', time: '9:25 AM' }], arrival: '9:35 AM' });
});

test('clock formatting is normalized but malformed times fail instead of being published', () => {
  const table = { headers: ['Leave Ramapo', 'Arrive Ramsey Rt 17 Train', 'Depart Ramsey Rt 17 Train', 'Arrive on Campus'], rows: [['7: 25 AM', '7:35 AM', '7:35 AM', '7:45AM-'], ['5:30 PM', '5:40 PM', 'N/A', 'N/A']] };
  assert.equal(parseShuttleTable(table)[0].departure, '7:25 AM');
  assert.equal(parseShuttleTable(table)[0].arrival, '7:45 AM');
  assert.equal(parseShuttleTable(table)[1].arrival, 'N/A');
  table.rows[0][0] = '25:99 AM';
  assert.throws(() => parseShuttleTable(table), /Unsupported published shuttle time/);
});

test('captured schedules parse completely and generated headings use the source period', () => {
  const dataset: RawDatasetV1 = {
    version: '1.0', dataset: 'transportation', collectedAt: '2026-09-23T00:00:00Z', seedUrls: [],
    stats: { pagesFetched: 4, pagesFailed: 0, externalLinksSeen: 0 },
    pages: ['ramapo-roadrunner-express-shuttle', 'saturday-shuttle-schedule', 'sunday-shuttle-schedule', 'shuttle-mid-day-weekday-express-train-schedule'].map(slug => ({
      url: `https://www.ramapo.edu/about/transportation-services/${slug}/`, title: 'Fall 2026 Shuttle Schedule',
      sourceType: 'detail', fetchedAt: '2026-09-23T00:00:00Z', statusCode: 200,
      links: [], externalLinks: [], sections: [], lists: [], contacts: [], documents: [],
      tables: [{ headers: ['Leave Ramapo', 'Ramsey Rt 17 Train', 'Arrive on Campus'], rows: [['9:00 AM', '9:10 AM', '9:30 AM']] }],
    })),
  };
  const schedules = parseTransportationSchedules(dataset);
  assert.equal(schedules.length, 4);
  const saturday = schedules.find(route => route.serviceDay === 'saturday')!;
  assert.deepEqual(saturday.trips[0].stops[0], { location: 'Ramsey Rt 17 Train', time: '9:10 AM' });
  const markdown = generateTransportationMarkdown(dataset, '2026-09-23T00:00:00Z');
  assert.match(markdown, /Saturday Campus Departures \(Fall 2026\)/);
  assert.doesNotMatch(markdown, /Spring 2026/);
  assert.throws(() => parseTransportationSchedules({ ...dataset, pages: [] }), /Missing successful source capture/);
});

test('missing source pages do not manufacture periods, stops, service notes, or contact facts', () => {
  const dataset: RawDatasetV1 = { version: '1.0', dataset: 'transportation', collectedAt: '2026-09-23T00:00:00Z', seedUrls: [], stats: { pagesFetched: 0, pagesFailed: 0, externalLinksSeen: 0 }, pages: [] };
  const markdown = generateTransportationMarkdown(dataset, dataset.collectedAt);
  assert.doesNotMatch(markdown, /Spring 2026|Bradley Center|Garden State Plaza|RCNJShuttle|Commuter Affairs email/);
  assert.match(markdown, /departures are not available/);
});
