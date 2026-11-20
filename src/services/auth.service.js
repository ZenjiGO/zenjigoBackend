const db = require('../config/db');
const ApiError = require('../utils/ApiError');
const { normalizePhone, isValidPhone, isTzMobile, maskPhone } = require('../utils/phone');
const { signAccess, issueRefreshToken } = require('../utils/jwt');
const otp = require('./otp.service');
const { sendWelcomeEmail } = require('./welcome-email.service');
const smsEvents = require('./sms.events');

/** Lazy config so unit tests can run without dotenv; production always has the real file. */
function cfg() { try { return require('../config/env'); } catch (_) { return { sms: {}, briq: {} }; } }
const SEED_PLACEHOLDER_PHONE = '+255700000001';

function publicUser(row, wallet = 0) {
  return {
    id: row.id, role: row.role, fullName: row.full_name, phone: row.phone, email: row.email,
    photoUrl: row.photo_url, island: row.island, region: row.region, district: row.district,
    ward: row.ward, status: row.status, walletBalance: Number(wallet)
  };
}

function maskEmail(email) {
  const value = String(email || '');
  const at = value.indexOf('@');
  if (at < 2) return value;
  const local = value.slice(0, at);
  const domain = value.slice(at);
  return `${local.slice(0, 2)}${'*'.repeat(Math.max(2, local.length - 2))}${domain}`;
}

function cleanEmail(email) {
  const mail = String(email || '').trim().toLowerCase();
  return mail.includes('@') ? mail : '';
}

/**
 * Rider login uses one identifier. A phone gets an SMS code, an email gets
 * an email code. Signup still sends both, and that code goes by SMS.
 * Drivers and admins still receive email on the address stored for that role.
 */
