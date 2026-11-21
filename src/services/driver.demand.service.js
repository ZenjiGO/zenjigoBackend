/**
 * Demand Radar: tells a driver where riders are most likely to request a trip RIGHT NOW.
 *
 * It blends three signals on a ~550 m grid (no personal data, only counts per cell):
 *   1. Typical demand   pickups in the same hour window (+/- 1h, Tanzania time) on the same kind of day
 *                       (weekday / weekend) over the last 28 days, newer days counting more.
 *      -> mornings light up residential areas, lunchtime lights up town, evenings light up offices and markets.
 *   2. Live demand      requests made in the last 45 minutes (unanswered ones count triple).
 *   3. Supply           drivers already online in the cell. The more drivers there, the lower the score, so
 *                       the radar points drivers to where riders are under-served rather than to a crowd.
 * Each cell is smoothed into its neighbours so hot areas read as soft blobs on the map.
 */
const db = require('../config/db');

const CELL_DEG = 0.005;          // ~550 m
const TZ_OFFSET_HOURS = 3;       // Tanzania (EAT) has no daylight saving
const HISTORY_DAYS = 28;
const HALF_LIFE_DAYS = 7;        // recency weighting of history
const MIN_SIGNAL = 2;            // below this there is nothing worth highlighting
const MIN_SCALE = 4;             // a lone request must never look like a "hot" area
const MIN_INTENSITY = 0.18;
const MAX_ZONES = 45;
const CACHE_MS = 30000;

const cache = new Map();

/** Tanzania local time parts for a Date (or ms). */
function localParts(now = new Date()) {
  const d = new Date(new Date(now).getTime() + TZ_OFFSET_HOURS * 3600 * 1000);
  return { hour: d.getUTCHours(), dow: d.getUTCDay(), minute: d.getUTCMinutes() }; // dow: 0=Sun
}

/** Hours to compare against: the current one and its neighbours. */
function hourWindow(hour) {
  return [(hour + 23) % 24, hour, (hour + 1) % 24];
}

/** MySQL DAYOFWEEK values (1=Sun..7=Sat) that count as "the same kind of day". */
function dayTypeDows(dow) {
  return dow === 0 || dow === 6 ? [1, 7] : [2, 3, 4, 5, 6];
}

/** Human label for the time of day, used as the radar headline. */
function periodFor(hour, dow) {
  const weekend = dow === 0 || dow === 6;
  if (hour >= 5 && hour < 9)  return { key: 'morning_commute', label: weekend ? 'Early risers' : 'Morning commute', hint: weekend ? 'Riders are heading out for the day.' : 'People are heading to work and school.' };
  if (hour >= 9 && hour < 12) return { key: 'late_morning', label: 'Late morning', hint: 'Errands, markets and town trips.' };
  if (hour >= 12 && hour < 14) return { key: 'lunch', label: 'Lunch hour', hint: 'Riders are moving around town for lunch.' };
  if (hour >= 14 && hour < 16) return { key: 'afternoon', label: 'Afternoon', hint: 'Steady trips around town.' };
  if (hour >= 16 && hour < 20) return { key: 'evening', label: weekend ? 'Evening out' : 'Evening rush', hint: weekend ? 'Riders heading out for the evening.' : 'People are heading home from work.' };
  if (hour >= 20 && hour < 23) return { key: 'night', label: 'Night out', hint: 'Restaurants, hotels and nightlife.' };
  return { key: 'late_night', label: 'Late night', hint: 'Fewer trips, usually from hotels and venues.' };
}

function levelFor(intensity) {
  if (intensity >= 0.75) return 'peak';
  if (intensity >= 0.5) return 'high';
  if (intensity >= 0.3) return 'medium';
  return 'low';
}

const key = (cy, cx) => `${cy}:${cx}`;

