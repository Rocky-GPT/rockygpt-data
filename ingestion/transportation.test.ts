import assert from 'node:assert/strict';
import test from 'node:test';
import { parseShuttleTable, parseSpecialSchedules, parseTransportationSchedules } from './transportation-schedule';
import { generateTransportationMarkdown } from './generate-transportation-md';
import type { RawDatasetV1 } from './raw-types';

test('timetable columns retain both outbound and return visits to the same stop', () => {
  const trips = parseShuttleTable({ headers: ['Leave Ramapo', 'Ramsey Rt 17 Train', 'Interstate Plaza', 'Ramsey Rt 17 Train', 'Arrive on Campus', 'Train Arrives from NYC'], rows: [['9:00 AM', '9:10 AM', '9:15 AM', '9:25 AM', '9:35 AM', '9:00 AM']] });
  assert.deepEqual(trips[0], { departure: '9:00 AM', stops: [{ location: 'Ramsey Rt 17 Train', time: '9:10 AM' }, { location: 'Interstate Plaza', time: '9:15 AM' }, { location: 'Ramsey Rt 17 Train', time: '9:25 AM' }], arrival: '9:35 AM',
    trains: { arrives_from_nyc: ['9:00 AM'], leaves_for_nyc: [] } });
});

test('clock formatting is normalized but malformed times fail instead of being published', () => {
  const table = { headers: ['Leave Ramapo', 'Arrive Ramsey Rt 17 Train', 'Depart Ramsey Rt 17 Train', 'Arrive on Campus'], rows: [['7: 25 AM', '7:35 AM', '7:35 AM', '7:45AM-'], ['5:30 PM', '5:40 PM', 'N/A', 'N/A']] };
  assert.equal(parseShuttleTable(table)[0].departure, '7:25 AM');
  assert.equal(parseShuttleTable(table)[0].arrival, '7:45 AM');
  assert.equal(parseShuttleTable(table)[1].arrival, 'N/A');
  // The mid-day table's Arrive/Depart columns are two visits to one stop.
  assert.deepEqual(parseShuttleTable(table)[0].stops, [{ location: 'Ramsey Rt 17 Train', time: '7:35 AM' }, { location: 'Ramsey Rt 17 Train', time: '7:35 AM' }]);
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

test('each stop has one spelling across routes and the mid-day timetable is named as its page is', () => {
  const header = (slug: string) => slug === 'saturday-shuttle-schedule' ? 'CITY MD Ramsey' : 'City MD Ramsey';
  const dataset: RawDatasetV1 = {
    version: '1.0', dataset: 'transportation', collectedAt: '2026-09-23T00:00:00Z', seedUrls: [],
    stats: { pagesFetched: 4, pagesFailed: 0, externalLinksSeen: 0 },
    pages: ['ramapo-roadrunner-express-shuttle', 'saturday-shuttle-schedule', 'sunday-shuttle-schedule', 'shuttle-mid-day-weekday-express-train-schedule'].map(slug => ({
      url: `https://www.ramapo.edu/about/transportation-services/${slug}/`, title: 'Fall 2026 Shuttle Schedule',
      sourceType: 'detail', fetchedAt: '2026-09-23T00:00:00Z', statusCode: 200,
      links: [], externalLinks: [], sections: [], lists: [], contacts: [], documents: [],
      // Saturday's page has more trips than the others: the spelling most pages use still wins.
      tables: [{ headers: ['Leave Ramapo', header(slug), 'Arrive on Campus'], rows: slug === 'saturday-shuttle-schedule'
        ? [['9:00 AM', '9:10 AM', '9:30 AM'], ['10:00 AM', '10:10 AM', '10:30 AM'], ['11:00 AM', '11:10 AM', '11:30 AM']]
        : [['9:00 AM', '9:10 AM', '9:30 AM']] }],
    })),
  };
  const schedules = parseTransportationSchedules(dataset);
  assert.deepEqual(new Set(schedules.flatMap(route => route.trips.flatMap(trip => trip.stops.map(stop => stop.location)))), new Set(['City MD Ramsey']));
  assert.ok(schedules.some(route => route.name === 'Mid-Day Weekday Express Train'));
});

test('a row keeps the NJ Transit trains it lists beside the trip', () => {
  const trips = parseShuttleTable({ headers: ['Leave Ramapo', 'Ramsey Rt 17 Train', 'Arrive on Campus', 'Train Arrives from NYC', 'Train Leaves for NYC'],
    rows: [['6:10 PM', '6:20 PM', '7:35 PM', '6:44 PM 7:07 PM 7:14 PM', '6:31 PM'], ['8:25 AM', '–', '9:25 AM', 'See express', 'See express'],
      ['9:00 AM', '9:10 AM', '9:30 AM', '–', '–']] });
  assert.deepEqual(trips[0].trains, { arrives_from_nyc: ['6:44 PM', '7:07 PM', '7:14 PM'], leaves_for_nyc: ['6:31 PM'] });
  assert.deepEqual(trips[1].trains, { arrives_from_nyc: [], leaves_for_nyc: [], see_express: true });
  assert.deepEqual(trips[2].trains, { arrives_from_nyc: [], leaves_for_nyc: [] });
  assert.throws(() => parseShuttleTable({ headers: ['Leave Ramapo', 'Arrive on Campus', 'Train Arrives from NYC'], rows: [['9:00 AM', '9:30 AM', 'soon']] }), /Unsupported published train time/);
});

test('a special-schedule table is its own timetable, named by its heading and never a regular day', () => {
  const special = (tables: RawDatasetV1['pages'][number]['tables'], sections: RawDatasetV1['pages'][number]['sections']): RawDatasetV1 => ({
    version: '1.0', dataset: 'transportation', collectedAt: '2026-10-14T00:00:00Z', seedUrls: [],
    stats: { pagesFetched: 1, pagesFailed: 0, externalLinksSeen: 0 },
    pages: [{ url: 'https://www.ramapo.edu/about/transportation-services/special-shuttle-schedule/', title: 'Special Shuttle Schedule Labor Day 9/7',
      sourceType: 'detail', fetchedAt: '2026-10-14T00:00:00Z', statusCode: 200, links: [], externalLinks: [], lists: [], contacts: [], documents: [],
      tables, sections }],
  });
  const table = { headers: ['Leave Ramapo', 'Ramsey Rt 17 Train', 'Arrive on Campus'], rows: [['9:00 AM', '9:10 AM', '9:40 AM']] };
  const [route] = parseSpecialSchedules(special([table], [{ heading: 'Follow Ramapo', text: 'Facebook' },
    { heading: 'September 7th (Labor Day)', text: 'Leave Ramapo | Ramsey Rt 17 Train | Arrive on Campus; 9:00 AM | 9:10 AM | 9:40 AM' }]));
  assert.equal(route.name, 'Special Shuttle Schedule: September 7th (Labor Day)');
  assert.equal(route.serviceDay, 'special');
  assert.equal(route.trips[0].departure, '9:00 AM');
  assert.deepEqual(parseSpecialSchedules(special([], [])), []);
  assert.throws(() => parseSpecialSchedules(special([table], [])), /exactly one heading/);
});