async function sendOtp({ phone, email, purpose = 'login', role = null }) {
  const resolvedRole =
    role ||
    (purpose === 'driver_registration' ? 'driver' : null) ||
    (purpose === 'admin_login' ? 'admin' : null);

  if (resolvedRole === 'rider') {
    const mail = cleanEmail(email);
    const hasPhone = Boolean(String(phone || '').trim());
    if (!hasPhone && !mail) {
      throw ApiError.badRequest('Enter a phone number or an email address.');
    }
    if (hasPhone && !mail) {
      const targetPhone = normalizePhone(phone);
      const rows = await db.query('SELECT id FROM users WHERE role="rider" AND phone=? LIMIT 1', [targetPhone]);
      if (!rows.length) throw ApiError.badRequest('No rider account uses this phone number.');
      await otp.send({ target: targetPhone, purpose: purpose || 'login', channel: 'sms', userId: rows[0].id });
      return { target: targetPhone, channel: 'sms', maskedPhone: maskPhone(targetPhone) };
    }
    if (mail && !hasPhone) {
      const rows = await db.query('SELECT id FROM users WHERE role="rider" AND email=? LIMIT 1', [mail]);
      if (!rows.length) throw ApiError.badRequest('No rider account uses this email.');
      await otp.send({ target: mail, purpose: purpose || 'login', channel: 'email' });
      return { target: mail, channel: 'email', maskedEmail: maskEmail(mail) };
    }
    // Phone + email together = sign-up. The phone must be new, and it is verified by SMS.
    const targetPhone = normalizePhone(phone);
    if (!isValidPhone(targetPhone)) throw ApiError.badRequest('Enter a valid phone number.');
    const takenPhone = await db.query('SELECT id FROM users WHERE role="rider" AND phone=? LIMIT 1', [targetPhone]);
    if (takenPhone.length) throw ApiError.conflict('This phone number is already registered. Please sign in instead.');
    const takenMail = await db.query('SELECT id FROM users WHERE role="rider" AND email=? LIMIT 1', [mail]);
    if (takenMail.length) throw ApiError.conflict('This email is already registered. Please sign in instead.');
    await otp.send({ target: targetPhone, purpose: 'signup', channel: 'sms' });
    return { target: targetPhone, channel: 'sms', maskedPhone: maskPhone(targetPhone) };
  }

  // Driver sign-in by phone: the code goes by SMS to the number on a driver account.
  if (resolvedRole === 'driver' && purpose === 'login' && String(phone || '').trim() && !String(email || '').trim()) {
    const targetPhone = normalizePhone(phone);
    if (!isValidPhone(targetPhone)) throw ApiError.badRequest('Enter a valid phone number.');
    const rows = await db.query('SELECT id FROM users WHERE role="driver" AND phone=? LIMIT 1', [targetPhone]);
    // Same response whether or not the account exists (no account enumeration).
    if (rows.length) await otp.send({ target: targetPhone, purpose: 'login', channel: 'sms', userId: rows[0].id });
    return { target: targetPhone, channel: 'sms', maskedPhone: maskPhone(targetPhone) };
  }

  const mail = String(email || '').trim().toLowerCase();
  if (!mail || !mail.includes('@')) {
    throw ApiError.badRequest('A valid email address is required. OTP is delivered by email only.');
  }

  // Login flows: resolve the account in a role-safe way, then email THAT account only
  if (purpose === 'login' || purpose === 'admin_login') {
    let user = null;
    const targetPhone = phone ? normalizePhone(phone) : null;

    if (resolvedRole && targetPhone) {
      const rows = await db.query(
        'SELECT id, email, phone, role FROM users WHERE role = ? AND phone = ? LIMIT 1',
        [resolvedRole, targetPhone]
      );
      user = rows[0] || null;
    }

    // Fallback: look up by role + email
    if (!user && resolvedRole && mail) {
      const rows = await db.query(
        'SELECT id, email, phone, role FROM users WHERE role = ? AND email = ? LIMIT 1',
        [resolvedRole, mail]
      );
      user = rows[0] || null;
    }

    // Last resort without role (legacy): match email exactly, never bare phone across roles
    if (!user && mail) {
      const rows = await db.query(
        'SELECT id, email, phone, role FROM users WHERE email = ? LIMIT 1',
        [mail]
      );
      user = rows[0] || null;
    }

    if (!user) {
      // Do not reveal whether the account exists: respond exactly like a successful send.
      return { target: mail, maskedEmail: maskEmail(mail) };
    }

    const registered = String(user.email || '').trim().toLowerCase();
    if (!registered) {
      throw ApiError.badRequest('This account has no email on file. Contact support.');
    }

    // If the client supplied an email, it must match the account (prevents sending codes to the wrong inbox)
    if (mail && mail !== registered) {
      // Same generic response as an unknown account; never send to, or confirm, another inbox.
      return { target: mail, maskedEmail: maskEmail(mail) };
    }

    await otp.send({ target: registered, purpose, channel: 'email' });
    return { target: registered, maskedEmail: maskEmail(registered) };
  }

  // Registration / other purposes: deliver to the email the user typed in
  await otp.send({ target: mail, purpose, channel: 'email' });
  return { target: mail, maskedEmail: maskEmail(mail) };
}

async function sendEmailOtp({ email, purpose = 'driver_registration' }) {
  const target = String(email || '').trim().toLowerCase();
  if (!target || !target.includes('@')) throw ApiError.badRequest('A valid email address is required.');
  await otp.send({ target, purpose, channel: 'email' });
  return { target, maskedEmail: maskEmail(target) };
}

/** Driver registration: verify the phone number by SMS (separate from email verification). */
async function sendDriverPhoneOtp({ phone }) {
  const target = normalizePhone(phone);
  if (!isValidPhone(target)) throw ApiError.badRequest('Enter a valid phone number.');
  const taken = await db.query('SELECT id FROM users WHERE role="driver" AND phone=? LIMIT 1', [target]);
  if (taken.length) throw ApiError.conflict('A driver account already uses this phone number. Please sign in instead.');
  await otp.send({ target, purpose: 'driver_registration_phone', channel: 'sms' });
  return { target, channel: 'sms', maskedPhone: maskPhone(target) };
}

/** Verifies a registration code for either the email or the phone number. */
async function verifyDriverOtp({ target, code, purpose }) {
  const raw = String(target || '').trim();
  if (!raw) throw ApiError.badRequest('A valid email or phone target is required.');
  if (!code || String(code).trim().length < 4) throw ApiError.badRequest('OTP code is required.');
  const isEmail = raw.includes('@');
  const t = isEmail ? raw.toLowerCase() : normalizePhone(raw);
  if (!isEmail && !isValidPhone(t)) throw ApiError.badRequest('A valid phone number is required.');
  const resolved = isEmail ? (purpose || 'driver_registration') : 'driver_registration_phone';
  // Mark the code as verified immediately so multi-step registration does not
  // fail later when the original OTP TTL elapses.
  await otp.verify({ target: t, code: String(code).trim(), purpose: resolved });
  return { verified: true, target: t, channel: isEmail ? 'email' : 'sms' };
}

