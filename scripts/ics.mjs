// Minimal iCalendar parser for Apple/iCloud calendar feeds.
// Supports: TZID / UTC / floating / all-day times, DURATION, EXDATE, RECURRENCE-ID overrides,
// STATUS:CANCELLED, and RRULE with FREQ=DAILY|WEEKLY|MONTHLY|YEARLY, INTERVAL, COUNT, UNTIL,
// BYDAY (weekly days, or monthly "2TU" / "-1FR" style).

const DAY = 864e5;
const WD = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

export function parseICS(text) {
  const lines = text.replace(/\r\n?/g, '\n').replace(/\n[ \t]/g, '').split('\n');
  const events = [];
  let cur = null, depth = 0;
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') { cur = {}; depth = 0; continue; }
    if (line === 'END:VEVENT') { if (cur) events.push(cur); cur = null; continue; }
    if (!cur) continue;
    if (line.startsWith('BEGIN:')) { depth++; continue; }   // e.g. VALARM inside the event
    if (line.startsWith('END:')) { depth--; continue; }
    if (depth > 0) continue;
    const m = line.match(/^([A-Z0-9-]+)((?:;(?:[^:"]|"[^"]*")*)?):(.*)$/);
    if (!m) continue;
    const params = {};
    for (const p of m[2].split(';').slice(1)) {
      const i = p.indexOf('=');
      if (i > 0) params[p.slice(0, i)] = p.slice(i + 1).replace(/^"|"$/g, '');
    }
    (cur[m[1]] ??= []).push({ value: m[3], params });
  }
  return events;
}

const unescapeText = (s = '') => s.replace(/\\n/gi, ' ').replace(/\\([,;\\])/g, '$1').trim();

function parseDT(p, defTz) {
  const m = p.value.trim().match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, z] = m;
  if (h === undefined) return { allDay: true, wall: Date.UTC(+y, +mo - 1, +d) };
  return { allDay: false, wall: Date.UTC(+y, +mo - 1, +d, +h, +mi, +s), tz: z ? 'UTC' : (p.params.TZID || defTz) };
}