function haversineKm(aLat, aLng, bLat, bLng) {
  const R = 6371, r = (x) => (x * Math.PI) / 180;
  const dLat = r(bLat - aLat), dLng = r(bLng - aLng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(r(aLat)) * Math.cos(r(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function bearingDeg(aLat, aLng, bLat, bLng) {
  const r = (x) => (x * Math.PI) / 180, d = (x) => (x * 180) / Math.PI;
  const y = Math.sin(r(bLng - aLng)) * Math.cos(r(bLat));
  const x = Math.cos(r(aLat)) * Math.sin(r(bLat)) - Math.sin(r(aLat)) * Math.cos(r(bLat)) * Math.cos(r(bLng - aLng));
  return Math.round((d(Math.atan2(y, x)) + 360) % 360);
}

/**
 * Pure scoring step (unit tested).
 * history / live / supply: arrays of { cy, cx, w?, n?, searching? , drivers? } keyed by grid cell.
 */
function scoreZones({ history = [], live = [], supply = [], center = null }) {
  const demand = new Map();
  const live45 = new Map();
  const searching = new Map();
  const add = (m, k, v) => m.set(k, (m.get(k) || 0) + v);

  for (const h of history) add(demand, key(h.cy, h.cx), Number(h.w || 0) * 0.5);
  for (const l of live) {
    const k = key(l.cy, l.cx);
    add(demand, k, Number(l.w || 0) * 1.5);
    add(live45, k, Number(l.n || 0));
    add(searching, k, Number(l.searching || 0));
  }
  const drivers = new Map();
  for (const s of supply) add(drivers, key(s.cy, s.cx), Number(s.drivers || 0));

  // Smooth into the 8 neighbours so a hot spot is a soft blob rather than one square.
  const smooth = new Map();
  for (const [k, v] of demand) {
    const [cy, cx] = k.split(':').map(Number);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      add(smooth, key(cy + dy, cx + dx), v * (dy === 0 && dx === 0 ? 1 : 0.35));
    }
  }

  const gaps = [];
  for (const [k, v] of smooth) {
    const nearby = drivers.get(k) || 0;
    gaps.push({ k, gap: v / (1 + 0.5 * nearby), drivers: nearby });
  }
  const maxGap = gaps.reduce((m, g) => Math.max(m, g.gap), 0);
  if (maxGap < MIN_SIGNAL) return { zones: [], best: null };

  const scale = Math.max(maxGap, MIN_SCALE);
  const zones = gaps
    .map((g) => {
      const [cy, cx] = g.k.split(':').map(Number);
      const intensity = Math.min(1, g.gap / scale);
      return {
        lat: Number(((cy + 0.5) * CELL_DEG).toFixed(5)),
        lng: Number(((cx + 0.5) * CELL_DEG).toFixed(5)),
        intensity: Number(intensity.toFixed(2)),
        level: levelFor(intensity),
        requests: Math.round(live45.get(g.k) || 0),
        waiting: Math.round(searching.get(g.k) || 0),
        drivers: g.drivers
      };
    })
    .filter((z) => z.intensity >= MIN_INTENSITY)
    .sort((a, b) => b.intensity - a.intensity)
    .slice(0, MAX_ZONES);

  let best = null;
  if (center && zones.length) {
    let top = null;
    for (const z of zones) {
      const km = haversineKm(center.lat, center.lng, z.lat, z.lng);
      const rank = z.intensity / (1 + km / 3); // closer hot spots beat far ones
      if (!top || rank > top.rank) top = { z, km, rank };
    }
    best = {
      lat: top.z.lat, lng: top.z.lng, level: top.z.level, intensity: top.z.intensity,
      distanceKm: Number(top.km.toFixed(1)),
      bearing: bearingDeg(center.lat, center.lng, top.z.lat, top.z.lng),
      waiting: top.z.waiting
    };
  }
  return { zones, best };
}

async function load({ lat, lng, radiusKm, now }) {
  const { hour, dow } = localParts(now);
  const hours = hourWindow(hour);
  const dows = dayTypeDows(dow);
  const dLat = radiusKm / 111;
  const dLng = radiusKm / (111 * Math.max(0.2, Math.cos((lat * Math.PI) / 180)));
  const box = [lat - dLat, lat + dLat, lng - dLng, lng + dLng];
  const ph = (arr) => arr.map(() => '?').join(',');

  const history = await db.query(
    `SELECT CAST(FLOOR(pickup_lat/${CELL_DEG}) AS SIGNED) cy, CAST(FLOOR(pickup_lng/${CELL_DEG}) AS SIGNED) cx,
            COUNT(*) n, SUM(EXP(-DATEDIFF(UTC_TIMESTAMP(), created_at)/${HALF_LIFE_DAYS})) w
       FROM rides
      WHERE created_at >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL ${HISTORY_DAYS} DAY)
        AND created_at <  DATE_SUB(UTC_TIMESTAMP(), INTERVAL 45 MINUTE)
        AND pickup_lat BETWEEN ? AND ? AND pickup_lng BETWEEN ? AND ?
        AND HOUR(DATE_ADD(created_at, INTERVAL ${TZ_OFFSET_HOURS} HOUR)) IN (${ph(hours)})
        AND DAYOFWEEK(DATE_ADD(created_at, INTERVAL ${TZ_OFFSET_HOURS} HOUR)) IN (${ph(dows)})
      GROUP BY cy, cx`,
    [...box, ...hours, ...dows]
  );

  const liveRows = await db.query(
    `SELECT CAST(FLOOR(pickup_lat/${CELL_DEG}) AS SIGNED) cy, CAST(FLOOR(pickup_lng/${CELL_DEG}) AS SIGNED) cx,
            COUNT(*) n,
            SUM(CASE WHEN status='searching' AND COALESCE(searching_since,created_at) >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 10 MINUTE) THEN 3 ELSE 1 END) w,
            SUM(CASE WHEN status='searching' AND COALESCE(searching_since,created_at) >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 10 MINUTE) THEN 1 ELSE 0 END) searching
       FROM rides
      WHERE created_at >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 45 MINUTE)
        AND pickup_lat BETWEEN ? AND ? AND pickup_lng BETWEEN ? AND ?
      GROUP BY cy, cx`,
    box
  );

  const supply = await db.query(
    `SELECT CAST(FLOOR(d.current_lat/${CELL_DEG}) AS SIGNED) cy, CAST(FLOOR(d.current_lng/${CELL_DEG}) AS SIGNED) cx, COUNT(*) drivers
       FROM driver_profiles d
      WHERE d.online=1 AND d.current_lat IS NOT NULL AND d.current_lng IS NOT NULL
        AND d.location_updated_at >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 3 MINUTE)
        AND d.current_lat BETWEEN ? AND ? AND d.current_lng BETWEEN ? AND ?
        AND NOT EXISTS (SELECT 1 FROM rides ar WHERE ar.driver_id=d.user_id AND ar.status IN ('accepted','arriving','arrived','started'))
      GROUP BY cy, cx`,
    box
  );

  return { history, live: liveRows, supply };
}

/** Public entry point used by GET /driver/demand-zones. */
async function demandZones({ lat, lng, radiusKm = 10, now = new Date() }) {
  const la = Number(lat), ln = Number(lng);
  if (!Number.isFinite(la) || !Number.isFinite(ln) || Math.abs(la) > 90 || Math.abs(ln) > 180) {
    const ApiError = require('../utils/ApiError');
    throw ApiError.badRequest('Your location is needed to show the demand radar.');
  }
  const radius = Math.min(25, Math.max(2, Number(radiusKm) || 10));
  const ck = `${la.toFixed(2)}:${ln.toFixed(2)}:${radius}:${Math.floor(new Date(now).getTime() / CACHE_MS)}`;
  let base = cache.get(ck);
  if (!base) {
    const data = await load({ lat: la, lng: ln, radiusKm: radius, now });
    const confidence = data.history.reduce((a, h) => a + Number(h.n || 0), 0) >= 25 ? 'good' : 'building';
    base = { data, confidence };
    cache.set(ck, base);
    if (cache.size > 200) for (const k of [...cache.keys()].slice(0, 100)) cache.delete(k);
  }
  const { zones, best } = scoreZones({ ...base.data, center: { lat: la, lng: ln } });
  const { hour, dow } = localParts(now);
  const period = periodFor(hour, dow);
  return {
    generatedAt: new Date(now).toISOString(),
    refreshSeconds: 60,
    cellMeters: 550,
    period,
    confidence: base.confidence,
    zones,
    best
  };
}

module.exports = { demandZones, scoreZones, periodFor, levelFor, localParts, hourWindow, dayTypeDows, haversineKm, CELL_DEG };