async function riderSession(user) {
  const wallet = (await db.query('SELECT balance FROM wallets WHERE user_id=?', [user.id]))[0]?.balance || 0;
  return {
    user: publicUser(user, wallet),
    accessToken: signAccess({ sub: user.id, role: user.role }),
    refreshToken: await issueRefreshToken(user.id, user.role)
  };
}

async function verifyRider({ phone, code, fullName, email, island, region, district, ward }) {
  const mail = cleanEmail(email);
  const hasPhone = Boolean(String(phone || '').trim());
  if (!hasPhone && !mail) throw ApiError.badRequest('Enter a phone number or an email address.');

  if (mail && !hasPhone) {
    await otp.verify({ target: mail, code, purpose: 'login' });
    const rows = await db.query('SELECT * FROM users WHERE email=? AND role="rider" LIMIT 1', [mail]);
    if (!rows.length) throw ApiError.badRequest('No rider account uses this email.');
    await db.query(
      'UPDATE users SET email_verified_at=COALESCE(email_verified_at,UTC_TIMESTAMP()), last_login_at=UTC_TIMESTAMP() WHERE id=?',
      [rows[0].id]
    );
    const user = (await db.query('SELECT * FROM users WHERE id=?', [rows[0].id]))[0];
    return riderSession(user);
  }

  if (hasPhone && !mail) {
    const target = normalizePhone(phone);
    await otp.verify({ target, code, purpose: 'login' });
    const rows = await db.query('SELECT * FROM users WHERE phone=? AND role="rider" LIMIT 1', [target]);
    if (!rows.length) throw ApiError.badRequest('No rider account uses this phone number.');
    await db.query(
      'UPDATE users SET phone_verified_at=COALESCE(phone_verified_at,UTC_TIMESTAMP()), last_login_at=UTC_TIMESTAMP() WHERE id=?',
      [rows[0].id]
    );
    const user = (await db.query('SELECT * FROM users WHERE id=?', [rows[0].id]))[0];
    return riderSession(user);
  }

  const target = normalizePhone(phone);
  await otp.verify({ target, code, purpose: 'signup' });
  let rows = await db.query("SELECT * FROM users WHERE phone=? AND role='rider' LIMIT 1", [target]);
  let user;
  let isNewRider = false;
  if (rows.length) {
    user = rows[0];
    
    await db.query(
      `UPDATE users SET phone_verified_at=COALESCE(phone_verified_at,UTC_TIMESTAMP()),last_login_at=UTC_TIMESTAMP(),
       full_name=COALESCE(NULLIF(?,''),full_name),email=COALESCE(NULLIF(?,''),email),
       island=COALESCE(NULLIF(?,''),island),region=COALESCE(NULLIF(?,''),region),
       district=COALESCE(NULLIF(?,''),district),ward=COALESCE(NULLIF(?,''),ward) WHERE id=?`,
      [fullName || '', mail, island || '', region || '', district || '', ward || '', user.id]);
    rows = await db.query('SELECT * FROM users WHERE id=?', [user.id]);
    user = rows[0];
  } else {
    const byEmail = await db.query("SELECT id FROM users WHERE email=? AND role='rider' LIMIT 1", [mail]);
    if (byEmail.length) throw ApiError.conflict('This email is already associated with another account.');
    const result = await db.query(
      'INSERT INTO users(role,full_name,phone,email,island,region,district,ward,phone_verified_at) VALUES("rider",?,?,?,?,?,?,?,UTC_TIMESTAMP())',
      [fullName || 'ZenjiGO Rider', target, mail, island || null, region || null, district || null, ward || null]);
    const id = result.insertId;
    isNewRider = true;
    await db.query('INSERT INTO rider_profiles(user_id,referral_code) VALUES(?,?)', [id, `ZG${String(id).padStart(6, '0')}`]);
    await db.query('INSERT INTO wallets(user_id) VALUES(?)', [id]);
    user = (await db.query('SELECT * FROM users WHERE id=?', [id]))[0];
  }
  if (isNewRider) {
    try { await sendWelcomeEmail({ email: user.email, name: user.full_name, role: 'rider' }); }
    catch (err) { console.error('[WELCOME EMAIL] Failed to send rider welcome email:', err.message); }
    smsEvents.later(smsEvents.sendToUser(user.id, 'welcome_rider', { name: String(user.full_name || '').split(' ')[0] }));
  }
  return riderSession(user);
}

