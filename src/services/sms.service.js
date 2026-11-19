/**
 * Karibu (Briq) instant SMS.
 * POST {baseUrl}/v1/message/send-instant
 * Docs: https://docs.briq.tz/api-reference/karibu-messages/send-instant-message
 */
const config = require('../config/env');
const ApiError = require('../utils/ApiError');
const { normalizePhone } = require('../utils/phone');

function toBriqNumber(phone) {
  const digits = normalizePhone(phone).replace(/^\+/, '');
  return /^\d{9,15}$/.test(digits) ? digits : '';
}

function providerMessage(body) {
  if (Array.isArray(body?.errors) && body.errors.length) {
    return body.errors
      .map((item) => (item.field ? `${item.field}: ${item.message}` : item.message))
      .filter(Boolean)
      .join('; ');
  }
  if (body?.detail?.message) return String(body.detail.message);
  if (body?.message) return String(body.message);
  return 'SMS provider rejected the message.';
}

/**
 * Send one SMS to one or more Tanzanian numbers.
 * @param {{ to: string|string[], content: string, senderId?: string }} input
 */
async function sendSms({ to, content, senderId } = {}) {
  const apiKey = String(config.briq.apiKey || '').trim();
  if (!apiKey) throw ApiError.badRequest('SMS is not configured. Set BRIQ_API_KEY.');

  const text = String(content || '').trim();
  if (!text) throw ApiError.badRequest('Message content is required.');

  const recipients = [...new Set((Array.isArray(to) ? to : [to]).map(toBriqNumber).filter(Boolean))];
  if (!recipients.length) throw ApiError.badRequest('A valid phone number is required.');

  const sender = String(senderId || config.briq.senderId || 'SOSHO').trim();
  if (!sender) throw ApiError.badRequest('SMS sender name is not configured.');

  const headers = {
    'Content-Type': 'application/json',
    'X-API-Key': apiKey
  };
  if (config.briq.appId) headers['X-App-ID'] = config.briq.appId;

  const url = `${config.briq.baseUrl}/v1/message/send-instant`;
  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ content: text, recipients, sender_id: sender })
    });
  } catch (err) {
    console.warn('[sms] Briq request failed', err.message);
    throw new ApiError(502, 'SMS provider is unavailable. Try again shortly.');
  }

  let body = null;
  try { body = await response.json(); } catch (_) { body = null; }

  if (!response.ok || body?.success === false) {
    console.warn(`[sms] Briq ${response.status} request_id=${body?.request_id || ''}`);
    if (response.status === 429) throw ApiError.tooMany('SMS provider rate limit reached. Try again shortly.');
    if (response.status === 400 || response.status === 422) throw ApiError.badRequest(providerMessage(body));
    throw new ApiError(502, 'SMS provider rejected the message.');
  }

  return {
    jobId: body?.job_id || null,
    status: body?.status || 'sent',
    message: body?.message || '',
    stats: body?.stats || null,
    senderId: sender,
    recipients
  };
}

module.exports = { sendSms };
