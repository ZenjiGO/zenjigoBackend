const test = require('node:test');
const assert = require('node:assert/strict');
const { stub, fresh, fakeDb } = require('./helpers');

function load(handlers) {
  const sent = [];
  const db = fakeDb(handlers);
  stub('config/db.js', db);
  stub('services/otp.service.js', {
    send: async (input) => {
      sent.push(input);
      return { sid: 'sid-1', channel: input.channel };
    },
    verify: async () => true,
  });
  stub('utils/jwt.js', {
    signAccess: () => 'access',
    issueRefreshToken: async () => 'refresh',
  });
  stub('services/welcome-email.service.js', {
    sendWelcomeEmail: async () => {},
  });
  return { auth: fresh('services/auth.service.js'), sent, db };
}

test('rider phone login sends SMS only when that phone has an account', async () => {
  const { auth, sent } = load([
    [/role="rider" AND phone/, () => [{ id: 4 }]],
  ]);
  const result = await auth.sendOtp({ phone: '0712345678', role: 'rider', purpose: 'login' });
  assert.equal(result.channel, 'sms');
  assert.equal(result.target, '+255712345678');
  assert.equal(sent[0].channel, 'sms');
  assert.equal(sent[0].target, '+255712345678');
});

test('rider email login sends email only when that email has an account', async () => {
  const { auth, sent } = load([
    [/role="rider" AND email/, () => [{ id: 4 }]],
  ]);
  const result = await auth.sendOtp({ email: 'rider@example.com', role: 'rider', purpose: 'login' });
  assert.equal(result.channel, 'email');
  assert.equal(sent[0].channel, 'email');
  assert.equal(sent[0].target, 'rider@example.com');
});

test('rider login rejects a phone or email with no account before sending', async () => {
  const phone = load([[/role="rider" AND phone/, () => []]]);
  await assert.rejects(
    () => phone.auth.sendOtp({ phone: '0712345678', role: 'rider' }),
    /No rider account uses this phone number/
  );
  assert.equal(phone.sent.length, 0);

  const email = load([[/role="rider" AND email/, () => []]]);
  await assert.rejects(
    () => email.auth.sendOtp({ email: 'missing@example.com', role: 'rider' }),
    /No rider account uses this email/
  );
  assert.equal(email.sent.length, 0);
});

test('signup with phone and email still sends the code by SMS', async () => {
  const { auth, sent } = load([]);
  const result = await auth.sendOtp({
    phone: '0712345678',
    email: 'new@example.com',
    role: 'rider',
  });
  assert.equal(result.channel, 'sms');
  assert.equal(sent[0].target, '+255712345678');
});
