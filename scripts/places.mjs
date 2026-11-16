// Where am I? Works out the weather location from calendar events.
import { wallToUtc } from './ics.mjs';
import { CALENDAR } from './config.mjs';

const UA = 'Mozilla/5.0 (compatible; MorningReport/1.0)';
async function get(url) {
  const r = await fetch(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.text();
}

// ---------- where am I? (weather location from the calendar) ----------
// Each event can give "fixes": you're in city C from time A until time B. The app uses the most recently
// started fix that's still valid. A fix from an event stays valid until 24h after the event, so the weather
// keeps following you through gaps between events. Explicit "📍 City" events always win while they last.
const H24 = 24 * 3600e3;
const TRAVEL_RX = /\b(flight|fly|flyr?|train|tog|bus|ferry|ferje|drive|travel|reise|overnight|transfer|night train)\b/i;
const ROUTE_RX = /^(.+?)\s+(?:to|til|→|->|–|—)\s+(.+)$/i;
const DEST_RX = /\b(?:to|til)\s+([^,;()]+?)\s*$/i;

export async function inferPlaces(events) {
  const instant = (e, which) => e.allDay
    ? wallToUtc(Date.parse(e[which] + 'T00:00:00Z'), CALENDAR.defaultTz)
    : Date.parse(e[which]);
  const fixes = [];
  const add = async (query, from, until, explicit = false) => {
    const g = await findCity(query);
    if (g && until > from) fixes.push({ ...g, from: new Date(from).toISOString(), until: new Date(until).toISOString(), explicit });
  };
  const seen = new Set();
  for (const e of events) {
    const key = e.title + '|' + e.start;
    if (seen.has(key)) continue;   // the same event appears in both calendar windows
    seen.add(key);
    const start = instant(e, 'start'), end = instant(e, 'end');
    const pin = e.title.match(CALENDAR.placePattern);
    if (pin) { await add(pin[1], start, end, true); continue; }

    const route = e.location.match(ROUTE_RX);
    if (route) {
      await add(route[1], start, end);
      await add(route[2], end, end + H24);
    } else if (e.location) {
      await add(e.location, start, end + H24);
    }
    const dest = TRAVEL_RX.test(e.title) && e.title.match(DEST_RX);
    if (dest && !route) await add(dest[1], end, end + H24);
  }
  return fixes;
}

// Turn free text ("Sanya Phoenix International Airport", "Café X\nStorgata 1, 0155 Oslo, Norway",
// "Portland, Maine") into a city, or null. Only real cities count, so cafés and countries are ignored.
const geoCache = new Map();
async function findCity(text) {
  const parts = text.split(/\n|,/).map(s => s.replace(/\d+/g, ' ').replace(/\s+/g, ' ').trim()).filter(Boolean);
  const hint = parts.slice(1).join(' ').toLowerCase();
  // try the whole first part, then shorter prefixes of it, then any later address part
  const tries = [];
  const words = (parts[0] || '').split(' ');
  for (let n = words.length; n >= 1; n--) tries.push(words.slice(0, n).join(' '));
  tries.push(...parts.slice(1).reverse());
  for (const q of tries) {
    const hit = await geocodeCity(q, hint);
    if (hit) return hit;
  }
  return null;
}

const fold = s => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
async function geocodeCity(q, hint = '') {
  if (q.length < 2) return null;
  const key = q + '|' + hint;
  if (geoCache.has(key)) return geoCache.get(key);
  let pick = null;
  try {
    const r = JSON.parse(await get(`https://geocoding-api.open-meteo.com/v1/search?count=10&name=${encodeURIComponent(q)}`));
    const cities = (r.results || []).filter(x => /^PPL/.test(x.feature_code || '') && fold(x.name) === fold(q)
      && ((x.population || 0) >= 20000 || /^PPL(C|A|A2)$/.test(x.feature_code)));
    const hinted = hint && cities.filter(x => [x.country, x.country_code, x.admin1]
      .some(v => v && (hint.includes(v.toLowerCase()) || v.toLowerCase().includes(hint))));
    const pool = hinted?.length ? hinted : cities;
    const best = pool.sort((a, b) => (b.population || 0) - (a.population || 0))[0];
    if (best) pick = { name: best.name, lat: best.latitude, lon: best.longitude };
  } catch { /* geocoder down: no fix */ }
  geoCache.set(key, pick);
  return pick;
}