function adminSmsPhone(admin) {
  const c = cfg();
  const phone = normalizePhone(admin.phone || '');
  if (c.sms && c.sms.adminOtpBySms === false) return null;
  if (!c.briq || !String(c.briq.apiKey || '').trim()) return null;
  if (!phone || phone === SEED_PLACEHOLDER_PHONE || !isTzMobile(phone)) return null;
  return phone;
}

async function adminWithPassword(email, password) {
  const { comparePassword } = require('../utils/hash');
  const normalizedEmail = String(email || '').trim().toLowerCase();
  const rows = await db.query('SELECT * FROM users WHERE email=? AND role="admin" LIMIT 1', [normalizedEmail]);
  if (!rows.length || !rows[0].password_hash || !(await comparePassword(password, rows[0].password_hash))) {
    throw ApiError.unauthorized('Invalid admin credentials.');
  }
  if (rows[0].status !== 'active') throw ApiError.unauthorized('Invalid admin credentials.');
  return { admin: rows[0], normalizedEmail };
}

async function loginAdmin({ email, password }) {
  const { admin, normalizedEmail } = await adminWithPassword(email, password);
  await otp.send({ target: normalizedEmail, purpose: 'admin_login', channel: 'email' });
  const phone = adminSmsPhone(admin);
  return {
    maskedEmail: maskEmail(normalizedEmail), requiresOtp: true, channel: 'email',
    smsAvailable: Boolean(phone), maskedPhone: phone ? maskPhone(phone) : null
  };
}

/** Admin asks for the sign-in code by SMS instead (password is checked again; nothing is revealed otherwise). */
async function sendAdminSmsOtp({ email, password }) {
  const { admin } = await adminWithPassword(email, password);
  const phone = adminSmsPhone(admin);
  if (!phone) throw ApiError.badRequest('SMS sign-in is not available for this admin account. Use the email code.');
  await otp.send({ target: phone, purpose: 'admin_login', channel: 'sms', userId: admin.id });
  return { channel: 'sms', maskedPhone: maskPhone(phone) };
}

async function verifyAdminOtp({ email, code }) {
  const normalizedEmail = String(email || '').trim().toLowerCase();
  const rows = await db.query('SELECT * FROM users WHERE email=? AND role="admin" LIMIT 1', [normalizedEmail]);
  if (!rows.length) throw ApiError.unauthorized('Invalid admin credentials.');
  const admin = rows[0];
  if (admin.status !== 'active') throw ApiError.unauthorized('Invalid admin credentials.');
  const targets = [normalizedEmail];
  const phone = adminSmsPhone(admin);
  if (phone) targets.push(phone);
  if (targets.length > 1 && typeof otp.verifyAny === 'function') {
    await otp.verifyAny({ targets, code, purpose: 'admin_login' });
  } else {
    await otp.verify({ target: normalizedEmail, code, purpose: 'admin_login' });
  }
  await db.query('UPDATE users SET last_login_at=UTC_TIMESTAMP() WHERE id=?', [admin.id]);
  const fresh = (await db.query('SELECT * FROM users WHERE id=?', [admin.id]))[0] || admin;
  return { user: publicUser(fresh), accessToken: signAccess({ sub: fresh.id, role: 'admin' }), refreshToken: await issueRefreshToken(fresh.id, 'admin') };
}

