import assert from 'node:assert/strict';
import test from 'node:test';

import { appEventFacts, appEventUrl, placeFromApp, ticketStatusFromApp, withAppFacts, type AppEvent } from './archway-app-events';

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

test('the place is the name the app shows everyone', () => {
  assert.equal(placeFromApp({ location: { kind: 'ON_CAMPUS', name: 'Mackin First floor lounge ' } }), 'Mackin First floor lounge');
  assert.equal(placeFromApp({ location: { kind: 'ON_CAMPUS', name: null } }), undefined);
  assert.equal(placeFromApp({ location: { kind: 'ON_CAMPUS', name: 'Room 1', isToBeDetermined: true } }), undefined);
  assert.equal(placeFromApp({ location: { kind: 'ON_CAMPUS', name: 'Room 1', eventLocationPrivacy: 'REGISTERED_ONLY' } }), undefined);
});

test("the app's facts go onto the calendar files' events; the app's place wins", () => {
  const facts = appEventFacts([
    { id: id(1), ...priced(0), location: { name: 'Friends Hall & Lounge', kind: 'ON_CAMPUS' } },
    { id: id(2), ...priced(5, 10) },
  ]);
  const events = withAppFacts([
    { title: 'One', date: 'Friday, November 20 2026', location: 'Friends Hall and Lounge', url: 'https://archway.ramapo.edu/rsvp_boot?id=1' },
    { title: 'Two', date: 'Friday, November 20 2026', location: 'Sharp Theater', url: 'https://archway.ramapo.edu/rsvp_boot?id=2' },
    { title: 'Three', date: 'Friday, November 20 2026', url: 'https://archway.ramapo.edu/rsvp_boot?id=3' },
  ], facts);
  assert.deepEqual(events.map((event) => [event.ticketStatus, event.location]), [
    ['FREE', 'Friends Hall & Lounge'], ['$5 - $10', 'Sharp Theater'], [undefined, undefined],
  ]);
});
