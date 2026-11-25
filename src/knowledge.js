// The club's knowledge: Lark wiki spaces the bot is a member of. For a question, the
// best-matching pages are read (cached 24 h) and given to the brain.
// Who sees which space: a DM every space; a group only the spaces GROUP_WIKIS gives it.

import { baseText } from './base.js';

const MAX_NODES = 60;
const MAX_DOCS = 4;
const DOC_CHARS = 3500;
// v3: pages carry their space id (group scoping) and type (docs and Bases), so an older cached
// index is rebuilt.
const INDEX_KEY = 'lark:wiki-index3';
const READABLE = new Set(['docx', 'bitable']);

function words(text) {
  return String(text || '').toLowerCase().match(/[a-z0-9]{3,}/g) || [];
}

// Every wiki page title (two levels deep), cached as one index.
export async function wikiIndex(lark, store, log) {
  const cached = await store.cachedPage(INDEX_KEY);
  if (cached) {
    try { return JSON.parse(cached); } catch { /* rebuild */ }
  }
  const index = [];
  // Any failed read fails the whole listing, and nothing is cached: a partial list would make
  // the missing pages look deleted (and drop them from search) for a day.
  for (const space of await lark.wikiSpaces()) {
    const top = await lark.wikiNodes(space.space_id);
    const children = await Promise.all(top.filter((n) => n.has_child).map((n) => lark.wikiNodes(space.space_id, n.node_token)));
    for (const n of [...top, ...children.flat()].slice(0, MAX_NODES)) {
      if (READABLE.has(n.obj_type)) index.push({ space: space.name, spaceId: space.space_id, type: n.obj_type, title: n.title, token: n.obj_token, node: n.node_token, edited: n.obj_edit_time || '', description: space.description || '' });
    }
  }
  log(`wiki index: ${index.length} pages`);
  await store.savePage(INDEX_KEY, JSON.stringify(index));
  return index;
}

// GROUP_WIKIS: "oc_group=space_id,oc_other=space_a|space_b". A group not listed gets no wiki.
export function groupWikis(env, chatId) {
  for (const pair of String(env?.GROUP_WIKIS || '').split(',')) {
    const [chat, spaces] = pair.split('=').map((x) => (x || '').trim());
    if (chat && spaces && chat === chatId) return spaces.split('|').map((x) => x.trim()).filter(Boolean);
  }
  return [];
}

const idList = (v) => String(v || '').split(',').map((x) => x.trim()).filter(Boolean);

// The wiki spaces a person may use in a DM (null: every space). Open spaces (OPEN_WIKIS) for
// everyone, plus the spaces of the groups they're in (GROUP_WIKIS); the owner sees every space.
// With neither setting (a fresh copy of this bot), every space, as before.
export function dmWikis(env, memberOf, owner = false) {
  if (owner || (!env?.OPEN_WIKIS && !env?.GROUP_WIKIS)) return null;
  const spaces = new Set(idList(env.OPEN_WIKIS));
  for (const chatId of memberOf) for (const s of groupWikis(env, chatId)) spaces.add(s);
  return [...spaces];
}

// The pages of these spaces only (all pages when `spaces` is null).
export function pagesIn(index, spaces) {
  if (!spaces) return index;
  const allowed = new Set(spaces);
  return index.filter((p) => allowed.has(p.spaceId));
}

export function rankPages(index, question) {
  const q = new Set(words(question));
  const scored = index.map((p, i) => ({ ...p, score: words(p.title).filter((w) => q.has(w)).length * 3 + (i < 5 ? 1 : 0) }));
  return scored.sort((a, b) => b.score - a.score).slice(0, MAX_DOCS);
}

// A wiki page's (or Base's) whole text.
export const pageText = (lark, page) => (page.type === 'bitable' ? baseText(lark, page.token) : lark.docText(page.token));

// A wiki page's whole text, cached 24 h.
async function docTextCached(lark, store, page) {
  const key = `lark:doc:${page.token}`;
  const cached = await store.cachedPage(key);
  if (cached !== null) return cached;
  const text = await pageText(lark, page).catch(() => '');
  await store.savePage(key, text);
  return text;
}

// `spaces`: only these wiki spaces (a group's own); null means every space (a DM).
export async function knowledgeFor({ lark, store, question, spaces = null, log = () => {} }) {
  const index = pagesIn(await wikiIndex(lark, store, log), spaces);
  if (index.length === 0) return [];
  const picked = rankPages(index, question);
  const texts = await Promise.all(picked.map(async (p) => (await docTextCached(lark, store, p)).slice(0, DOC_CHARS)));
  const spaceLines = [...new Set(index.map((p) => `${p.space}: ${p.description}`))];
  return [
    { title: 'Wiki spaces', text: spaceLines.join('\n') },
    ...picked.map((p, i) => ({ title: `${p.space} › ${p.title}`, text: texts[i] })).filter((d) => d.text),
  ];
}
