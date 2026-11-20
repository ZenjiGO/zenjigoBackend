/**
 * Admin SMS Center: gateway status, delivery log, test message, targeted/broadcast SMS and
 * per-event switches for transactional SMS.
 */
const db = require('../config/db');
const config = require('../config/env');
const ApiError = require('../utils/ApiError');
const { ok } = require('../utils/response');
const asyncHandler = require('../utils/asyncHandler');
const { sendSms, smsInfo, isConfigured } = require('../services/sms.service');
const events = require('../services/sms.events');
const { normalizePhone, isValidPhone, maskPhone } = require('../utils/phone');

const EVENT_LABELS = {
  ride_accepted: 'Driver accepted ride (with trip PIN)',
  ride_arrived: 'Driver arrived at pickup',
  ride_cancelled: 'Ride cancelled',
  ride_no_driver: 'No driver available',
  ride_completed: 'Trip receipt',
  driver_status: 'Driver application approved / rejected / suspended',
  payout_status: 'Payout and commission-due updates',
  wallet_topup: 'Wallet top-up received',
  welcome: 'Welcome messages',
  security: 'Security alerts (phone changed)',
  parcel_tour: 'Parcel and tour booking confirmations'
};

function audit(adminId, action, entityId, meta) {
  return db.query(
    'INSERT INTO admin_audit_logs(admin_id,action,entity_type,entity_id,details) VALUES(?,?,?,?,?)',
    [adminId, action, 'sms', entityId || null, meta ? JSON.stringify(meta) : null]
  ).catch(() => {});
}

exports.overview = asyncHandler(async (_req, res) => {
  const rows = await db.query(
    `SELECT status, category, COUNT(*) n, COALESCE(SUM(segments),0) segs,
            SUM(created_at >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 DAY)) d1,
            SUM(created_at >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 7 DAY)) d7
       FROM sms_logs WHERE created_at >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 30 DAY)
      GROUP BY status, category`
  ).catch(() => []);
  const totals = { sent30: 0, failed30: 0, sent7: 0, failed7: 0, sent1: 0, failed1: 0, segments30: 0 };
  const byCategory = {};
  for (const r of rows) {
    const key = r.status === 'sent' ? 'sent' : r.status === 'failed' ? 'failed' : null;
    if (key) {
      totals[`${key}30`] += Number(r.n); totals[`${key}7`] += Number(r.d7 || 0); totals[`${key}1`] += Number(r.d1 || 0);
      if (key === 'sent') totals.segments30 += Number(r.segs);
    }
    byCategory[r.category] = (byCategory[r.category] || 0) + Number(r.n);
  }
  const settings = await events.eventSettings();
  ok(res, {
    configured: isConfigured(),
    senderId: config.briq.senderId,
    provider: 'Briq Karibu',
    notificationsEnabled: events.enabledGlobally(),
    broadcastMax: config.sms.broadcastMax,
    totals, byCategory,
    events: Object.keys(EVENT_LABELS).map((key) => ({ key, label: EVENT_LABELS[key], enabled: settings[key] !== false }))
  });
});

exports.logs = asyncHandler(async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(100, Math.max(5, Number(req.query.limit) || 25));
  const where = []; const vals = [];
  if (['sent', 'failed', 'skipped'].includes(req.query.status)) { where.push('l.status=?'); vals.push(req.query.status); }
  if (req.query.category) { where.push('l.category=?'); vals.push(String(req.query.category)); }
  if (req.query.q) {
    const q = String(req.query.q).trim();
    where.push('(l.recipient LIKE ? OR u.full_name LIKE ? OR l.template LIKE ?)');
    vals.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }
  const cond = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = (await db.query(`SELECT COUNT(*) n FROM sms_logs l LEFT JOIN users u ON u.id=l.user_id ${cond}`, vals))[0]?.n || 0;
  const items = await db.query(
    `SELECT l.id, l.recipient, l.category, l.template, l.segments, l.status, l.error, l.body_preview preview,
            l.provider_job_id jobId, l.created_at createdAt, u.full_name userName, u.role userRole
       FROM sms_logs l LEFT JOIN users u ON u.id=l.user_id ${cond}
      ORDER BY l.id DESC LIMIT ? OFFSET ?`, [...vals, limit, (page - 1) * limit]);
  ok(res, { items, total: Number(total), page, limit });
});

