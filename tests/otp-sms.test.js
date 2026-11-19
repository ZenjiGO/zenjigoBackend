const test = require('node:test');
const assert = require('node:assert/strict');
const { stub, fresh, fakeDb } = require('./helpers');

test('SMS OTP is sent to the phone and stored as channel sms', async () => {
  const sent = [];
  const db = fakeDb([
    [/SELECT id, last_sent_at/, () => []],
    [/COUNT\(\*\)/, () => [{ c: 0 }]],
    [/UPDATE otp_verifications SET status="cancelled"/, () => ({ affectedRows: 0 })],
    [/INSERT INTO otp_verifications/, () => ({ insertId: 9 })],
  ]);
  stub('config/env.js', {
    nodeEnv: 'test',
    appName: 'ZenjiGO',
    security: { otpResendSeconds: 30, otpMaxAttempts: 5 },
    smtp: {},
  });
  stub('config/db.js', db);
  stub('services/sms.service.js', {
    sendSms: async (input) => {
      sent.push(input);
      return { jobId: 'job-9' };
    },
  });
  const otp = fresh('services/otp.service.js');
  const result = await otp.send({ target: '0712345678', purpose: 'login', channel: 'sms' });
  assert.equal(result.channel, 'sms');
  assert.equal(result.sid, 'job-9');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, '+255712345678');
  assert.match(sent[0].content, /ZenjiGO verification code: \d{6}/);
  const insert = db.calls.find((call) => call.sql.includes('INSERT INTO otp_verifications'));
  assert.equal(insert.params[0], '+255712345678');
  assert.equal(insert.params[1], 'sms');
  assert.equal(insert.params[2], 'login');
});
