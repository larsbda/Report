// Builds the site into ./dist: copies ./web and writes data.enc.json (encrypted report data).
// Env: REPORT_PASSPHRASE (required), CALENDAR_ICS_URL (optional, iCloud public calendar link).
// Never logs story/calendar content, because Action logs on a public repo are public.

import { mkdir, cp, readFile, writeFile, rm } from 'node:fs/promises';
import { webcrypto as crypto } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { FEEDS, TOPICS, NEGATIVE, LIMITS, PAPERS, CALENDAR, TODOS } from './config.mjs';
import { fetchTodos } from './todos.mjs';
import { eventsInWindow } from './ics.mjs';
import { inferPlaces } from './places.mjs';
import { checkArticleCopies } from './article-copies.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const PBKDF2_ITER = 300_000;
const UA = 'Mozilla/5.0 (compatible; MorningReport/1.0)';

// ---------- helpers ----------
async function get(url, timeout = 20000) {
  const r = await fetch(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(timeout) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.text();
}

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const decodeEntities = s => s
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
  .replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (_, e) => ENT[e]);
const clean = s => decodeEntities(decodeEntities((s || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1'))
  .replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

const tag = (block, name) => block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`))?.[1] ?? '';
const tags = (block, name) => [...block.matchAll(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'g'))].map(m => m[1]);
const normUrl = u => { try { const x = new URL(u); return x.origin + x.pathname; } catch { return u; } };
const safeUrl = u => /^https?:\/\//i.test(u) ? u : null;

const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function compile(w) {
  const cs = w.startsWith('=');
  const word = cs ? w.slice(1) : w;
  const suffix = !cs && word.length >= 5 ? '\\p{L}{0,8}' : '';
  return new RegExp(`(?<![\\p{L}\\p{N}])${esc(word).replace(/ /g, '\\s+')}${suffix}(?![\\p{L}\\p{N}])`, cs ? 'u' : 'iu');
}
const TOPIC_RX = Object.entries(TOPICS).map(([id, t]) => ({ id, label: t.label, weight: t.weight, rx: t.words.map(compile) }));
const NEG_RX = NEGATIVE.map(compile);
const hits = (rxs, text) => rxs.some(r => r.test(text));

// ---------- news ----------
function parseRss(xml) {
  return tags(xml, 'item').map((it, rank) => {
    const link = clean(tag(it, 'link')) || clean(tag(it, 'guid'));
    const img = it.match(/<media:(?:content|thumbnail)[^>]*url="([^"]+)"/)?.[1] || it.match(/<enclosure[^>]*url="([^"]+)"[^>]*type="image/)?.[1];
    const date = Date.parse(clean(tag(it, 'pubDate')) || clean(tag(it, 'dc:date')));
    return {
      title: clean(tag(it, 'title')),
      desc: clean(tag(it, 'description')).slice(0, 280),
      link: safeUrl(link),
      image: img ? safeUrl(decodeEntities(img)) : null,
      categories: tags(it, 'category').map(clean),
      published: Number.isFinite(date) ? new Date(date).toISOString() : null,
      rank,
    };
  }).filter(x => x.title && x.link);
}

function score(item, feed, now) {
  const text = item.desc + ' ' + item.categories.join(' ');
  let s = 3 * Math.exp(-item.rank / 8) + feed.boost;   // editors' ordering
  const topics = [];
  for (const t of TOPIC_RX) {
    if (hits(t.rx, item.title)) { s += 2 * t.weight; topics.push(t.id); }
    else if (hits(t.rx, text)) { s += 1 * t.weight; topics.push(t.id); }
  }
  if (hits(NEG_RX, item.title + ' ' + text)) s -= 2.5;
  if (item.published) {
    const ageH = (now - Date.parse(item.published)) / 3600e3;
    s -= ageH > 36 ? 3 : Math.max(0, ageH) * 0.05;
  }
  return { score: Math.round(s * 100) / 100, topics };
}

async function buildNews(now) {
  const sources = [];
  for (const feed of FEEDS) {
    const byUrl = new Map();
    let ok = 0;
    for (const url of feed.urls) {
      try {
        for (const it of parseRss(await get(url))) {
          const key = normUrl(it.link);
          const prev = byUrl.get(key);
          if (!prev || it.rank < prev.rank) byUrl.set(key, { ...it, link: key });
        }
        ok++;
      } catch (e) {
        console.warn(`feed failed: ${feed.id} ${url} (${e.message})`);
      }
    }
    const items = [...byUrl.values()]
      .map(it => ({ ...it, ...score(it, feed, now), source: feed.id }))
      .sort((a, b) => b.score - a.score)
      .map(({ rank, categories, ...it }) => it);
    console.log(`${feed.id}: ${items.length} items from ${ok}/${feed.urls.length} feeds`);
    sources.push({ id: feed.id, name: feed.name, short: feed.short, ok: ok > 0, items: items.slice(0, LIMITS.perSource), all: items });
  }

  const pool = sources.filter(s => s.ok).flatMap(s => s.all).sort((a, b) => b.score - a.score);
  const perSource = {}, top = [], seenTitles = [];
  for (const it of pool) {
    if (top.length >= LIMITS.top) break;
    if ((perSource[it.source] ||= 0) >= LIMITS.topPerSource) continue;
    if (!dedupe([it], seenTitles).length) continue;
    perSource[it.source]++; top.push(it);
  }
  // per-source lists skip anything already in Top (or a near-duplicate of it)
  for (const s of sources) {
    s.items = dedupe(s.all, [...seenTitles]).slice(0, LIMITS.perSource);
    delete s.all;
  }
  return { top, sources };
}

// ---------- papers ----------
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function arxiv(q, max) {
  const url = `https://export.arxiv.org/api/query?search_query=${encodeURIComponent(q)}&sortBy=submittedDate&sortOrder=descending&max_results=${max}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    try { return await get(url, 60000); }
    catch (e) { console.warn(`arxiv attempt ${attempt + 1} failed (${e.message})`); await sleep(8000 * (attempt + 1)); }
  }
  return null;
}

async function buildPapers() {
  const entries = new Map();
  let ok = 0;
  for (const [i, { q, max }] of PAPERS.queries.entries()) {
    if (i) await sleep(3500);
    const xml = await arxiv(q, max);
    if (!xml) continue;
    ok++;
    for (const e of tags(xml, 'entry')) entries.set(clean(tag(e, 'id')).replace(/v\d+$/, ''), e);
  }
  if (!ok) { console.warn('arxiv failed'); return null; }
  {
    const wordRx = PAPERS.words.map(compile);
    const cutoff = Date.now() - PAPERS.maxAgeDays * 864e5;
    const papers = [...entries.values()].map(e => {
      const title = clean(tag(e, 'title'));
      const abstract = clean(tag(e, 'summary'));
      const cats = [...e.matchAll(/<category[^>]*term="([^"]+)"/g)].map(m => m[1]);
      const id = clean(tag(e, 'id'));
      let s = 0;
      for (const r of wordRx) { if (r.test(title)) s += 2; else if (r.test(abstract)) s += 0.7; }
      for (const t of TOPIC_RX) if (hits(t.rx, title)) s += 1;
      const hasCs = cats.some(c => c.startsWith('cs.')), hasEcon = cats.some(c => /^(econ|q-fin)\./.test(c));
      if (hasCs && hasEcon) s += 3;        // AI x economics/finance crossover is the sweet spot
      else if (hasEcon) s += 1;
      const sentences = abstract.match(/[^.!?]+[.!?]+/g) || [abstract];
      let summary = '';
      for (const sen of sentences) { if ((summary + sen).length > 340 && summary) break; summary += sen; }
      return {
        title, summary: summary.trim(), score: Math.round(s * 10) / 10,
        authors: tags(e, 'name').map(clean),
        categories: cats.filter(c => /^(cs|econ|q-fin|stat)\./.test(c)).slice(0, 4),
        link: safeUrl(id.replace(/^http:/, 'https:').replace(/v\d+$/, '')),
        published: clean(tag(e, 'published')),
      };
    }).filter(p => p.title && p.link && !(Date.parse(p.published) < cutoff));
    papers.sort((a, b) => b.score - a.score);
    console.log(`arxiv: ${papers.length} papers scanned from ${ok}/${PAPERS.queries.length} queries`);
    return papers.slice(0, PAPERS.pick);
  }
}

// Titles sharing most of their distinctive words are the same story (also catches DN's "FT:" re-runs).
const tokens = s => new Set(s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(w => w.length >= 4));
function sameStory(a, b) {
  let n = 0;
  for (const w of a) if (b.has(w)) n++;
  return n >= 3 && n / Math.min(a.size, b.size) >= 0.5;
}
function dedupe(items, seen = []) {
  const out = [];
  for (const it of items) {
    const t = tokens(it.title);
    if (seen.some(s => sameStory(s, t))) continue;
    seen.push(t); out.push(it);
  }
  return out;
}

// ---------- calendar ----------
async function buildCalendar(now) {
  const url = process.env.CALENDAR_ICS_URL?.trim();
  if (!url) return null;
  const urls = url.split(/[\s,]+/).filter(Boolean).map(u => u.replace(/^webcal:/i, 'https:'));
  const events = [], recent = [];
  let ok = 0;
  for (const u of urls) {
    try {
      const ics = await get(u);
      events.push(...eventsInWindow(ics, { now, ...CALENDAR }));
      // wider look-back for working out where you are (you're still in Kunming the morning after the last Kunming event)
      recent.push(...eventsInWindow(ics, { now, ...CALENDAR, pastHours: 48 }));
      ok++;
    } catch (e) { console.warn(`calendar feed failed (${e.message})`); }   // don't log the URL: it's a secret
  }
  events.sort((a, b) => (a.allDay === b.allDay ? 0 : a.allDay ? -1 : 1) || a.start.localeCompare(b.start));

  const places = await inferPlaces(recent);
  const agenda = events.filter(e => !CALENDAR.placePattern.test(e.title));
  console.log(`calendar: ${agenda.length} events, ${places.length} location fixes from ${ok}/${urls.length} calendars`);
  return { ok: ok > 0, events: agenda, places };
}

// ---------- to do (Apple Reminders via an iPhone Shortcut -> secret gist) ----------
async function buildTodos() {
  const id = process.env.TODOS_GIST_ID?.trim();
  if (!id) return null;
  try {
    const t = await fetchTodos(id, { excludeLists: TODOS.excludeLists, token: process.env.GITHUB_TOKEN,
      owner: process.env.GITHUB_REPOSITORY_OWNER || 'larsbda' });
    console.log(`todos: ${t.items.length} open reminders (${t.via})`);   // count only: logs are public
    return { ok: true, ...t };
  } catch (e) {
    console.warn(`todos failed (${e.message})`);   // status codes only, never the gist ID
    return { ok: false, synced: null, items: [], error: e.message };
  }
}

// ---------- crypto ----------
const b64 = u8 => Buffer.from(u8).toString('base64');
async function encrypt(obj, pass) {
  const enc = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const base = await crypto.subtle.importKey('raw', enc.encode(pass), 'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: PBKDF2_ITER, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(obj)));
  return { v: 1, iter: PBKDF2_ITER, salt: b64(salt), iv: b64(iv), ct: b64(new Uint8Array(ct)) };
}

// ---------- main ----------
const pass = process.env.REPORT_PASSPHRASE;
if (!pass) { console.error('REPORT_PASSPHRASE is not set; refusing to publish unencrypted data.'); process.exit(1); }

// The currently published report, used to carry forward any section whose fetch failed this run.
async function previousReport() {
  const base = process.env.REPORT_URL?.trim();
  if (!base) return null;
  try {
    const blob = JSON.parse(await get(new URL('data.enc.json', base.endsWith('/') ? base : base + '/').href));
    const enc = new TextEncoder();
    const k = await crypto.subtle.importKey('raw', enc.encode(pass), 'PBKDF2', false, ['deriveKey']);
    const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt: Buffer.from(blob.salt, 'base64'), iterations: blob.iter, hash: 'SHA-256' },
      k, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: Buffer.from(blob.iv, 'base64') }, key, Buffer.from(blob.ct, 'base64'));
    return JSON.parse(new TextDecoder().decode(pt));
  } catch (e) {
    console.warn(`no previous report to fall back on (${e.message})`);
    return null;
  }
}