async function loginDriver({ phone, email, code }) {
  const mail = String(email || '').trim().toLowerCase();
  const hasPhone = Boolean(String(phone || '').trim());
  if ((!mail || !mail.includes('@')) && !hasPhone) {
    throw ApiError.badRequest('Enter your registered phone number or email address.');
  }
  if (!code || !String(code).trim()) {
    throw ApiError.badRequest('OTP code is required.');
  }

  // Sign-in is by SMS code (phone) or email code (email). The code must have been sent to the
  // same identifier that is used here.
  const GENERIC = 'Invalid phone/email or verification code.';
  const usePhone = hasPhone && !mail;
  const target = usePhone ? normalizePhone(phone) : mail;
  const rows = await db.query(
    `SELECT u.*, d.application_status
       FROM users u
       JOIN driver_profiles d ON d.user_id = u.id
      WHERE ${usePhone ? 'u.phone' : 'u.email'} = ? AND u.role = "driver"
      LIMIT 1`,
    [target]
  );
  if (!rows.length) {
    // Burn the same work so response shape/timing does not reveal account existence.
    try { await otp.verify({ target, code: String(code).trim(), purpose: 'login' }); } catch (_) {}
    throw ApiError.unauthorized(GENERIC);
  }
  const user = rows[0];
  try {
    await otp.verify({ target, code: String(code).trim(), purpose: 'login' });
  } catch (e) {
    throw (e && e.statusCode === 429) ? e : ApiError.unauthorized(GENERIC);
  }
  if (['suspended', 'banned', 'rejected'].includes(user.status)) {
    throw ApiError.forbidden('This driver account cannot sign in. Please contact ZenjiGO support.');
  }
  await db.query(
    `UPDATE users SET last_login_at=UTC_TIMESTAMP(), ${usePhone ? 'phone_verified_at=COALESCE(phone_verified_at,UTC_TIMESTAMP())' : 'email_verified_at=COALESCE(email_verified_at,UTC_TIMESTAMP())'} WHERE id=?`,
    [user.id]
  );
  console.info(JSON.stringify({ evt: 'auth.login', role: 'driver', userId: user.id, via: usePhone ? 'sms' : 'email' }));
  return {
    user: { ...publicUser(user), applicationStatus: user.application_status },
    accessToken: signAccess({ sub: user.id, role: 'driver' }),
    refreshToken: await issueRefreshToken(user.id, 'driver')
  };
}

/* ---------------- Phone number change (rider + driver) ---------------- */

async function sendPhoneChangeOtp({ userId, role, phone }) {
  const target = normalizePhone(phone);
  if (!isValidPhone(target)) throw ApiError.badRequest('Enter a valid phone number.');
  const current = (await db.query('SELECT phone FROM users WHERE id=? AND role=? LIMIT 1', [userId, role]))[0];
  if (!current) throw ApiError.notFound('Account not found.');
  if (normalizePhone(current.phone) === target) throw ApiError.badRequest('This is already your phone number.');
  const taken = await db.query('SELECT id FROM users WHERE role=? AND phone=? AND id<>? LIMIT 1', [role, target, userId]);
  if (taken.length) throw ApiError.conflict('This phone number is already used by another account.');
  await otp.send({ target, purpose: 'phone_change', channel: 'sms', userId });
  return { target, channel: 'sms', maskedPhone: maskPhone(target) };
}

/**
 * Verifies the code sent to the NEW number. Riders change immediately; for drivers the caller
 * records the verified number as a change request for admin approval.
 */
async function verifyPhoneChangeOtp({ userId, role, phone, code }) {
  const target = normalizePhone(phone);
  if (!isValidPhone(target)) throw ApiError.badRequest('Enter a valid phone number.');
  await otp.verify({ target, code, purpose: 'phone_change' });
  if (role !== 'rider') return { phone: target, applied: false };
  const before = (await db.query('SELECT phone FROM users WHERE id=? LIMIT 1', [userId]))[0];
  const taken = await db.query('SELECT id FROM users WHERE role="rider" AND phone=? AND id<>? LIMIT 1', [target, userId]);
  if (taken.length) throw ApiError.conflict('This phone number is already used by another account.');
  await db.query('UPDATE users SET phone=?, phone_verified_at=UTC_TIMESTAMP() WHERE id=?', [target, userId]);
  if (before && before.phone) smsEvents.later(smsEvents.sendToPhone(before.phone, 'phone_changed', {}, { userId }));
  return { phone: target, applied: true };
}

module.exports = {
  sendOtp, sendEmailOtp, sendDriverPhoneOtp, verifyDriverOtp, verifyRider,
  loginAdmin, sendAdminSmsOtp, verifyAdminOtp, loginDriver,
  sendPhoneChangeOtp, verifyPhoneChangeOtp, publicUser
};
