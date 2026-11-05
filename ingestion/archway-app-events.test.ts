import assert from 'node:assert/strict';
import test from 'node:test';

import { appEventFacts, appEventUrl, appOnlyEvents, placeFromApp, ticketStatusFromApp, withAppFacts, type AppEvent } from './archway-app-events';

const id = (n: number) => Buffer.from(`ramapo:Event:${n}`).toString('base64');
const priced = (...amounts: Array<number | [number, boolean]>): AppEvent => ({
  registration: { options: amounts.map((entry) => {
    const [amount, isFlexible] = Array.isArray(entry) ? entry : [entry, false];
    return { price: { amount, currency: 'USD', isFlexible } };
  }) },
});

test("the app's id names the same event as the calendar file's address", () => {
  assert.equal(id(1411567), 'cmFtYXBvOkV2ZW50OjE0MTE1Njc=');
  assert.equal(appEventUrl(id(1411567)), 'https://archway.ramapo.edu/rsvp_boot?id=1411567');
  assert.equal(appEventUrl(Buffer.from('ramapo:Group:34209').toString('base64')), undefined);
  assert.equal(appEventUrl(undefined), undefined);
});

test('the ticket line reads like the app\'s own event card, in dollars', () => {
  assert.equal(ticketStatusFromApp(priced(0)), 'FREE');
  assert.equal(ticketStatusFromApp(priced(0, 0)), 'FREE');
  assert.equal(ticketStatusFromApp(priced(5)), '$5');
  assert.equal(ticketStatusFromApp(priced(10, 5)), '$5 - $10');
  assert.equal(ticketStatusFromApp(priced(5.5)), '$5.50');
  assert.equal(ticketStatusFromApp(priced(0, 15)), '$0 - $15');
  assert.equal(ticketStatusFromApp({}), undefined, 'no option, no price');
  assert.equal(ticketStatusFromApp(priced([0, true])), undefined, 'a donation is not FREE');
  assert.equal(ticketStatusFromApp({ registration: { ...priced(0).registration, paidOptionsWithheldReason: 'NOT_SIGNED_IN' } }), undefined,
    'paid options held back: FREE could be wrong');
  assert.equal(ticketStatusFromApp({ registration: { options: [{ price: { amount: 5, currency: 'EUR' } }] } }), undefined);
});

test('the place is the name the app gives a reader who is not signed in', () => {
  assert.equal(placeFromApp({ location: { kind: 'ON_CAMPUS', name: 'Mackin First floor lounge ' } }), 'Mackin First floor lounge');
  assert.equal(placeFromApp({ location: { kind: 'ON_CAMPUS', name: null } }), undefined);
  assert.equal(placeFromApp({ location: { kind: 'ON_CAMPUS', name: 'Room 1', isToBeDetermined: true } }), undefined);
  assert.equal(placeFromApp({ location: { kind: 'ON_CAMPUS', name: 'CPA Lodge Main Lobby', eventLocationPrivacy: 'REGISTERED_ONLY' } }),
    'CPA Lodge Main Lobby', 'a name the app gives a signed-out reader is shown to everyone');
  assert.equal(placeFromApp({ location: { kind: 'ON_CAMPUS', name: null, eventLocationPrivacy: 'REGISTERED_ONLY' } }), undefined);
});

test("the app's facts go onto the calendar files' events; a file's own place is kept", () => {
  const facts = appEventFacts([
    { id: id(1), ...priced(0), location: { name: 'Friends Hall & Lounge', kind: 'ON_CAMPUS' } },
    { id: id(2), ...priced(5, 10) },
  ]);
  const events = withAppFacts([
    { title: 'One', date: 'Friday, November 20 2026', location: 'Friends Hall and Lounge', url: 'https://archway.ramapo.edu/rsvp_boot?id=1' },
    { title: 'Two', date: 'Friday, November 20 2026', location: 'Sharp Theater', url: 'https://archway.ramapo.edu/rsvp_boot?id=2' },
    { title: 'Three', date: 'Friday, November 20 2026', url: 'https://archway.ramapo.edu/rsvp_boot?id=3' },
    { title: 'Four', date: 'Friday, November 20 2026', url: 'https://archway.ramapo.edu/rsvp_boot?id=4' },
  ], new Map([...facts, ['https://archway.ramapo.edu/rsvp_boot?id=4', { location: 'Pavilion' }]]));
  assert.deepEqual(events.map((event) => [event.ticketStatus, event.location]), [
    ['FREE', 'Friends Hall and Lounge'], ['$5 - $10', 'Sharp Theater'], [undefined, undefined], [undefined, 'Pavilion'],
  ]);
});

test("the app's events no calendar file lists are added, shaped like the files' events", () => {
  const listed = { title: 'Listed', date: 'Thu, Nov 5, 2026', url: 'https://archway.ramapo.edu/rsvp_boot?id=1' };
  const added = appOnlyEvents([
    { id: id(1), name: 'Listed', startDate: '2026-11-05T18:00:00Z', status: 'APPROVED' },
    { id: id(3), name: ' Late  show ', startDate: '2026-11-07T01:00:00Z', endDate: '2026-11-07T03:30:00Z', status: 'APPROVED',
      hostGroup: { name: 'Resident Hall Association ' }, descriptionText: 'Free pizza!<br>Bring a friend.',
      location: { kind: 'ON_CAMPUS', name: 'Pavilion' }, ...priced(0) },
    { id: id(2), name: 'DONUT STRESS', startDate: '2026-11-05T18:00:00Z', endDate: '2026-11-05T19:00:00Z', status: 'APPROVED' },
    { id: id(4), name: 'Waiting', startDate: '2026-11-08T18:00:00Z', status: 'PENDING' },
    { id: id(5), name: 'Request form', startDate: '2026-11-08T18:00:00Z', status: 'APPROVED',
      descriptionText: 'Organization: Hillel<br>Event Name: Kosher Sushi Night' },
    { id: id(6), name: '', startDate: '2026-11-08T18:00:00Z', status: 'APPROVED' },
  ], [listed]);
  assert.deepEqual(added, [
    { title: 'DONUT STRESS', date: 'Thu, Nov 5, 2026', time: '1 PM', endTime: '2 PM', url: 'https://archway.ramapo.edu/rsvp_boot?id=2' },
    { title: 'Late show', date: 'Fri, Nov 6, 2026', time: '8 PM', endTime: '10:30 PM', organizer: 'Resident Hall Association',
      location: 'Pavilion', description: 'Free pizza! Bring a friend.', url: 'https://archway.ramapo.edu/rsvp_boot?id=3', ticketStatus: 'FREE' },
    { title: 'Request form', date: 'Sun, Nov 8, 2026', time: '1 PM', url: 'https://archway.ramapo.edu/rsvp_boot?id=5' },
  ]);
});
