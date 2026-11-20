/**
 * Phone helpers. All numbers are stored and compared in E.164 (+255712345678).
 * Local Tanzanian input (0712 345 678 / 712345678 / 255712345678) is accepted.
 */
const DEFAULT_CC = '+255';

function normalizePhone(phone) {
  let p = String(phone || '').trim().replace(/[^\d+]/g, '');
  if (!p) return '';
  if (p.startsWith('00')) p = '+' + p.slice(2);
  if (!p.startsWith('+')) {
    if (/^255\d{9}$/.test(p)) p = '+' + p;           // 255712345678 -> +255712345678
    else p = DEFAULT_CC + p.replace(/^0/, '');       // 0712345678 / 712345678
  }
  // +2550712... (trunk zero typed after the country code) -> +255712...
  if (p.startsWith('+2550')) p = '+255' + p.slice(5);
  return p;
}

/** True for a plausible E.164 number (8-15 digits). */
function isValidPhone(phone) {
  return /^\+[1-9]\d{7,14}$/.test(normalizePhone(phone));
}

/** True for a Tanzanian mobile number (+255 followed by 6/7 and 8 digits). */
function isTzMobile(phone) {
  return /^\+255[67]\d{8}$/.test(normalizePhone(phone));
}

/** +255712345678 -> +255 7•• ••• 678 (safe to show in UI/logs). */
function maskPhone(phone) {
  const p = normalizePhone(phone);
  if (p.length < 8) return p;
  return `${p.slice(0, 4)}${'•'.repeat(Math.max(3, p.length - 7))}${p.slice(-3)}`;
}

/** Logs must never carry a full number. */
function logPhone(phone) {
  const p = normalizePhone(phone);
  return p.length < 8 ? '***' : `${p.slice(0, 4)}***${p.slice(-3)}`;
}

module.exports = { normalizePhone, isValidPhone, isTzMobile, maskPhone, logPhone };
