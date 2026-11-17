import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeOpeningHours } from './opening-hours';

test('canonical intervals preserve split hours and explicit next-day midnight', () => {
  assert.deepEqual(normalizeOpeningHours('9:00am-5:00pm'), [{ open: '09:00', close: '17:00' }]);
  assert.deepEqual(normalizeOpeningHours('8:00am-9:30am and 11:30am-12:30pm'), [
    { open: '08:00', close: '09:30' }, { open: '11:30', close: '12:30' },
  ]);
  assert.deepEqual(normalizeOpeningHours('8:00am-12:00am'), [{ open: '08:00', close: '00:00', close_day_offset: 1 }]);
  assert.deepEqual(normalizeOpeningHours('22:00–02:00'), [{ open: '22:00', close: '02:00', close_day_offset: 1 }]);
  assert.deepEqual(normalizeOpeningHours('noon to 5pm'), [{ open: '12:00', close: '17:00' }]);
});

test('only an explicit complete closure becomes an empty array', () => {
  assert.deepEqual(normalizeOpeningHours(' CLOSED '), []);
  for (const value of [null, undefined, '', 'Unknown', 'Closed until 10am', '9am-5pm and unknown', '9am-5pm;', '9am-5pm except holidays', '13am-5pm', '9:61am-5pm', '25:00-26:00', '8am-8am', '9am-1pm and noon-5pm', '9-5']) {
    assert.equal(normalizeOpeningHours(value), null, String(value));
  }
});
