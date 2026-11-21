/**
 * Transactional / event SMS for riders, drivers and admins.
 * - Never throws: SMS is a best-effort channel next to push, in-app and email.
 * - Admins can switch individual events off (app_settings.sms_events).
 * - Marketing/broadcast messages honour users.sms_opt_in; transactional ones do not.
 */
const { isValidPhone, normalizePhone } = require('../utils/phone');

// Loaded lazily so the module can be required (and unit-tested) without the full runtime config.
const config = () => { try { return require('../config/env'); } catch (_) { return {}; } };
const gateway = () => require('./sms.service');

const APP = () => (config().appName || 'ZenjiGO');
const money = (n) => `TZS ${Math.round(Number(n) || 0).toLocaleString('en-US')}`;

/** event key -> { category, text(vars) }. Keep each under ~160 GSM-7 chars where possible. */
const TEMPLATES = {
  welcome_rider:   { event: 'welcome',        category: 'account', text: (v) => `Karibu ${APP()}${v.name ? ', ' + v.name : ''}! Your phone is verified. Book boda, bajaji or taxi anytime in the app.` },
  welcome_driver:  { event: 'welcome',        category: 'account', text: () => `${APP()}: we received your driver application. We will review your documents and SMS you the result.` },
  ride_accepted:   { event: 'ride_accepted',  category: 'ride',    text: (v) => `${APP()}: ${v.driver || 'Your driver'}${v.plate ? ' (' + v.plate + ')' : ''} is on the way.${v.pin ? ' Trip PIN: ' + v.pin + '. Share it only with your driver at pickup.' : ''}` },
  ride_arrived:    { event: 'ride_arrived',   category: 'ride',    text: (v) => `${APP()}: your driver has arrived at pickup.${v.pin ? ' Trip PIN: ' + v.pin + '.' : ''}` },
  ride_cancelled:  { event: 'ride_cancelled', category: 'ride',    text: (v) => `${APP()}: your ride${v.code ? ' ' + v.code : ''} was cancelled.${v.fee ? ' Cancellation fee: ' + money(v.fee) + '.' : ''}` },
  ride_no_driver:  { event: 'ride_no_driver', category: 'ride',    text: () => `${APP()}: no driver is available right now. Please try again in a few minutes.` },
  ride_completed:  { event: 'ride_completed', category: 'ride',    text: (v) => `${APP()}: trip complete${v.code ? ' (' + v.code + ')' : ''}. Total ${money(v.total)}. Thank you for riding with us!` },
  // --- "Book for a friend": SMS to the person who is actually riding (the booker keeps their own SMS) ---
  ride_booked_for_you:      { event: 'ride_for_friend', category: 'ride', text: (v) => `${APP()}: ${v.booker || 'Someone'} booked a ride for you${v.pickup ? ' from ' + v.pickup : ''}. We will text you the driver details once a driver accepts.` },
  ride_accepted_passenger:  { event: 'ride_for_friend', category: 'ride', text: (v) => `${APP()}: ${v.driver || 'Your driver'}${v.plate ? ' (' + v.plate + ')' : ''} is on the way for the ride ${v.booker || 'a friend'} booked you.${v.pin ? ' Trip PIN: ' + v.pin + '. Tell it only to your driver.' : ''}` },
  ride_arrived_passenger:   { event: 'ride_for_friend', category: 'ride', text: (v) => `${APP()}: your driver has arrived at pickup.${v.pin ? ' Trip PIN: ' + v.pin + '.' : ''}` },
  ride_cancelled_passenger: { event: 'ride_for_friend', category: 'ride', text: (v) => `${APP()}: the ride ${v.booker || 'a friend'} booked for you${v.code ? ' (' + v.code + ')' : ''} was cancelled.` },
  ride_request_driver: { event: 'ride_accepted', category: 'ride', text: (v) => `${APP()}: new ride request${v.pickup ? ' from ' + v.pickup : ''}. Open the app to accept.` },
  driver_approved: { event: 'driver_status',  category: 'account', text: () => `${APP()}: congratulations, your driver application is approved. Open the driver app and go online to start earning.` },
  driver_rejected: { event: 'driver_status',  category: 'account', text: (v) => `${APP()}: your driver application was not approved.${v.reason ? ' Reason: ' + v.reason : ''} Open the app for details.` },
  driver_suspended:{ event: 'driver_status',  category: 'account', text: () => `${APP()}: your driver account was suspended. Contact ZenjiGO support for help.` },
  payout_status:   { event: 'payout_status',  category: 'finance', text: (v) => `${APP()}: your payout of ${money(v.amount)} was ${v.status}.${v.note ? ' ' + v.note : ''}` },
  settlement_due:  { event: 'payout_status',  category: 'finance', text: (v) => `${APP()}: commission of ${money(v.amount)} is due. Pay in the driver app to keep receiving rides.` },
  wallet_topup:    { event: 'wallet_topup',   category: 'finance', text: (v) => `${APP()}: wallet top-up of ${money(v.amount)} received. New balance ${money(v.balance)}.` },
  parcel_tour:     { event: 'parcel_tour',    category: 'ride',    text: (v) => `${APP()}: ${v.what || 'your booking'} is confirmed${v.code ? ' (' + v.code + ')' : ''}.` },
  phone_changed:   { event: 'security',       category: 'account', text: () => `${APP()}: the phone number on your account was changed. If this was not you, contact support immediately.` },
  security_login:  { event: 'security',       category: 'account', text: () => `${APP()}: a new sign-in to your account was detected. If this was not you, contact support.` },
  account_deleted: { event: 'security',       category: 'account', text: () => `${APP()}: your account deletion request was received. Contact support within 7 days to cancel.` }
};