const now = Date.now();
const [news, papersNow, calendar, todosNow, prev] = await Promise.all([buildNews(now), buildPapers(), buildCalendar(now), buildTodos(), previousReport()]);
let papers = papersNow;
let todos = todosNow;
if (todos && !todos.ok && prev?.todos?.ok) { todos = { ...prev.todos, stale: true }; console.log('todos: reused previous list'); }
if (!papers) { papers = prev?.papers || []; console.log(`papers: reused ${papers.length} from previous report`); }
for (const s of news.sources) {
  const old = prev?.sources?.find(p => p.id === s.id);
  if (!s.ok && old?.ok) { s.items = old.items; s.ok = true; s.stale = true; console.log(`${s.id}: reused previous items`); }
}
await checkArticleCopies(news, { now });
const data = { generated: new Date(now).toISOString(), ...news, papers, calendar, todos };

await rm(DIST, { recursive: true, force: true });
await mkdir(DIST, { recursive: true });
await cp(path.join(ROOT, 'web'), DIST, { recursive: true });
const sw = path.join(DIST, 'sw.js');
await writeFile(sw, (await readFile(sw, 'utf8')).replace('__BUILD__', String(now)));
await writeFile(path.join(DIST, 'data.enc.json'), JSON.stringify(await encrypt(data, pass)));
await writeFile(path.join(DIST, '.nojekyll'), '');
if (process.env.WRITE_PLAINTEXT === '1') await writeFile(path.join(ROOT, 'data.debug.json'), JSON.stringify(data, null, 2));
console.log('built dist/');
