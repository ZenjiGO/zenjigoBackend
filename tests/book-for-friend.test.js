const test = require('node:test');
const assert = require('node:assert/strict');
const { stub, fresh, fakeDb } = require('./helpers');

function load(handlers = []) {
  const db = fakeDb(handlers);
  stub('config/db.js', db);
  return { db, mod: fresh('services/ride.passenger.js') };
}
const rider = { full_name: 'Amina Juma', phone: '+255712000111' };

test('a normal ride has no passenger data', () => {
  const { mod } = load();
  assert.deepEqual(mod.parsePassenger({ rideType: 'boda' }, rider), { bookedForOther: false, name: null, phone: null, note: null });
});

test('a friend booking is normalised (phone to E.164, text cleaned)', () => {
  const { mod } = load();
  const p = mod.parsePassenger({ bookedForOther: true, passengerName: '  Neema \n Said  ', passengerPhone: '0755 123 456', passengerNote: 'Blue\tgate' }, rider);
  assert.equal(p.bookedForOther, true);
  assert.equal(p.name, 'Neema Said');
  assert.equal(p.phone, '+255755123456');
  assert.equal(p.note, 'Blue gate');
});

test('friend booking needs a name and a valid phone', () => {
  const { mod } = load();
  assert.throws(() => mod.parsePassenger({ bookedForOther: true, passengerPhone: '0755123456' }, rider), (e) => e.statusCode === 400 && e.details.code === 'PASSENGER_NAME');
  assert.throws(() => mod.parsePassenger({ bookedForOther: true, passengerName: 'Neema' }, rider), (e) => e.details.code === 'PASSENGER_PHONE');
  assert.throws(() => mod.parsePassenger({ bookedForOther: true, passengerName: 'Neema', passengerPhone: '12' }, rider), (e) => e.details.code === 'PASSENGER_PHONE');
  assert.throws(() => mod.parsePassenger({ bookedForOther: true, passengerName: '1234', passengerPhone: '0755123456' }, rider), (e) => e.details.code === 'PASSENGER_NAME');
});

test('you cannot book a "friend" ride for your own number', () => {
  const { mod } = load();
  assert.throws(() => mod.parsePassenger({ bookedForOther: true, passengerName: 'Me', passengerPhone: '0712 000 111' }, rider), (e) => e.details.code === 'PASSENGER_IS_SELF');
});

test('string flags from form clients are honoured', () => {
  const { mod } = load();
  assert.equal(mod.parsePassenger({ bookedForOther: 'true', passengerName: 'Neema', passengerPhone: '0755123456' }, rider).bookedForOther, true);
  assert.equal(mod.parsePassenger({ bookedForOther: 'false', passengerName: 'Neema', passengerPhone: '0755123456' }, rider).bookedForOther, false);
});

test('rate limits stop SMS spam to one number and mass booking', async () => {
  const p = { bookedForOther: true, name: 'Neema', phone: '+255755123456' };
  let { mod } = load([[/passenger_phone=\?/, () => [{ c: 3 }]]]);
  await assert.rejects(mod.assertWithinLimits(1, p), (e) => e.statusCode === 429 && e.details.code === 'PASSENGER_RATE');
  ({ mod } = load([[/passenger_phone=\?/, () => [{ c: 0 }]], [/booked_for_other=1/, () => [{ c: 99 }]]]));
  await assert.rejects(mod.assertWithinLimits(1, p), (e) => e.details.code === 'PASSENGER_DAILY');
  ({ mod } = load([[/COUNT/, () => [{ c: 0 }]]]));
  await mod.assertWithinLimits(1, p);
  await mod.assertWithinLimits(1, { bookedForOther: false });
});

test('toPublic hides the block for normal rides', () => {
  const { mod } = load();
  assert.equal(mod.toPublic({ booked_for_other: 0 }), null);
  assert.deepEqual(mod.toPublic({ booked_for_other: 1, passenger_name: 'N', passenger_phone: '+255', passenger_note: null }), { name: 'N', phone: '+255', note: null });
});

test('passenger SMS templates never leak the PIN into the wrong message', () => {
  const ev = fresh('services/sms.events.js');
  const accepted = ev.TEMPLATES.ride_accepted_passenger.text({ driver: 'Juma', plate: 'T123ABC', pin: '4821', booker: 'Amina' });
  assert.match(accepted, /Amina/); assert.match(accepted, /4821/);
  assert.doesNotMatch(ev.TEMPLATES.ride_booked_for_you.text({ booker: 'Amina', pickup: 'Stone Town' }), /\d{4}/);
  assert.match(ev.TEMPLATES.ride_cancelled_passenger.text({ booker: 'Amina', code: 'ZG1' }), /cancelled/);
});