let cache = { at: 0, value: null };
async function eventSettings() {
  if (cache.value && Date.now() - cache.at < 60000) return cache.value;
  let value = {};
  try {
    const db = require('../config/db');
    const rows = await db.query('SELECT setting_value FROM app_settings WHERE setting_key="sms_events" LIMIT 1');
    if (rows.length) {
      const raw = rows[0].setting_value;
      value = typeof raw === 'string' ? JSON.parse(raw) : (raw || {});
    }
  } catch (_) { value = {}; }
  cache = { at: Date.now(), value };
  return value;
}
function clearSettingsCache() { cache = { at: 0, value: null }; }

function enabledGlobally() {
  return String(process.env.SMS_NOTIFICATIONS_ENABLED || 'true').toLowerCase() !== 'false' && gateway().isConfigured();
}

/** Send a templated SMS to a phone number. Returns true when handed to the provider. */
async function sendToPhone(phone, template, vars = {}, meta = {}) {
  try {
    const tpl = TEMPLATES[template];
    if (!tpl) return false;
    if (!enabledGlobally()) return false;
    const settings = await eventSettings();
    if (settings[tpl.event] === false) return false;
    const to = normalizePhone(phone);
    if (!isValidPhone(to)) return false;
    await gateway().sendSms({ to, content: tpl.text(vars), category: tpl.category, template, userId: meta.userId, createdBy: meta.createdBy });
    return true;
  } catch (err) {
    console.warn(`[sms.events] ${template} failed: ${err.message}`);
    return false;
  }
}

/** Send a templated SMS to a user by id (looks up the phone, skips blocked/missing numbers). */
async function sendToUser(userId, template, vars = {}, meta = {}) {
  try {
    if (!userId || !enabledGlobally()) return false;
    const db = require('../config/db');
    const rows = await db.query('SELECT id, phone, status FROM users WHERE id=? LIMIT 1', [userId]);
    if (!rows.length || !rows[0].phone) return false;
    return sendToPhone(rows[0].phone, template, vars, { ...meta, userId: rows[0].id });
  } catch (err) {
    console.warn(`[sms.events] ${template} lookup failed: ${err.message}`);
    return false;
  }
}

/** Fire and forget helper for hot paths (ride lifecycle). */
function later(promise) {
  Promise.resolve(promise).catch(() => {});
}

module.exports = { TEMPLATES, sendToPhone, sendToUser, later, eventSettings, clearSettingsCache, enabledGlobally };