exports.test = asyncHandler(async (req, res) => {
  const phone = normalizePhone(req.body.phone);
  if (!isValidPhone(phone)) throw ApiError.badRequest('Enter a valid phone number.');
  const r = await sendSms({
    to: phone, content: `${config.appName} SMS test from the admin console. Delivery is working.`,
    category: 'admin', template: 'admin_test', createdBy: req.user.sub
  });
  await audit(req.user.sub, 'sms_test', null, { to: maskPhone(phone) });
  ok(res, { jobId: r.jobId, to: maskPhone(phone), senderId: r.senderId }, 'Test SMS sent');
});

exports.preview = asyncHandler(async (req, res) => {
  const message = String(req.body.message || '');
  const ids = await resolveRecipients(req.body, true);
  ok(res, { ...smsInfo(message), recipients: ids.length, estimatedSegments: ids.length * smsInfo(message).segments });
});

async function resolveRecipients(b, countOnly = false) {
  const marketing = b.marketing !== false; // broadcasts honour opt-out by default
  const optIn = marketing ? ' AND u.sms_opt_in=1' : '';
  const base = `SELECT u.id, u.phone FROM users u WHERE u.phone IS NOT NULL AND u.phone<>'' AND u.status='active'${optIn}`;
  let rows = [];
  switch (b.audience) {
    case 'user': {
      rows = await db.query('SELECT id, phone FROM users WHERE id=? AND phone IS NOT NULL', [Number(b.userId)]);
      if (!rows.length) throw ApiError.notFound('Recipient not found or has no phone number.');
      break;
    }
    case 'phones': {
      const list = [...new Set((Array.isArray(b.phones) ? b.phones : String(b.phones || '').split(/[\s,;]+/)).map(normalizePhone).filter(isValidPhone))];
      rows = list.map((phone) => ({ id: null, phone }));
      break;
    }
    case 'all_riders': rows = await db.query(`${base} AND u.role='rider'`); break;
    case 'all_drivers': rows = await db.query(`${base} AND u.role='driver'`); break;
    case 'online_drivers':
      rows = await db.query(`${base} AND u.role='driver' AND EXISTS(SELECT 1 FROM driver_profiles d WHERE d.user_id=u.id AND d.online=1)`);
      break;
    default: throw ApiError.badRequest('Choose a valid audience.');
  }
  return rows.filter((r) => isValidPhone(r.phone));
}

exports.send = asyncHandler(async (req, res) => {
  const message = String(req.body.message || '').trim();
  if (!message) throw ApiError.badRequest('Message is required.');
  if (message.length > 480) throw ApiError.badRequest('Message must be 480 characters or fewer (3 segments).');
  if (!isConfigured()) throw ApiError.badRequest('SMS is not configured. Set BRIQ_API_KEY on the server.');
  const recipients = await resolveRecipients(req.body);
  if (!recipients.length) throw ApiError.badRequest('No recipients match this audience.');
  if (recipients.length > config.sms.broadcastMax) {
    throw ApiError.badRequest(`Audience too large (${recipients.length}). Limit is ${config.sms.broadcastMax} per send.`);
  }
  const category = req.body.audience === 'user' || req.body.audience === 'phones' ? 'admin' : 'marketing';
  let sent = 0; let failed = 0; let lastError = '';
  // Briq accepts many recipients per request; send in batches of 100.
  for (let i = 0; i < recipients.length; i += 100) {
    const batch = recipients.slice(i, i + 100);
    try {
      await sendSms({ to: batch.map((r) => r.phone), content: message, category, template: 'admin_message', createdBy: req.user.sub, userId: batch.length === 1 ? batch[0].id : undefined });
      sent += batch.length;
    } catch (e) { failed += batch.length; lastError = e.message; }
  }
  await audit(req.user.sub, 'sms_send', null, { audience: req.body.audience, recipients: recipients.length, sent, failed });
  if (!sent) throw ApiError.badRequest(lastError || 'SMS could not be delivered.');
  ok(res, { recipients: recipients.length, sent, failed }, `SMS sent to ${sent} recipient${sent === 1 ? '' : 's'}`, 201);
});

exports.updateSettings = asyncHandler(async (req, res) => {
  const incoming = req.body.events || {};
  const current = await events.eventSettings();
  const next = { ...current };
  for (const key of Object.keys(EVENT_LABELS)) if (typeof incoming[key] === 'boolean') next[key] = incoming[key];
  await db.query(
    `INSERT INTO app_settings(setting_key, setting_value, updated_by) VALUES('sms_events', ?, ?)
     ON DUPLICATE KEY UPDATE setting_value=VALUES(setting_value), updated_by=VALUES(updated_by)`,
    [JSON.stringify(next), req.user.sub]
  );
  events.clearSettingsCache();
  await audit(req.user.sub, 'sms_settings', null, next);
  ok(res, { events: next }, 'SMS settings saved');
});
