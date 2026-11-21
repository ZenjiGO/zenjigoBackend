const test = require('node:test');
const assert = require('node:assert/strict');
const { stub, fresh } = require('./helpers');

stub('config/db.js', { query: async () => [] });
const radar = fresh('services/driver.demand.service.js');

test('Tanzania time is UTC+3 and weekday kinds are right', () => {
  assert.equal(radar.localParts(new Date('2026-11-23T04:30:00Z')).hour, 7); // Monday morning
  assert.deepEqual(radar.dayTypeDows(1), [2, 3, 4, 5, 6]);
  assert.deepEqual(radar.dayTypeDows(0), [1, 7]);
  assert.deepEqual(radar.hourWindow(0), [23, 0, 1]);
  assert.equal(radar.localParts(new Date('2026-11-21T22:00:00Z')).dow, 0); // 01:00 Sunday local
});

test('periods give a sensible headline', () => {
  assert.equal(radar.periodFor(7, 1).label, 'Morning commute');
  assert.equal(radar.periodFor(18, 3).label, 'Evening rush');
  assert.equal(radar.periodFor(18, 6).label, 'Evening out');
  assert.equal(radar.periodFor(2, 2).key, 'late_night');
});

test('no data, or a lone request, highlights nothing', () => {
  assert.deepEqual(radar.scoreZones({}), { zones: [], best: null });
  const r = radar.scoreZones({ live: [{ cy: 100, cx: 200, w: 1, n: 1, searching: 0 }] });
  assert.equal(r.zones.length, 0);
});

test('busy cells score high and are smoothed into neighbours', () => {
  const r = radar.scoreZones({
    history: [{ cy: 100, cx: 200, w: 14 }, { cy: 100, cx: 201, w: 4 }],
    live: [{ cy: 100, cx: 200, w: 9, n: 5, searching: 3 }],
    center: { lat: 100.5 * radar.CELL_DEG, lng: 200.5 * radar.CELL_DEG }
  });
  assert.ok(r.zones.length >= 3, 'neighbours are included');
  const top = r.zones[0];
  assert.equal(top.level, 'peak');
  assert.equal(top.intensity, 1);
  assert.equal(top.waiting, 3);
  assert.ok(r.zones.every((z, i, a) => i === 0 || a[i - 1].intensity >= z.intensity), 'sorted');
  assert.equal(r.best.distanceKm, 0);
});

test('drivers already in a cell lower its score (point drivers to under-served riders)', () => {
  const base = { history: [{ cy: 10, cx: 10, w: 12 }, { cy: 10, cx: 30, w: 12 }] };
  const crowded = radar.scoreZones({ ...base, supply: [{ cy: 10, cx: 10, drivers: 6 }] });
  const a = crowded.zones.find((z) => Math.abs(z.lng - 10.5 * radar.CELL_DEG) < 1e-6);
  const b = crowded.zones.find((z) => Math.abs(z.lng - 30.5 * radar.CELL_DEG) < 1e-6);
  assert.ok(!a || a.intensity < b.intensity);
});

test('best prefers a nearby warm cell over a far hot one', () => {
  const r = radar.scoreZones({
    history: [{ cy: 0, cx: 0, w: 20 }, { cy: 0, cx: 4000, w: 24 }],
    center: { lat: 0.0025, lng: 0.0025 }
  });
  assert.ok(r.best.distanceKm < 1);
});

test('rejects a missing location', async () => {
  await assert.rejects(radar.demandZones({ lat: undefined, lng: undefined }), (e) => e.statusCode === 400);
});

test('otp: the Android hash is in the SMS together with the WebOTP line, per app', () => {
  process.env.OTP_ANDROID_APP_HASH_RIDER = 'G/QxhA2iBzY';
  process.env.OTP_ANDROID_APP_HASH_DRIVER = 'vRpfu8+FvhZ';
  process.env.OTP_WEBOTP_DOMAIN = 'zenjigo.online';
  stub('config/env.js', { nodeEnv: 'test', appName: 'ZenjiGO', security: {}, smtp: {} });
  stub('services/sms.service.js', { sendSms: async () => ({}) });
  const otp = fresh('services/otp.service.js');
  const rider = otp.autofillParts('123456', 'rider');
  assert.equal(rider.prefix, '<#> ');
  assert.match(rider.suffix, /G\/QxhA2iBzY/);
  assert.doesNotMatch(rider.suffix, /vRpfu8/);
  assert.match(rider.suffix, /@zenjigo\.online #123456$/); // WebOTP line must be last
  assert.match(otp.autofillParts('1', 'driver').suffix, /vRpfu8\+FvhZ/);
  assert.deepEqual(otp.autofillParts('1', 'admin'), { prefix: '', suffix: '' });
  delete process.env.OTP_ANDROID_APP_HASH_RIDER; delete process.env.OTP_ANDROID_APP_HASH_DRIVER;
  process.env.OTP_ANDROID_APP_HASH = 'G/QxhA2iBzY,vRpfu8+FvhZ,bad';
  assert.deepEqual(otp.androidHashesFor('rider'), ['G/QxhA2iBzY', 'vRpfu8+FvhZ']);
  delete process.env.OTP_ANDROID_APP_HASH; delete process.env.OTP_WEBOTP_DOMAIN;
});
