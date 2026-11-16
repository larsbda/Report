// Reads open Apple Reminders that an iPhone Shortcut writes to a secret GitHub gist (file "todos.json").
// The Shortcut's text output varies by iOS version, so this accepts any of:
//   a JSON array of items, {"items": [...]}, or a header line followed by one JSON object per reminder.
// Item keys are matched loosely: title/Title/name, list/List, due/Due Date, notes/Notes.

const UA = 'Mozilla/5.0 (compatible; MorningReport/1.0)';

// Pull every top-level {...} object out of a string, ignoring anything between them.
function jsonObjects(text) {
  const out = [];
  let depth = 0, start = -1, inStr = false, escp = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) { if (escp) escp = false; else if (c === '\\') escp = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === '{') { if (depth++ === 0) start = i; }
    else if (c === '}' && depth > 0 && --depth === 0) {
      try { out.push(JSON.parse(text.slice(start, i + 1))); } catch { /* skip malformed */ }
    }
  }
  return out;
}

const pick = (o, ...keys) => {
  for (const k of keys) {
    const hit = Object.keys(o).find(x => x.toLowerCase().replace(/[\s_]/g, '') === k);
    if (hit !== undefined && o[hit] !== null && o[hit] !== '') return o[hit];
  }
  return undefined;
};

// "2026-11-18T00:00:00+08:00" -> all-day "2026-11-18"; a real time stays a full ISO timestamp.
function normDue(v) {
  if (v === undefined) return { due: null, allDay: false };
  const s = String(v).trim();
  const m = s.match(/^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (m) {
    if (!m[2] || (m[2] === '00' && m[3] === '00')) return { due: m[1], allDay: true };
    const t = Date.parse(s);
    return Number.isFinite(t) ? { due: new Date(t).toISOString(), allDay: false } : { due: m[1], allDay: true };
  }
  const t = Date.parse(s);
  return Number.isFinite(t) ? { due: new Date(t).toISOString(), allDay: false } : { due: null, allDay: false };
}

export function parseTodos(text, { excludeLists = [] } = {}) {
  let raw = [];
  try {
    const j = JSON.parse(text);
    raw = Array.isArray(j) ? j : Array.isArray(j?.items) ? j.items
      : typeof j?.items === 'string' ? jsonObjects(j.items) : [j];
  } catch {
    raw = jsonObjects(text);
  }
  const skip = new Set(excludeLists.map(s => s.toLowerCase()));
  const seen = new Set();
  const items = [];
  for (const o of raw) {
    if (!o || typeof o !== 'object') continue;
    const title = String(pick(o, 'title', 'name') ?? '').trim();
    if (!title) continue;
    const list = String(pick(o, 'list', 'listname') ?? '').trim();
    if (skip.has(list.toLowerCase())) continue;
    const done = pick(o, 'completed', 'iscompleted');
    if (done === true || done === 'true' || done === 'Yes') continue;
    const notes = String(pick(o, 'notes', 'body') ?? '').trim();
    const key = list + '|' + title;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({ title, list, notes, ...normDue(pick(o, 'due', 'duedate')) });
  }
  return items;
}

// Accepts the bare ID, the gist address, or either with stray whitespace.
export function gistIdFrom(s) {
  const t = String(s || '').trim();
  const m = t.match(/([0-9a-f]{20,})\/?(?:#.*)?$/i);
  return m ? m[1] : t.replace(/^.*\//, '');
}

// Tries, in order: the gist API with the Action's token, the API without a token (60 calls/hour per IP,
// often used up on shared runners), and finally the raw file, which has no API limit.
export async function fetchTodos(gistInput, { excludeLists = [], token, owner = 'larsbda' } = {}) {
  const id = gistIdFrom(gistInput);
  const api = `https://api.github.com/gists/${encodeURIComponent(id)}`;
  const headers = { 'user-agent': UA, accept: 'application/vnd.github+json' };
  const attempts = [];
  const tryApi = async auth => {
    const r = await fetch(api, { headers: auth ? { ...headers, authorization: `Bearer ${auth}` } : headers, signal: AbortSignal.timeout(20000) });
    attempts.push(`api${auth ? '+token' : ''} ${r.status}`);
    if (!r.ok) return null;
    const gist = await r.json();
    const file = gist.files?.['todos.json'] || Object.values(gist.files || {})[0];
    if (!file) { attempts.push('gist has no files'); return null; }
    let text = file.content;
    if (file.truncated && file.raw_url) text = await (await fetch(file.raw_url, { headers })).text();
    return { synced: gist.updated_at || null, text };
  };
  let got = null;
  try { if (token) got = await tryApi(token); } catch (e) { attempts.push(`api+token ${e.message}`); }
  try { if (!got) got = await tryApi(null); } catch (e) { attempts.push(`api ${e.message}`); }
  if (!got) {
    try {
      const r = await fetch(`https://gist.githubusercontent.com/${owner}/${id}/raw/todos.json?t=${Date.now()}`,
        { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(20000) });
      attempts.push(`raw ${r.status}`);
      if (r.ok) got = { synced: null, text: await r.text() };
    } catch (e) { attempts.push(`raw ${e.message}`); }
  }
  if (!got) throw new Error(attempts.join(', '));
  return { synced: got.synced, via: attempts.at(-1), items: parseTodos(got.text || '', { excludeLists }) };
}
