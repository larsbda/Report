// Only mark a copy after retrieving its body. An archive lookup or HTTP 200 alone
// says nothing about whether the capture contains the article or a paywall.
import { ARCHIVE_CANDIDATES } from './archive-candidates.mjs';

const FT_ARTICLE = /^https:\/\/(?:www\.)?ft\.com\/content\/[a-z0-9-]+$/i;
const ARCHIVE_HOSTS = new Set(['archive.ph', 'archive.is', 'archive.today', 'archive.li', 'archive.vn', 'archive.md', 'archive.fo']);

const decode = s => s.replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
  .replace(/&(amp|quot|apos|lt|gt|nbsp);/g, (_, n) => ({ amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ' })[n]);
const normalize = s => decode(s).replace(/\s+/g, ' ').trim();
const text = html => normalize(html.replace(/<[^>]*>/g, ' '));

function articleNodes(value) {
  if (!value || typeof value !== 'object') return [];
  if (Array.isArray(value)) return value.flatMap(articleNodes);
  const types = [].concat(value['@type'] || []);
  return [
    ...(types.some(t => /^(?:NewsArticle|Article|ReportageNewsArticle)$/.test(t)) ? [value] : []),
    ...Object.values(value).flatMap(v => typeof v === 'object' ? articleNodes(v) : []),
  ];
}

export function isFullArticle(html, story) {
  const nodes = [];
  for (const match of html.matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script\s*>/gi)) {
    try { nodes.push(...articleNodes(JSON.parse(match[1]))); } catch { /* incomplete metadata */ }
  }
  // Require a visible article element, excluding data scripts and common hidden
  // containers. Requiring all metadata text here rejects teaser-only captures.
  const visible = html.replace(/<(script|style|template|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<([a-z][\w-]*)\b[^>]*(?:\bhidden\b|aria-hidden\s*=\s*["']true["']|style\s*=\s*["'][^"']*(?:display\s*:\s*none|visibility\s*:\s*hidden))[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
  const bodies = [...visible.matchAll(/<article\b[^>]*>([\s\S]*?)<\/article\s*>/gi)].map(m => text(m[1]));
  return nodes.some(node => {
    const canonical = typeof node.mainEntityOfPage === 'string' ? node.mainEntityOfPage
      : node.mainEntityOfPage?.['@id'] || node.url;
    if (canonical !== story.link || normalize(node.headline || '') !== normalize(story.title)) return false;
    if (typeof node.articleBody !== 'string') return false;
    const body = normalize(node.articleBody);
    const words = body.split(/\s+/).length;
    // Short pages and missing/mismatched publisher word counts are inconclusive.
    // These strict checks intentionally miss copies rather than tick previews.
    if (words < 200 || Number(node.wordCount) !== words) return false;
    if (/subscribe to (?:read|continue)|subscription required|sign in to (?:read|continue)/i.test(body)) return false;
    return bodies.some(visibleBody => visibleBody.includes(body));
  });
}

function snapshotFor(url, original) {
  try {
    const u = new URL(url);
    const match = u.pathname.match(/^\/web\/(\d{14})(?:id_)?\/(https?:\/\/.*)$/);
    if (u.protocol !== 'https:' || u.hostname !== 'web.archive.org' || u.port || u.username || u.password || !match) return null;
    const target = new URL(match[2]);
    target.protocol = 'https:';
    if (target.href !== original) return null;
    return `https://web.archive.org/web/${match[1]}id_/${original}`;
  } catch { return null; }
}

async function get(url, fetcher, timeout) {
  const r = await fetcher(url, { signal: AbortSignal.timeout(timeout), headers: { 'user-agent': 'MorningReport/1.0' } });
  if (!r.ok) throw new Error('Copy check failed');
  return r;
}

export async function findArticleCopy(story, { fetcher = fetch, now = Date.now(), onCandidate = () => {} } = {}) {
  if (story.source !== 'ft' || !FT_ARTICLE.test(story.link)) return null;
  const archived = await findArchiveIsCopy(story, fetcher, now, onCandidate);
  if (archived) return archived;
  try {
    const lookup = await get(`https://archive.org/wayback/available?url=${encodeURIComponent(story.link)}`, fetcher, 8000);
    const snapshot = (await lookup.json()).archived_snapshots?.closest;
    if (!snapshot?.available || String(snapshot.status) !== '200') return null;
    const url = snapshotFor(snapshot.url?.replace(/^http:/, 'https:'), story.link);
    if (!url) return null;
    onCandidate({ url, originalLink: story.link, provider: 'wayback' });
    const response = await get(url, fetcher, 10000);
    if (!snapshotFor(response.url, story.link)) return null;
    if (!/text\/html/i.test(response.headers.get('content-type') || '')) return null;
    if (!isFullArticle(await response.text(), story)) return null;
    return { url, checkedAt: new Date(now).toISOString(), provider: 'wayback' };
  } catch { return null; } // Outage, timeout, challenge or unexpected HTML: no tick.
}

function archiveIsTarget(url, original) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' || !ARCHIVE_HOSTS.has(u.hostname) || u.port || u.username || u.password || u.search || u.hash) return false;
    // Snapshots may redirect to a short permalink. The article metadata must
    // independently match the original URL before either form can be approved.
    if (/^\/[a-z0-9]{5,12}$/i.test(u.pathname)) return true;
    const m = u.pathname.match(/^\/(?:\d{14}|\d{4}\.\d{2}\.\d{2}-\d{6})\/(https?:\/\/.*)$/);
    if (!m) return false;
    const target = new URL(m[1]);
    target.protocol = 'https:';
    return target.href === original;
  } catch { return false; }
}

async function findArchiveIsCopy(story, fetcher, now, onCandidate) {
  const supplied = ARCHIVE_CANDIDATES[story.link];
  if (supplied && archiveIsTarget(supplied, story.link)) {
    onCandidate({ url: supplied, originalLink: story.link, provider: 'archiveis' });
  }
  try {
    const candidate = supplied || `https://archive.ph/newest/${story.link}`;
    const response = await get(candidate, fetcher, 10000);
    if (!archiveIsTarget(response.url, story.link)) return null;
    onCandidate({ url: response.url, originalLink: story.link, provider: 'archiveis' });
    if (!/text\/html/i.test(response.headers.get('content-type') || '')) return null;
    if (!isFullArticle(await response.text(), story)) return null;
    return { url: response.url, originalLink: story.link, checkedAt: new Date(now).toISOString(), provider: 'archiveis' };
  } catch { return null; }
}

export async function checkArticleCopies(news, options) {
  const byLink = new Map();
  for (const story of [...news.top, ...news.sources.flatMap(s => s.items)]) {
    delete story.articleCopy; // Never carry a previous check into a new report.
    delete story.archiveLink;
    if (story.source !== 'ft') continue;
    if (!byLink.has(story.link)) byLink.set(story.link, []);
    byLink.get(story.link).push(story);
  }
  const queue = [...byLink.values()];
  let checked = 0;
  await Promise.all(Array.from({ length: 2 }, async () => {
    while (queue.length) {
      const stories = queue.shift();
      const copy = await findArticleCopy(stories[0], { ...options, onCandidate: candidate => {
        // Prefer the supplied/archive.ph candidate if Wayback also has a copy.
        for (const story of stories) story.archiveLink ||= candidate;
      } });
      if (copy) { for (const story of stories) story.articleCopy = copy; checked++; }
    }
  }));
  console.log(`FT: ${checked}/${byLink.size} copies passed full-body checks`);
}