const fmtCache = new Map();
function tzOffset(ts, tz) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit',
      day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    fmtCache.set(tz, f);
  }
  const p = Object.fromEntries(f.formatToParts(new Date(ts)).map(x => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(ts / 1000) * 1000;
}

function wallToUtc(wall, tz) {
  if (tz === 'UTC') return wall;
  try {
    const guess = wall - tzOffset(wall, tz);
    return wall - tzOffset(guess, tz);
  } catch {
    return wall; // unknown TZID (e.g. Windows names): treat as UTC rather than crash
  }
}

function parseDuration(v) {
  const m = v.match(/^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
  if (!m) return 0;
  const [, sign, w, d, h, mi, s] = m.map(x => x ?? 0);
  return (sign === '-' ? -1 : 1) * ((+w * 7 + +d) * DAY + (+h * 3600 + +mi * 60 + +s) * 1000);
}

// nth weekday (n may be negative = from end) of the month containing wall time `w`, keeping its time of day.
function nthWeekday(year, month, n, wd, timeOfDay) {
  if (n > 0) {
    const first = new Date(Date.UTC(year, month, 1)).getUTCDay();
    const day = 1 + ((wd - first + 7) % 7) + (n - 1) * 7;
    const t = Date.UTC(year, month, day);
    return new Date(t).getUTCMonth() === month ? t + timeOfDay : null;
  }
  const lastDate = new Date(Date.UTC(year, month + 1, 0));
  const day = lastDate.getUTCDate() - ((lastDate.getUTCDay() - wd + 7) % 7) + (n + 1) * 7;
  return day >= 1 ? Date.UTC(year, month, day) + timeOfDay : null;
}

function* candidates(startWall, rr) {
  const interval = Math.max(1, +(rr.INTERVAL || 1));
  const byday = rr.BYDAY ? rr.BYDAY.split(',').map(x => {
    const m = x.match(/^([+-]?\d+)?([A-Z]{2})$/);
    return m ? { n: m[1] ? +m[1] : 0, wd: WD.indexOf(m[2]) } : null;
  }).filter(Boolean) : null;
  const s = new Date(startWall);
  const tod = startWall - Date.UTC(s.getUTCFullYear(), s.getUTCMonth(), s.getUTCDate());

  if (rr.FREQ === 'DAILY') {
    for (let i = 0; ; i++) yield startWall + i * interval * DAY;
  } else if (rr.FREQ === 'WEEKLY') {
    if (!byday) { for (let i = 0; ; i++) yield startWall + i * interval * 7 * DAY; }
    const monIdx = (s.getUTCDay() + 6) % 7;
    const days = new Set(byday.map(b => b.wd));
    for (let i = 0; ; i++) {
      const w = startWall + i * DAY;
      if (Math.floor((i + monIdx) / 7) % interval === 0 && days.has(new Date(w).getUTCDay())) yield w;
      else yield null; // keep the consumer's "past the window?" check ticking
    }
  } else if (rr.FREQ === 'MONTHLY') {
    for (let i = 0; ; i++) {
      const y = s.getUTCFullYear(), mo = s.getUTCMonth() + i * interval;
      const yy = y + Math.floor(mo / 12), mm = ((mo % 12) + 12) % 12;
      if (byday && byday.some(b => b.n)) {
        const hits = byday.map(b => nthWeekday(yy, mm, b.n || 1, b.wd, tod)).filter(Boolean).sort((a, b) => a - b);
        yield* hits.filter(h => h >= startWall);
        if (!hits.length) yield null;
      } else {
        const t = Date.UTC(yy, mm, s.getUTCDate()) + tod;
        yield new Date(t).getUTCDate() === s.getUTCDate() ? t : null;
      }
    }
  } else if (rr.FREQ === 'YEARLY') {
    for (let i = 0; ; i++) {
      const t = Date.UTC(s.getUTCFullYear() + i * interval, s.getUTCMonth(), s.getUTCDate()) + tod;
      yield new Date(t).getUTCDate() === s.getUTCDate() ? t : null;
    }
  } else {
    yield startWall;
  }
}

const isoDate = w => new Date(w).toISOString().slice(0, 10);

export function eventsInWindow(icsText, { now = Date.now(), pastHours = 12, futureHours = 60, defaultTz = 'UTC' } = {}) {
  const from = now - pastHours * 3600e3, to = now + futureHours * 3600e3;
  const raw = parseICS(icsText);

  // Instances that have been moved/edited are separate VEVENTs with RECURRENCE-ID.
  const overridden = new Set();
  for (const ev of raw) {
    if (!ev['RECURRENCE-ID'] || !ev.UID) continue;
    const r = parseDT(ev['RECURRENCE-ID'][0], defaultTz);
    if (r) overridden.add(ev.UID[0].value + '|' + (r.allDay ? r.wall : wallToUtc(r.wall, r.tz)));
  }

  const out = [];
  for (const ev of raw) {
    if (!ev.DTSTART || ev.STATUS?.[0].value === 'CANCELLED') continue;
    const st = parseDT(ev.DTSTART[0], defaultTz);
    if (!st) continue;
    const toInstant = w => (st.allDay ? w : wallToUtc(w, st.tz));

    let dur = st.allDay ? DAY : 0;
    if (ev.DTEND) { const en = parseDT(ev.DTEND[0], defaultTz); if (en) dur = toInstantOf(en) - toInstant(st.wall); }
    else if (ev.DURATION) dur = parseDuration(ev.DURATION[0].value);

    const ex = new Set();
    for (const p of ev.EXDATE || []) {
      for (const v of p.value.split(',')) {
        const d = parseDT({ value: v, params: p.params }, defaultTz);
        if (d) ex.add(toInstantOf(d));
      }
    }

    const uid = ev.UID?.[0].value;
    const rr = ev.RRULE && !ev['RECURRENCE-ID']
      ? Object.fromEntries(ev.RRULE[0].value.split(';').map(x => x.split('=')))
      : null;
    const count = rr?.COUNT ? +rr.COUNT : Infinity;
    let until = Infinity;
    if (rr?.UNTIL) { const u = parseDT({ value: rr.UNTIL, params: {} }, st.tz || defaultTz); if (u) until = u.allDay ? u.wall + DAY - 1 : wallToUtc(u.wall, u.tz); }

    const gen = rr ? candidates(st.wall, rr) : [st.wall][Symbol.iterator]();
    let n = 0, guard = 0;
    for (const w of gen) {
      if (++guard > 60000) break;
      if (w === null) continue;
      const inst = toInstant(w);
      if (inst > until || n >= count || inst > to) break;
      n++;
      if (ex.has(inst) || (uid && overridden.has(uid + '|' + inst))) continue;
      if (inst + dur <= from) continue;
      out.push({
        title: unescapeText(ev.SUMMARY?.[0].value) || '(no title)',
        location: unescapeText(ev.LOCATION?.[0].value) || '',
        allDay: st.allDay,
        start: st.allDay ? isoDate(w) : new Date(inst).toISOString(),
        end: st.allDay ? isoDate(w + Math.max(dur, DAY)) : new Date(inst + dur).toISOString(),
        sort: inst,
      });
    }
  }
  out.sort((a, b) => a.sort - b.sort);
  return out.map(({ sort, ...e }) => e);
}

function toInstantOf(d) { return d.allDay ? d.wall : wallToUtc(d.wall, d.tz); }
