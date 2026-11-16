import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { isFullArticle, findArticleCopy, checkArticleCopies } from './article-copies.mjs';

const story = { source: 'ft', link: 'https://www.ft.com/content/1234-abcd', title: 'An example financial report' };
const body = Array.from({ length: 240 }, (_, i) => `word${i}`).join(' ');
const metadata = { '@type': 'NewsArticle', mainEntityOfPage: story.link, headline: story.title, articleBody: body, wordCount: 240 };
const page = (visible = body, meta = metadata) => `<script type="application/ld+json">${JSON.stringify(meta)}</script><article><p>${visible}</p></article>`;
const archiveUrl = `https://web.archive.org/web/20261116010000id_/${story.link}`;
const now = Date.parse('2026-11-16T01:00:00Z');
const fetcher = async url => url.startsWith('https://archive.org/wayback/available?')
  ? { ok: true, json: async () => ({ archived_snapshots: { closest: { available: true, status: '200', url: archiveUrl } } }) }
  : { ok: true, url: archiveUrl, headers: new Headers({ 'content-type': 'text/html' }), text: async () => page() };

test('requires the complete matching article, not a capture status or teaser', () => {
  assert.equal(isFullArticle(page(), story), true);
  for (const html of [
    page(body.slice(0, 200)),
    page('', { ...metadata, articleBody: undefined }),
    page(body, { ...metadata, wordCount: 1000 }),
    page(body, { ...metadata, headline: 'Different story' }),
    page(body, { ...metadata, mainEntityOfPage: 'https://www.ft.com/content/other' }),
    page(body).replace('<article>', '<article hidden>'),
    page(body).replace('<p>', '<p style="display:none">'),
    `<script type="application/ld+json">${JSON.stringify(metadata)}</script><p>Subscribe to read</p>`,
  ]) assert.equal(isFullArticle(html, story), false);
});

test('only returns an exact checked archive target; fails closed on errors', async () => {
  assert.deepEqual(await findArticleCopy(story, { fetcher, now }), { url: archiveUrl, checkedAt: new Date(now).toISOString(), provider: 'wayback' });
  assert.equal(await findArticleCopy(story, { fetcher: async () => { throw new Error('timeout'); } }), null);
  assert.equal(await findArticleCopy(story, { fetcher: async url => {
    const r = await fetcher(url);
    return r.text ? { ...r, url: 'https://example.org/login' } : r;
  } }), null);
  assert.equal(await findArticleCopy({ ...story, source: 'nrk' }, { fetcher: () => { throw new Error('should not fetch'); } }), null);
});

test('checks duplicate stories once and removes carried-forward approvals', async () => {
  const a = { ...story }, b = { ...story }, old = { ...story, link: 'https://www.ft.com/content/other', articleCopy: { url: archiveUrl } };
  const news = { top: [a], sources: [{ items: [b, old] }] };
  let lookups = 0;
  await checkArticleCopies(news, { now, fetcher: async url => {
    if (url.includes('/available?')) lookups++;
    if (url.includes('other')) throw new Error('no capture');
    return fetcher(url);
  } });
  assert.equal(lookups, 2);
  assert.deepEqual(a.articleCopy, b.articleCopy);
  assert.ok(a.articleCopy);
  assert.equal(old.articleCopy, undefined);
});

const code = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
const ctx = { DATA: { sources: [] }, TOPIC_LABEL: {}, readSet: new Set(), Date: class extends Date { static now() { return now; } },
  safeUrl: u => /^https?:\/\//i.test(u || '') ? u : '#', escHtml: s => String(s ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;'), ago: () => '' };
vm.createContext(ctx);
vm.runInContext(code.slice(code.indexOf('function storyHtml('), code.indexOf('\nfunction renderNews()')), ctx);

test('tick and destination agree; stale or invalid copies fall back to FT', () => {
  const articleCopy = { url: archiveUrl, checkedAt: new Date(now).toISOString(), provider: 'wayback' };
  const html = ctx.storyHtml({ ...story, articleCopy });
  assert.ok(html.includes('class="copy-tick"'));
  assert.ok(html.includes(`href="${archiveUrl}"`));
  assert.ok(html.includes(`data-link="${story.link}"`));
  for (const copy of [undefined, { ...articleCopy, url: 'https://example.org' },
    { ...articleCopy, url: archiveUrl.replace('1234-abcd', 'other') },
    { ...articleCopy, checkedAt: new Date(now - 6 * 3600e3).toISOString() },
    { ...articleCopy, checkedAt: 'invalid' }]) {
    const fallback = ctx.storyHtml({ ...story, articleCopy: copy });
    assert.ok(!fallback.includes('class="copy-tick"'));
    assert.ok(fallback.includes(`href="${story.link}"`));
  }
});
