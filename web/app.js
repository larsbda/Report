'use strict';

const DEFAULT_LOC = { name: 'Shanghai', lat: 31.2304, lon: 121.4737 };
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
  del(k) { try { localStorage.removeItem(k); } catch { } },
};
const $ = s => document.querySelector(s);
const escHtml = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const safeUrl = u => /^https?:\/\//i.test(u || '') ? u : '#';

// ---------- crypto ----------
const fromB64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
async function decrypt(blob, pass) {
  const enc = new TextEncoder();
  const base = await crypto.subtle.importKey('raw', enc.encode(pass), 'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt: fromB64(blob.salt), iterations: blob.iter, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(blob.iv) }, key, fromB64(blob.ct));
  return JSON.parse(new TextDecoder().decode(pt));
}
async function fetchBlob() {
  const r = await fetch('data.enc.json', { cache: 'no-store' });
  if (!r.ok) throw new Error('No report data yet');
  return r.json();
}

// ---------- time helpers ----------
const fmtTime = d => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
const localDateKey = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
function ago(iso) {
  if (!iso) return '';
  const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}

// ---------- read tracking ----------
let readSet = new Set(store.get('mr-read', []));
function markRead(link) {
  readSet.add(link);
  store.set('mr-read', [...readSet].slice(-600));
}
document.addEventListener('click', e => {
  const a = e.target.closest('a[data-link]');
  if (!a) return;
  markRead(a.dataset.link);
  a.closest('li')?.classList.add('read');
});

// ---------- header ----------
function renderHeader() {
  const now = new Date();
  const h = now.getHours();
  $('#greeting').textContent = h < 5 ? 'Up late' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
  $('#today').textContent = now.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' });
}

// ---------- weather ----------
const WMO = {
  0: ['Clear', '☀️', '🌙'], 1: ['Mostly clear', '🌤️', '🌙'], 2: ['Partly cloudy', '⛅', '☁️'], 3: ['Overcast', '☁️'],
  45: ['Fog', '🌫️'], 48: ['Fog', '🌫️'], 51: ['Light drizzle', '🌦️'], 53: ['Drizzle', '🌦️'], 55: ['Heavy drizzle', '🌧️'],
  56: ['Freezing drizzle', '🌧️'], 57: ['Freezing drizzle', '🌧️'], 61: ['Light rain', '🌦️'], 63: ['Rain', '🌧️'],
  65: ['Heavy rain', '🌧️'], 66: ['Freezing rain', '🌧️'], 67: ['Freezing rain', '🌧️'], 71: ['Light snow', '🌨️'],
  73: ['Snow', '🌨️'], 75: ['Heavy snow', '❄️'], 77: ['Snow grains', '🌨️'], 80: ['Showers', '🌦️'], 81: ['Showers', '🌧️'],
  82: ['Violent showers', '⛈️'], 85: ['Snow showers', '🌨️'], 86: ['Snow showers', '❄️'], 95: ['Thunderstorm', '⛈️'],
  96: ['Thunder & hail', '⛈️'], 99: ['Thunder & hail', '⛈️'],
};
const wx = (code, isDay = 1) => { const w = WMO[code] || ['—', '🌡️']; return { text: w[0], icon: (!isDay && w[2]) || w[1] }; };
function aqiBadge(v) {
  if (v == null) return '';
  const [label, color] = v <= 50 ? ['Good', '#3a9d5d'] : v <= 100 ? ['Moderate', '#c9a227'] : v <= 150 ? ['Unhealthy (sens.)', '#e07b28']
    : v <= 200 ? ['Unhealthy', '#d0443a'] : v <= 300 ? ['Very unhealthy', '#8e3fa0'] : ['Hazardous', '#7a1f2b'];
  return `<span>AQI <span class="aqi" style="background:${color}">${Math.round(v)}</span> ${label}</span>`;
}

// Where to show weather for, in priority order:
// 1. a city picked by hand today, 2. a "📍 City" calendar event covering now, 3. the last hand-picked city, 4. Shanghai.
function activePlace(cal) {
  const t = Date.now();
  const valid = (cal?.places || []).filter(p => p.from && Date.parse(p.from) <= t && t < Date.parse(p.until));
  if (!valid.length) return null;
  // explicit "📍 City" events win; otherwise the most recently started fix (where you most recently went)
  const pinned = valid.filter(p => p.explicit);
  return (pinned.length ? pinned : valid).sort((a, b) => Date.parse(b.from) - Date.parse(a.from))[0];
}
function weatherLocation() {
  const manual = store.get('mr-loc', null);
  if (manual && store.get('mr-loc-day', null) === localDateKey(new Date())) return manual;
  const place = activePlace(DATA?.calendar);
  if (place) return { name: place.name, lat: place.lat, lon: place.lon, via: 'calendar' };
  return manual || DEFAULT_LOC;
}

async function renderWeather() {
  const loc = weatherLocation();
  const el = $('#weather');
  try {
    const q = `latitude=${loc.lat}&longitude=${loc.lon}&timezone=auto`;
    const [f, aq] = await Promise.all([
      fetch(`https://api.open-meteo.com/v1/forecast?${q}&forecast_days=2&wind_speed_unit=ms` +
        '&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m,relative_humidity_2m,is_day' +
        '&hourly=temperature_2m,weather_code,precipitation_probability,is_day' +
        '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset,uv_index_max').then(r => r.json()),
      fetch(`https://air-quality-api.open-meteo.com/v1/air-quality?${q}&current=us_aqi,pm2_5`).then(r => r.json()).catch(() => null),
    ]);
    const c = f.current, d = f.daily;
    const now = wx(c.weather_code, c.is_day);
    const start = f.hourly.time.findIndex(t => t >= c.time.slice(0, 13));
    const hours = [];
    for (let i = Math.max(0, start); i < Math.max(0, start) + 14 && i < f.hourly.time.length; i++) {
      const w = wx(f.hourly.weather_code[i], f.hourly.is_day[i]);
      const p = f.hourly.precipitation_probability[i];
      hours.push(`<div class="w-hour"><span>${f.hourly.time[i].slice(11, 13)}</span><span class="h-icon">${w.icon}</span>` +
        `<span>${Math.round(f.hourly.temperature_2m[i])}°</span><span class="h-rain">${p >= 20 ? p + '%' : ''}</span></div>`);
    }
    el.innerHTML = `
      <div class="w-main">
        <div class="w-icon">${now.icon}</div>
        <div>
          <div class="w-temp">${Math.round(c.temperature_2m)}°</div>
          <div class="w-desc">${now.text}</div>
        </div>
        <div class="w-loc"><strong>${escHtml(loc.name)}</strong>${loc.via === 'calendar' ? '<span class="w-via">from calendar</span><br>' : ''}H ${Math.round(d.temperature_2m_max[0])}° · L ${Math.round(d.temperature_2m_min[0])}°</div>
      </div>
      <div class="w-hours">${hours.join('')}</div>
      <div class="w-stats">
        <span>Feels <b>${Math.round(c.apparent_temperature)}°</b></span>
        <span>Rain <b>${d.precipitation_probability_max[0] ?? 0}%</b></span>
        <span>Wind <b>${Math.round(c.wind_speed_10m)} m/s</b></span>
        <span>UV <b>${Math.round(d.uv_index_max[0] ?? 0)}</b></span>
        <span>☀ <b>${d.sunrise[0].slice(11)}</b>–<b>${d.sunset[0].slice(11)}</b></span>
        ${aqiBadge(aq?.current?.us_aqi)}
      </div>`;
  } catch (e) {
    el.innerHTML = `<p class="muted">Weather unavailable right now.</p>`;
  }
}

async function changeLocation() {
  const name = prompt('City for weather (overrides your calendar for today):', weatherLocation().name);
  if (!name) return;
  try {
    const r = await fetch(`https://geocoding-api.open-meteo.com/v1/search?count=1&name=${encodeURIComponent(name)}`).then(r => r.json());
    const g = r.results?.[0];
    if (!g) return alert('Could not find that place.');
    store.set('mr-loc', { name: g.name, lat: g.latitude, lon: g.longitude });
    store.set('mr-loc-day', localDateKey(new Date()));
    renderWeather();
  } catch { alert('Lookup failed. Try again later.'); }
}

// ---------- calendar ----------
function renderCalendar(cal) {
  const el = $('#calendar');
  if (!cal) { el.hidden = true; return; }
  el.hidden = false;
  const now = new Date();
  const todayKey = localDateKey(now);
  const tmr = new Date(now); tmr.setDate(tmr.getDate() + 1);
  const tmrKey = localDateKey(tmr);
  const dayOf = e => e.allDay ? null : localDateKey(new Date(e.start));
  const covers = (e, key) => e.allDay ? (e.start <= key && key < e.end) : dayOf(e) === key;

  const block = (label, key, isToday) => {
    const evs = cal.events.filter(e => covers(e, key));
    if (!evs.length) return isToday ? `<p class="cal-day">${label}</p><p class="muted" style="margin:0 0 12px">Nothing scheduled.</p>` : '';
    const items = evs.map(e => {
      const past = !e.allDay && isToday && Date.parse(e.end) < now.getTime();
      const time = e.allDay ? 'All day' : fmtTime(new Date(e.start));
      return `<li class="${past ? 'past' : ''}"><span class="cal-time">${time}</span><span><span class="cal-title">${escHtml(e.title)}</span>` +
        (e.location ? `<br><span class="cal-loc">${escHtml(e.location)}</span>` : '') + `</span></li>`;
    }).join('');
    return `<p class="cal-day">${label}</p><ul class="cal-list">${items}</ul>`;
  };
  const todayCount = cal.events.filter(e => covers(e, todayKey)).length;
  $('#cal-count').textContent = todayCount ? `· ${todayCount} today` : '';
  $('#cal-body').innerHTML = (cal.ok ? '' : '<p class="muted">Calendar could not be fetched on the last update.</p>') +
    block('Today', todayKey, true) + block('Tomorrow', tmrKey, false);
}

// ---------- to do (open Apple Reminders, synced by the "Morning todos" Shortcut) ----------
// Ticks are kept on this device only; they don't complete the reminder in Apple Reminders.
const todoKey = t => (t.list || '') + '|' + t.title;
let doneSet = new Set(store.get('mr-done', []));

function renderTodos(todos) {
  const el = $('#todos');
  if (!todos) { el.hidden = true; return; }
  el.hidden = false;
  const items = todos.items || [];
  // forget ticks for reminders that are gone (completed in Reminders)
  const live = new Set(items.map(todoKey));
  doneSet = new Set([...doneSet].filter(k => live.has(k)));
  store.set('mr-done', [...doneSet]);

  const now = new Date(), today = localDateKey(now);
  const in7 = new Date(now); in7.setDate(in7.getDate() + 7);
  const week = localDateKey(in7);
  const dayOf = t => t.allDay ? t.due : localDateKey(new Date(t.due));
  const groups = { overdue: [], today: [], soon: [], later: [] }, undated = new Map();
  for (const t of items) {
    if (!t.due) { if (!undated.has(t.list)) undated.set(t.list, []); undated.get(t.list).push(t); continue; }
    const d = dayOf(t);
    (d < today ? groups.overdue : d === today ? groups.today : d <= week ? groups.soon : groups.later).push(t);
  }
  const byDue = (a, b) => (dayOf(a) + (a.allDay ? '' : a.due)).localeCompare(dayOf(b) + (b.allDay ? '' : b.due));
  Object.values(groups).forEach(g => g.sort(byDue));

  const dueLabel = t => {
    const d = dayOf(t);
    const time = t.allDay ? '' : ' ' + fmtTime(new Date(t.due));
    if (d < today) return `<span class="due-over">${new Date(d + 'T12:00').toLocaleDateString([], { day: 'numeric', month: 'short' })}${time}</span>`;
    if (d === today) return `<span class="due-today">Today${time}</span>`;
    return new Date(d + 'T12:00').toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' }) + time;
  };
  const row = (t, showList) => {
    const k = todoKey(t), done = doneSet.has(k);
    const meta = [t.due ? dueLabel(t) : '', showList && t.list ? escHtml(t.list) : '', t.notes ? escHtml(t.notes) : '']
      .filter(Boolean).join(' · ');
    return `<li><button class="todo-item${done ? ' done' : ''}" data-key="${escHtml(k)}">` +
      `<span class="todo-box">${done ? '✓' : ''}</span><span><span class="todo-title">${escHtml(t.title)}</span>` +
      (meta ? `<span class="todo-meta">${meta}</span>` : '') + `</span></button></li>`;
  };
  const section = (label, list, cls = '', showList = true) => list.length
    ? `<p class="todo-group ${cls}">${label}</p><ul class="todo-list">${list.map(t => row(t, showList)).join('')}</ul>` : '';

  let html = section('Overdue', groups.overdue, 'overdue') + section('Today', groups.today) +
    section('Next 7 days', groups.soon) + section('Later', groups.later);
  for (const [list, ts] of undated) html += section(list || 'No date', ts, '', false);
  if (!items.length) html = `<p class="muted" style="margin:0">${todos.ok ? 'Nothing open. Nice.' : 'Could not read your reminders on the last update.'}</p>`;
  $('#todo-body').innerHTML = html;

  const urgent = groups.overdue.length + groups.today.length;
  $('#todo-count').textContent = items.length ? `· ${urgent ? urgent + ' due' : items.length}` : '';
  $('#todo-synced').textContent = todos.synced ? `From Reminders, synced ${ago(todos.synced)}` : 'From Reminders';
}

document.addEventListener('click', e => {
  const b = e.target.closest('.todo-item');
  if (!b) return;
  const k = b.dataset.key;
  doneSet.has(k) ? doneSet.delete(k) : doneSet.add(k);
  store.set('mr-done', [...doneSet]);
  b.classList.toggle('done', doneSet.has(k));
  b.querySelector('.todo-box').textContent = doneSet.has(k) ? '✓' : '';
});

// ---------- collapsible sections (remembered per device) ----------
function initSections() {
  const folded = new Set(store.get('mr-folded', []));
  document.querySelectorAll('details.sec').forEach(d => {
    d.open = !folded.has(d.dataset.key);
    d.addEventListener('toggle', () => {
      d.open ? folded.delete(d.dataset.key) : folded.add(d.dataset.key);
      store.set('mr-folded', [...folded]);
    });
  });
}
initSections();

// ---------- news ----------
let DATA = null;
const TOPIC_LABEL = { economy: 'Economy', finance: 'Finance', ai: 'AI', politics: 'Politics', iphone: 'iPhone' };

function storyHtml(it, { showImage = true } = {}) {
  const src = DATA.sources.find(s => s.id === it.source);
  const wayback = it.articleCopy?.provider === 'wayback'
    && /^https:\/\/web\.archive\.org\/web\/\d{14}id_\/https:\/\/(?:www\.)?ft\.com\/content\/[a-z0-9-]+$/i.test(it.articleCopy.url)
    && it.articleCopy.url.endsWith('/' + it.link);
  const archiveIs = it.articleCopy?.provider === 'archiveis' && it.articleCopy.originalLink === it.link
    && /^https:\/\/archive\.(?:ph|is|today|li|vn|md|fo)\/(?:[a-z0-9]{5,12}|(?:\d{14}|\d{4}\.\d{2}\.\d{2}-\d{6})\/https:\/\/(?:www\.)?ft\.com\/content\/[a-z0-9-]+)$/i.test(it.articleCopy.url)
    && (/^https:\/\/archive\.[a-z]+\/[a-z0-9]{5,12}$/i.test(it.articleCopy.url) || it.articleCopy.url.endsWith('/' + it.link));
  const copy = it.source === 'ft' && (wayback || archiveIs)
    && Date.now() - Date.parse(it.articleCopy.checkedAt) >= 0
    && Date.now() - Date.parse(it.articleCopy.checkedAt) < 6 * 3600e3 ? it.articleCopy : null;
  const tick = copy ? '<span class="copy-tick" role="img" aria-label="Full archive copy checked; opens outside FT" title="Full archive copy checked; opens outside FT">✓</span>' : '';
  const chips = (it.topics || []).map(t => `<span class="chip">${TOPIC_LABEL[t] || t}</span>`).join('');
  const img = showImage && it.image ? `<img src="${escHtml(safeUrl(it.image))}" alt="" loading="lazy" referrerpolicy="no-referrer">` : '';
  return `<li class="story${readSet.has(it.link) ? ' read' : ''}">
    <a href="${escHtml(safeUrl(copy?.url || it.link))}" target="_blank" rel="noopener noreferrer" data-link="${escHtml(it.link)}">
      <div class="story-body">
        <div class="meta"><span class="src src-${it.source}">${escHtml(src?.short || it.source)}</span>${tick}<span>${ago(it.published)}</span>${chips}</div>
        <h3>${escHtml(it.title)}</h3>
        ${it.desc ? `<p>${escHtml(it.desc)}</p>` : ''}
      </div>${img}
    </a></li>`;
}

function renderNews() {
  $('#top').innerHTML = DATA.top.map(it => storyHtml(it)).join('') || '<li class="muted">No stories.</li>';
  $('#top-count').textContent = DATA.top.length ? `· ${DATA.top.length}` : '';
  const tabs = $('#source-tabs');
  let active = store.get('mr-tab', DATA.sources[0]?.id);
  if (!DATA.sources.some(s => s.id === active)) active = DATA.sources[0]?.id;
  const draw = () => {
    tabs.innerHTML = DATA.sources.map(s =>
      `<button class="tab" role="tab" aria-selected="${s.id === active}" data-id="${s.id}">${escHtml(s.short)}</button>`).join('');
    const s = DATA.sources.find(x => x.id === active);
    $('#source-list').innerHTML = !s ? '' : !s.ok ? '<li class="muted" style="padding:14px 0">Feed unavailable on last update.</li>'
      : s.items.map(it => storyHtml(it, { showImage: false })).join('') || '<li class="muted" style="padding:14px 0">Nothing more.</li>';
  };
  tabs.onclick = e => { const b = e.target.closest('.tab'); if (!b) return; active = b.dataset.id; store.set('mr-tab', active); draw(); };
  draw();
}

function renderPapers() {
  const list = DATA.papers || [];
  $('#papers-section').hidden = !list.length;
  $('#papers-count').textContent = list.length ? `· ${list.length}` : '';
  $('#papers').innerHTML = list.map(p => {
    const authors = p.authors.slice(0, 3).join(', ') + (p.authors.length > 3 ? ' et al.' : '');
    return `<li class="paper${readSet.has(p.link) ? ' read' : ''}">
      <a href="${escHtml(safeUrl(p.link))}" target="_blank" rel="noopener noreferrer" data-link="${escHtml(p.link)}">
        <div class="meta">${p.categories.map(c => `<span class="chip">${escHtml(c)}</span>`).join('')}</div>
        <h3>${escHtml(p.title)}</h3>
        <p class="authors">${escHtml(authors)}</p>
        <p>${escHtml(p.summary)}</p>
      </a></li>`;
  }).join('');
}

function renderAll() {
  renderHeader();
  renderTodos(DATA.todos);
  renderCalendar(DATA.calendar);
  renderNews();
  renderPapers();
  $('#updated').textContent = `Report updated ${ago(DATA.generated)}`;
}

// ---------- boot / lock ----------
let BLOB = null;
async function unlock(pass) {
  if (!BLOB) BLOB = await fetchBlob();
  DATA = await decrypt(BLOB, pass);   // throws on wrong passphrase
  store.set('mr-pass', pass);
  $('#lock').hidden = true;
  $('#app').hidden = false;
  renderAll();
  renderWeather();
}

function showLock(msg = '') {
  $('#app').hidden = true;
  $('#lock').hidden = false;
  $('#lock-msg').textContent = msg;
}

$('#lock-form').addEventListener('submit', async e => {
  e.preventDefault();
  const btn = e.target.querySelector('button');
  btn.disabled = true;
  try { await unlock($('#pass').value); }
  catch (err) {
    const wrong = err?.name === 'OperationError';
    showLock(wrong ? 'Wrong passphrase.' : (err.message || 'Could not load report.'));
    if (wrong) { const card = $('.lock-card'); card.classList.remove('shake'); void card.offsetWidth; card.classList.add('shake'); }
  } finally { btn.disabled = false; }
});

$('#lock-btn').addEventListener('click', () => { store.del('mr-pass'); DATA = null; $('#pass').value = ''; showLock(); });
$('#change-loc').addEventListener('click', changeLocation);
$('#refresh').addEventListener('click', async () => {
  const btn = $('#refresh');
  btn.classList.add('spin');
  try { BLOB = null; await unlock(store.get('mr-pass', '')); } catch { showLock('Please unlock again.'); }
  finally { btn.classList.remove('spin'); }
});

// Re-render relative times and refresh data when the app comes back to the foreground.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && DATA) { BLOB = null; unlock(store.get('mr-pass', '')).catch(() => {}); }
});

(async function boot() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  const pass = store.get('mr-pass', null);
  if (!pass) return showLock();
  try { await unlock(pass); } catch (err) { showLock(err?.name === 'OperationError' ? 'Passphrase changed — unlock again.' : (err.message || '')); }
})();
