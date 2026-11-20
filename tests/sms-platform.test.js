const test = require('node:test');
const assert = require('node:assert/strict');
const { stub, fresh, fakeDb } = require('./helpers');
const phone = require('../src/utils/phone');

test('phone normalisation accepts local, national and international input', () => {
  for (const v of ['0712345678', '712345678', '255712345678', '+255 712 345 678', '00255712345678']) {
    assert.equal(phone.normalizePhone(v), '+255712345678');
  }
  assert.equal(phone.normalizePhone('+254712345678'), '+254712345678');
  assert.ok(phone.isTzMobile('0655123456'));
  assert.ok(!phone.isTzMobile('+254712345678'));
  assert.ok(!phone.isValidPhone('123'));
  assert.ok(!phone.maskPhone('+255712345678').includes('71234'));
});

function loadAuth(handlers) {
  const sent = [];
  const db = fakeDb(handlers);
  stub('config/db.js', db);
  stub('services/otp.service.js', {
    send: async (i) => { sent.push(i); return { sid: 's', channel: i.channel }; },
    verify: async () => true,
  });
  stub('utils/jwt.js', { signAccess: () => 'a', issueRefreshToken: async () => 'r' });
  stub('services/welcome-email.service.js', { sendWelcomeEmail: async () => {} });
  stub('services/sms.events.js', { later: () => {}, sendToUser: async () => true, sendToPhone: async () => true });
  return { auth: fresh('services/auth.service.js'), sent, db };
}

test('rider signup rejects a phone or email that is already registered', async () => {
  const a = loadAuth([[/role="rider" AND phone/, () => [{ id: 1 }]]]);
  await assert.rejects(() => a.auth.sendOtp({ phone: '0712345678', email: 'x@y.com', role: 'rider' }), /already registered/);
  assert.equal(a.sent.length, 0);
  const b = loadAuth([[/role="rider" AND email/, () => [{ id: 1 }]]]);
  await assert.rejects(() => b.auth.sendOtp({ phone: '0712345678', email: 'x@y.com', role: 'rider' }), /already registered/);
});

test('rider signup sends the code by SMS with the signup purpose', async () => {
  const { auth, sent } = loadAuth([]);
  const r = await auth.sendOtp({ phone: '0712345678', email: 'new@y.com', role: 'rider' });
  assert.equal(r.channel, 'sms');
  assert.equal(sent[0].purpose, 'signup');
});

test('driver can request a login code by SMS; unknown numbers get the same answer without a send', async () => {
  const known = loadAuth([[/role="driver" AND phone/, () => [{ id: 7 }]]]);
  const r1 = await known.auth.sendOtp({ phone: '0712345678', role: 'driver', purpose: 'login' });
  assert.equal(r1.channel, 'sms');
  assert.equal(known.sent[0].target, '+255712345678');
  const unknown = loadAuth([[/role="driver" AND phone/, () => []]]);
  const r2 = await unknown.auth.sendOtp({ phone: '0712345678', role: 'driver', purpose: 'login' });
  assert.equal(r2.channel, 'sms');
  assert.equal(unknown.sent.length, 0);
});

test('driver registration phone code refuses a number that already has a driver account', async () => {
  const a = loadAuth([[/role="driver" AND phone/, () => [{ id: 3 }]]]);
  await assert.rejects(() => a.auth.sendDriverPhoneOtp({ phone: '0712345678' }), /already uses this phone/);
  const b = loadAuth([]);
  const r = await b.auth.sendDriverPhoneOtp({ phone: '0712345678' });
  assert.equal(b.sent[0].purpose, 'driver_registration_phone');
  assert.equal(r.channel, 'sms');
});

test('phone change refuses the current number and numbers used by another account', async () => {
  const same = loadAuth([[/SELECT phone FROM users/, () => [{ phone: '+255712345678' }]]]);
  await assert.rejects(() => same.auth.sendPhoneChangeOtp({ userId: 1, role: 'rider', phone: '0712345678' }), /already your phone/);
  const taken = loadAuth([
    [/SELECT phone FROM users/, () => [{ phone: '+255700000009' }]],
    [/AND phone=\? AND id<>\?/, () => [{ id: 2 }]],
  ]);
  await assert.rejects(() => taken.auth.sendPhoneChangeOtp({ userId: 1, role: 'rider', phone: '0712345678' }), /already used/);
});

test('event SMS honours the admin switch and never throws', async () => {
  const calls = [];
  stub('services/sms.service.js', { isConfigured: () => true, sendSms: async (i) => { calls.push(i); return {}; } });
  stub('config/db.js', fakeDb([
    [/FROM app_settings/, () => [{ setting_value: { ride_arrived: false } }]],
    [/FROM users WHERE id/, () => [{ id: 5, phone: '+255712345678', status: 'active' }]],
  ]));
  const ev = fresh('services/sms.events.js');
  ev.clearSettingsCache();
  assert.equal(await ev.sendToUser(5, 'ride_arrived', { pin: '1234' }), false);
  assert.equal(await ev.sendToUser(5, 'ride_accepted', { driver: 'Ali', plate: 'Z 123', pin: '4821' }), true);
  assert.match(calls[0].content, /Ali \(Z 123\) is on the way\. Trip PIN: 4821/);
  assert.equal(calls[0].category, 'ride');
  assert.equal(await ev.sendToUser(5, 'nonexistent'), false);
});
