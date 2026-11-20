/**
 * Karibu (Briq) instant SMS - the single outbound SMS gateway for the whole platform.
 * POST {baseUrl}/v1/message/send-instant
 * Docs: https://docs.briq.tz/api-reference/karibu-messages/send-instant-message
 *
 * Every send is recorded in `sms_logs` (best effort). One-time codes are redacted before logging.
 */
const config = require('../config/env');
const ApiError = require('../utils/ApiError');
const { normalizePhone, logPhone } = require('../utils/phone');

const RETRY_DELAY_MS = 600;

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

function isConfigured() {
  return Boolean(String(config.briq?.apiKey || '').trim());
}

/** GSM-7 vs Unicode segment estimate (160/153 vs 70/67 chars). */
function smsInfo(text) {
  const value = String(text || '');
  const gsm = /^[A-Za-z0-9 \r\n@£$¥èéùìòÇØøÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ!"#¤%&'()*+,\-./:;<=>?¡ÄÖÑÜ§¿äöñüà^{}\\[~\]|€]*$/.test(value);
  const length = value.length;
  const single = gsm ? 160 : 70;
  const multi = gsm ? 153 : 67;
  const segments = length === 0 ? 0 : length <= single ? 1 : Math.ceil(length / multi);
  return { length, encoding: gsm ? 'GSM-7' : 'Unicode', segments };
}

/** Never persist a one-time code. */
function redact(text, category) {
  const value = String(text || '');
  if (category === 'otp') return value.replace(/\d{4,8}/g, '••••••').slice(0, 160);
  return value.slice(0, 160);
}

async function logSms(entry) {
  try {
    const db = require('../config/db');
    await db.query(
      `INSERT INTO sms_logs(user_id,recipient,category,template,segments,status,provider_job_id,error,body_preview,created_by)
       VALUES(?,?,?,?,?,?,?,?,?,?)`,
      [
        entry.userId || null, entry.recipient, entry.category || 'system', entry.template || null,
        entry.segments || 1, entry.status, entry.jobId || null,
        entry.error ? String(entry.error).slice(0, 250) : null,
        entry.preview || null, entry.createdBy || null
      ]
    );
  } catch (_) { /* logging must never break delivery */ }
}

async function post(url, headers, payload) {
  const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload) });
  let body = null;
  try { body = await response.json(); } catch (_) { body = null; }
  return { response, body };
}

/**
 * Send one SMS to one or more numbers.
 * @param {{ to: string|string[], content: string, senderId?: string, category?: string,
 *           template?: string, userId?: number, createdBy?: number }} input
 */
async function sendSms({ to, content, senderId, category = 'system', template, userId, createdBy } = {}) {
  const apiKey = String(config.briq?.apiKey || '').trim();
  if (!apiKey) throw ApiError.badRequest('SMS is not configured. Set BRIQ_API_KEY.');

  const text = String(content || '').trim();
  if (!text) throw ApiError.badRequest('Message content is required.');

  const recipients = [...new Set((Array.isArray(to) ? to : [to]).map(toBriqNumber).filter(Boolean))];
  if (!recipients.length) throw ApiError.badRequest('A valid phone number is required.');

  const sender = String(senderId || config.briq.senderId || 'SOSHO').trim();
  if (!sender) throw ApiError.badRequest('SMS sender name is not configured.');

  const headers = { 'Content-Type': 'application/json', 'X-API-Key': apiKey };
  if (config.briq.appId) headers['X-App-ID'] = config.briq.appId;

  const url = `${config.briq.baseUrl}/v1/message/send-instant`;
  const payload = { content: text, recipients, sender_id: sender };
  const info = smsInfo(text);
  const logBase = { userId, category, template, segments: info.segments, createdBy, preview: redact(text, category) };
  const logAll = (extra) => Promise.all(recipients.map((r) => logSms({ ...logBase, recipient: `+${r}`, ...extra })));

  let result;
  try {
    result = await post(url, headers, payload);
    // One quick retry for transient provider failures only.
    if (result.response.status >= 500) {
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
      result = await post(url, headers, payload);
    }
  } catch (err) {
    try {
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
      result = await post(url, headers, payload);
    } catch (err2) {
      console.warn('[sms] Briq request failed', err2.message);
      await logAll({ status: 'failed', error: 'provider unreachable' });
      throw new ApiError(502, 'SMS provider is unavailable. Try again shortly.');
    }
  }

  const { response, body } = result;
  if (!response.ok || body?.success === false) {
    console.warn(`[sms] Briq ${response.status} to=${recipients.map((r) => logPhone(r)).join(',')} request_id=${body?.request_id || ''}`);
    await logAll({ status: 'failed', error: providerMessage(body) });
    if (response.status === 429) throw ApiError.tooMany('SMS provider rate limit reached. Try again shortly.');
    if (response.status === 400 || response.status === 422) throw ApiError.badRequest(providerMessage(body));
    throw new ApiError(502, 'SMS provider rejected the message.');
  }

  await logAll({ status: 'sent', jobId: body?.job_id || null });
  return {
    jobId: body?.job_id || null,
    status: body?.status || 'sent',
    message: body?.message || '',
    stats: body?.stats || null,
    senderId: sender,
    recipients,
    segments: info.segments
  };
}

module.exports = { sendSms, smsInfo, isConfigured, logSms };
