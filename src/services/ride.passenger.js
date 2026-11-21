/**
 * "Book for a friend": validation, privacy rules and the rider's address book of passengers.
 *
 * The booker (rides.rider_id) owns, pays for and can cancel the ride. The passenger is whoever actually rides:
 * the driver sees (and calls) them instead of the booker, and they get the trip details + PIN by SMS.
 */
const db = require('../config/db');
const ApiError = require('../utils/ApiError');
const { normalizePhone, isValidPhone } = require('../utils/phone');

const MAX_FRIEND_RIDES_PER_DAY = Number(process.env.FRIEND_RIDES_PER_DAY || 12);
const MAX_RIDES_TO_ONE_NUMBER_PER_HOUR = Number(process.env.FRIEND_RIDES_PER_NUMBER_HOUR || 3);
const MAX_SAVED = 30;

const truthy = (v) => v === true || v === 1 || v === '1' || String(v).toLowerCase() === 'true';

/** Remove control characters and collapse whitespace so a name can be safely placed in an SMS or a push. */
function cleanText(value, max) {
  return String(value == null ? '' : value)
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001F\u007F\u2028\u2029]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/**
 * Turns the request body into the passenger data to store. Returns `{ bookedForOther:false }` for a normal ride.
 * Throws a friendly 400 for anything a rider can fix.
 */
function parsePassenger(input = {}, rider = {}) {
  const flag = truthy(input.bookedForOther) || truthy(input.forFriend) || truthy(input.forSomeoneElse);
  if (!flag) return { bookedForOther: false, name: null, phone: null, note: null };

  const name = cleanText(input.passengerName ?? input.passenger?.name, 60);
  const rawPhone = String(input.passengerPhone ?? input.passenger?.phone ?? '').trim();
  const note = cleanText(input.passengerNote ?? input.passenger?.note, 160) || null;

  if (name.length < 2) throw ApiError.badRequest('Enter the name of the person who will be riding.', { code: 'PASSENGER_NAME' });
  if (!/\p{L}/u.test(name)) throw ApiError.badRequest('Enter a valid name for the person who will be riding.', { code: 'PASSENGER_NAME' });
  if (!rawPhone) throw ApiError.badRequest('Enter the phone number of the person who will be riding, so the driver can reach them.', { code: 'PASSENGER_PHONE' });

  const phone = normalizePhone(rawPhone);
  if (!isValidPhone(phone)) throw ApiError.badRequest('That phone number does not look right. Check it and try again.', { code: 'PASSENGER_PHONE' });
  if (rider.phone && normalizePhone(rider.phone) === phone) {
    throw ApiError.badRequest('That is your own number. Turn off "Book for a friend" to ride yourself.', { code: 'PASSENGER_IS_SELF' });
  }
  return { bookedForOther: true, name, phone, note };
}

/** Anti-abuse: stops the SMS channel being used to spam a number, or a stolen account to mass-book. */
async function assertWithinLimits(riderId, passenger) {
  if (!passenger.bookedForOther) return;
  const perNumber = await db.query(
    `SELECT COUNT(*) c FROM rides WHERE passenger_phone=? AND created_at >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 HOUR)`,
    [passenger.phone]
  );
  if (Number(perNumber[0].c) >= MAX_RIDES_TO_ONE_NUMBER_PER_HOUR) {
    throw new ApiError(429, 'Too many rides were booked for this number recently. Please try again later.', { code: 'PASSENGER_RATE' });
  }
  const perDay = await db.query(
    `SELECT COUNT(*) c FROM rides WHERE rider_id=? AND booked_for_other=1 AND created_at >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 24 HOUR)`,
    [riderId]
  );
  if (Number(perDay[0].c) >= MAX_FRIEND_RIDES_PER_DAY) {
    throw new ApiError(429, 'You have reached the daily limit for booking rides for other people.', { code: 'PASSENGER_DAILY' });
  }
}

/** Keeps the rider's address book of passengers fresh (best effort, never fails a booking). */
async function remember(riderId, passenger) {
  if (!passenger.bookedForOther) return;
  try {
    await db.query(
      `INSERT INTO rider_saved_passengers(rider_id,name,phone) VALUES(?,?,?)
       ON DUPLICATE KEY UPDATE name=VALUES(name), times_used=times_used+1, last_used_at=CURRENT_TIMESTAMP`,
      [riderId, passenger.name, passenger.phone]
    );
    // Keep the list short: drop the least recently used beyond the cap.
    await db.query(
      `DELETE FROM rider_saved_passengers WHERE rider_id=? AND id NOT IN (
         SELECT id FROM (SELECT id FROM rider_saved_passengers WHERE rider_id=? ORDER BY last_used_at DESC LIMIT ${MAX_SAVED}) keep)`,
      [riderId, riderId]
    );
  } catch (e) { console.warn('[passenger] remember failed:', e.message); }
}

async function list(riderId) {
  const rows = await db.query(
    'SELECT id,name,phone,times_used,last_used_at FROM rider_saved_passengers WHERE rider_id=? ORDER BY last_used_at DESC LIMIT '+MAX_SAVED,
    [riderId]
  );
  return rows.map((x) => ({ id: Number(x.id), name: x.name, phone: x.phone, timesUsed: Number(x.times_used), lastUsedAt: x.last_used_at }));
}

async function remove(riderId, id) {
  await db.query('DELETE FROM rider_saved_passengers WHERE id=? AND rider_id=?', [id, riderId]);
  return { removed: true };
}

/** The shape every app receives. `null` for a normal ride. */
function toPublic(row) {
  if (!row || !Number(row.booked_for_other)) return null;
  return { name: row.passenger_name || null, phone: row.passenger_phone || null, note: row.passenger_note || null };
}

module.exports = { parsePassenger, assertWithinLimits, remember, list, remove, toPublic, cleanText };
