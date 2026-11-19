const test = require('node:test');
const assert = require('node:assert/strict');
const { stub, fresh } = require('./helpers');

function load(briq) {
  stub('config/env.js', {
    briq: {
      apiKey: 'test-key',
      appId: '',
      baseUrl: 'https://karibu.briq.tz',
      senderId: 'SOSHO',
      ...briq
    }
  });
  return fresh('services/sms.service.js');
}

test('sendSms posts an instant message with sender SOSHO', async () => {
  const sms = load();
  const calls = [];
  const original = global.fetch;
  global.fetch = async (url, opts) => {
    calls.push({ url, opts });
    return {
      ok: true,
      status: 200,
      json: async () => ({ success: true, job_id: 'job-1', status: 'sent', message: 'queued', stats: { recipients: 1 }, meta: {} })
    };
  };
  try {
    const result = await sms.sendSms({ to: '0712345678', content: 'Hello from ZenjiGO' });
    assert.equal(result.jobId, 'job-1');
    assert.equal(result.senderId, 'SOSHO');
    assert.deepEqual(result.recipients, ['255712345678']);
    assert.equal(calls[0].url, 'https://karibu.briq.tz/v1/message/send-instant');
    assert.equal(calls[0].opts.headers['X-API-Key'], 'test-key');
    assert.equal(JSON.parse(calls[0].opts.body).sender_id, 'SOSHO');
  } finally {
    global.fetch = original;
  }
});

test('sendSms fails closed when the API key is missing', async () => {
  const sms = load({ apiKey: '' });
  await assert.rejects(sms.sendSms({ to: '0712345678', content: 'Hello' }), /BRIQ_API_KEY/);
});

test('sendSms surfaces Briq validation errors and does not retry', async () => {
  const sms = load();
  let hits = 0;
  const original = global.fetch;
  global.fetch = async () => {
    hits += 1;
    return {
      ok: false,
      status: 422,
      json: async () => ({
        success: false,
        data: null,
        errors: [{ code: 'VALIDATION_FAILED', message: 'Field required', field: 'sender_id' }],
        request_id: 'req-1'
      })
    };
  };
  try {
    await assert.rejects(sms.sendSms({ to: '+255712345678', content: 'Hello' }), /sender_id: Field required/);
    assert.equal(hits, 1);
  } finally {
    global.fetch = original;
  }
});
