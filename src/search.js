// What Eleyna can look up, in one full-text index (D1 / SQLite FTS5, ranked by BM25):
// calendar events, wiki sections, the groups she's in, their pinned messages and group chat.
// Who sees what: events, wiki and the list of groups are open to everyone; a group's pinned
// messages, chat and memory only to its members. A DM's messages are never indexed; its memory
// facts are (kind 'memory'), visible only in that DM. Meaning search (embed.js) covers the same items.
// Filled by the cron every 6 hours with few Lark calls: a wiki page is re-read only when edited.

import { messageText, eventIdsFromDescription, findLinks, keywords, formatTime } from './text.js';
import { wikiIndex, pageText } from './knowledge.js';
import { vectorsOn, embed, nearest, upsertVectors, deleteVectors, vectorId, vectorMeta, fingerprint } from './embed.js';

const DAY_S = 86400;
const EVENTS_BACK_S = 2 * DAY_S;
const EVENTS_AHEAD_S = 180 * DAY_S;
const CHUNK_CHARS = 900;
const EVENT_CHARS = 1500;
// Cloudflare's free plan allows 50 outside calls per run; the rest of the wiki waits for the next run.
const DOC_READS_PER_RUN = 8;
const DOC_RECHECK_MS = 7 * DAY_S * 1000;
// A Base (the PR Tracker) changes all week and its edit time isn't reliable, so it is re-read on a
// timer: every 12 h costs ~5 calls × 2 a day ≈ 300 calls a month per Base.
const BASE_RECHECK_MS = 12 * 3600 * 1000;
const MAX_TERMS = 12;
// Outside calls this run may use before the index stops for now (Cloudflare free: 50 per run;
// the rest of the cron needs some). What's skipped is done on the next run.
const CALLS_FOR_INDEX = 30;
const PIN_TTL_MS = 7 * DAY_S * 1000;
const FOREVER_MS = 3650 * DAY_S * 1000;
// Hybrid ranking (reciprocal rank fusion): an item's score is the sum of 1 / (K + its rank) over
// the keyword list and the meaning list, so being near the top of either, or both, wins.
const RRF_K = 60;
// Cosine similarity (bge-m3): below MIN a meaning match is noise; at STRONG it's clearly on topic.
const VECTOR_MIN = 0.5;
const VECTOR_STRONG = 0.62;
const CANDIDATES = 30;
const PUBLIC_KINDS = Object.freeze(new Set(['event', 'doc', 'group']));
// Chat filler that would match half the index.
const SEARCH_STOPWORDS = new Set('like want know need yeah yes okay thats not but under also than then more still really gonna wanna show here which would could anything something thing things'.split(' '));

// Paragraphs packed into pieces of about `max` characters.
export function chunk(text, max = CHUNK_CHARS) {
  const pieces = [];
  let current = '';
  for (const para of String(text || '').split('\n').map((l) => l.trim()).filter(Boolean)) {
    for (let i = 0; i < para.length; i += max) {
      const part = para.slice(i, i + max);
      if (current && current.length + part.length + 1 > max) { pieces.push(current); current = ''; }
      current = current ? `${current}\n${part}` : part;
    }
  }
  return current ? [...pieces, current] : pieces;
}

// Words of the question as an FTS5 query: any word may match; rare words rank highest.
export function matchQuery(text) {
  const terms = keywords(text).filter((w) => !SEARCH_STOPWORDS.has(w)).slice(0, MAX_TERMS);
  return terms.map((t) => `"${t}"`).join(' OR ');
}

// Keeps an item's embeddings in step with its index rows; re-embeds only when the text changed.
async function syncVectors({ env, store, kind, ref, rows, log }) {
  if (!vectorsOn(env)) return;
  const mark = `vec:${kind}:${ref}`;
  const sig = fingerprint(JSON.stringify(rows.map((r) => [r.title, r.body, r.url, r.chatId])));
  const prev = (await store.kvGet(mark, FOREVER_MS).catch(() => undefined)) || { sig: '', n: 0 };
  if (prev.sig === sig) return;
  try {
    await upsertVectors(env, rows.map((r, i) => ({ id: vectorId(kind, ref, i), meta: vectorMeta(kind, ref, r) })));
    const stale = Array.from({ length: Math.max(0, prev.n - rows.length) }, (_, i) => vectorId(kind, ref, rows.length + i));
    await deleteVectors(env, stale);
    await store.kvSet(mark, { sig, n: rows.length });
  } catch (err) {
    log(`vectors ${kind} ${ref}: ${err.message}`);
  }
}

// Replaces an item in both indexes; items that no longer exist leave both.
async function put(ctx, kind, ref, rows) {
  await ctx.store.indexReplace(kind, ref, rows);
  if (kind !== 'pin') await syncVectors({ ...ctx, kind, ref, rows });
}
async function keepOnly(ctx, kind, refs) {
  const gone = (await ctx.store.indexKeepOnly(kind, refs)) || [];
  if (kind !== 'pin') for (const ref of gone) await syncVectors({ ...ctx, kind, ref, rows: [] });
  // A page that comes back later must be read again, not skipped as "unchanged".
  if (kind === 'doc') for (const ref of gone) await ctx.store.kvSet(`index:doc2:${ref}`, null);
}
const budgetLeft = (lark) => !lark.callsMade || lark.callsMade() < CALLS_FOR_INDEX;

// A pinned message's text, cached for days: pins rarely change, and the cron runs every 6 hours.
async function pinText(lark, store, messageId) {
  const k = `pin:${messageId}`;
  const hit = await store.kvGet(k, PIN_TTL_MS).catch(() => undefined);
  if (hit !== undefined) return hit;
  const m = await lark.getMessage(messageId);
  const text = m ? messageText(m.msg_type, m.body?.content) : '';
  await store.kvSet(k, text).catch(() => {});
  return text;
}

const withoutEventTags = (d) => String(d || '').replace(/event:[A-Za-z0-9_-]+/g, '').replace(/\s*·\s*$/, '').trim();

async function indexEvents(ctx, { tz, nowS, groupOfEvent }) {
  const { lark } = ctx;
  const calendarId = await lark.primaryCalendarId();
  const events = (await lark.listEvents(calendarId, nowS - EVENTS_BACK_S, nowS + EVENTS_AHEAD_S)).filter((e) => e.status !== 'cancelled' && e.summary);
  for (const e of events) {
    const start = Number(e.start_time?.timestamp);
    const where = [e.location?.name, e.location?.address].filter(Boolean).join(', ');
    const body = [`${formatTime(start, tz)} – ${formatTime(e.end_time?.timestamp, tz)}`, where && `Where: ${where}`, String(e.description || '').slice(0, EVENT_CHARS)].filter(Boolean).join('\n');
    await put(ctx, 'event', e.event_id, [{ chatId: groupOfEvent.get(e.event_id) || '', title: e.summary, body, url: findLinks(e.description)[0] || '', at: start }]);
  }
  await keepOnly(ctx, 'event', events.map((e) => e.event_id));
  return events;
}

async function indexGroups(ctx, { groups, events }) {
  const { lark } = ctx;
  let pinCount = 0;
  for (const g of groups) {
    const titles = eventIdsFromDescription(g.description).map((id) => events.find((e) => e.event_id === id)?.summary).filter(Boolean);
    const body = [withoutEventTags(g.description), titles.length ? `Events: ${titles.join('; ')}` : ''].filter(Boolean).join('\n');
    await put(ctx, 'group', g.chat_id, [{ chatId: g.chat_id, title: g.name || '', body }]);
    // A failed read keeps the pins already indexed (writing none would wipe them).
    if (!budgetLeft(lark)) continue;
    try {
      const pinIds = await lark.pinnedMessageIds(g.chat_id);
      const pins = (await Promise.all(pinIds.map((id) => pinText(lark, ctx.store, id)))).filter(Boolean);
      await put(ctx, 'pin', g.chat_id, pins.flatMap((p) => chunk(p)).map((text) => ({ chatId: g.chat_id, title: `Pinned in ${g.name}`, body: text })));
      pinCount += pins.length;
    } catch (err) {
      ctx.log(`index pins ${g.chat_id}: ${err.message}`);
    }
  }
  await keepOnly(ctx, 'group', groups.map((g) => g.chat_id));
  await keepOnly(ctx, 'pin', groups.map((g) => g.chat_id));
  return pinCount;
}

async function indexWiki(ctx, { docReads }) {
  const { env, lark, store, log } = ctx;
  const pages = await wikiIndex(lark, store, log);
  let read = 0;
  let left = 0;
  for (const p of pages) {
    // v2: pages indexed before meaning search are read once more, to get their embeddings.
    const mark = `index:doc2:${p.token}`;
    const isBase = p.type === 'bitable';
    const seen = await store.kvGet(mark, isBase ? BASE_RECHECK_MS : DOC_RECHECK_MS);
    if (isBase ? seen !== undefined && seen !== null : seen === String(p.edited)) continue;
    if (read >= docReads || !budgetLeft(lark)) { left += 1; continue; }
    read += 1;
    const text = await pageText(lark, p).catch((err) => (log(`index ${p.title}: ${err.message}`), null));
    if (text === null) continue;
    await store.savePage(`lark:doc:${p.token}`, text);
    const url = env.LARK_WEB && p.node ? `${env.LARK_WEB}/wiki/${p.node}` : '';
    await put(ctx, 'doc', p.token, chunk(text).map((body) => ({ title: `${p.space} › ${p.title}`, body, url })));
    await store.kvSet(mark, String(p.edited));
  }
  if (pages.length) await keepOnly(ctx, 'doc', pages.map((p) => p.token));
  return { read, left };
}

// One step failing (say the wiki) never stops the others.
export async function refreshIndex({ env, lark, store, log = () => {}, now = Date.now(), docReads = DOC_READS_PER_RUN }) {
  const tz = env.TIMEZONE || 'Asia/Kuala_Lumpur';
  const stats = {};
  const groups = await lark.listChats();
  const groupOfEvent = new Map(groups.flatMap((g) => eventIdsFromDescription(g.description).map((id) => [id, g.chat_id])));
  const ctx = { env, lark, store, log };
  let events = [];
  try { events = await indexEvents(ctx, { tz, nowS: Math.floor(now / 1000), groupOfEvent }); stats.events = events.length; } catch (err) { log(`index events: ${err.message}`); }
  try { stats.pins = await indexGroups(ctx, { groups, events }); stats.groups = groups.length; } catch (err) { log(`index groups: ${err.message}`); }
  try { stats.wiki = await indexWiki(ctx, { docReads }); } catch (err) { log(`index wiki: ${err.message}`); }
  try {
    if ((await store.kvGet('index:chat-backfilled', 3650 * DAY_S * 1000)) === undefined) {
      await store.backfillChat(groups.map((g) => g.chat_id));
      await store.kvSet('index:chat-backfilled', true);
      stats.backfilled = true;
    }
  } catch (err) { log(`index backfill: ${err.message}`); }
  log(`index: ${JSON.stringify(stats)}`);
  return stats;
}

// What one person may see for a question: open items for everyone, a group's own
// pinned messages, chat and memory only if they're in that group. The database filters before
// ranking (so hidden rows can't crowd out visible ones); the check here is a second guard.
export async function searchFor({ store, question, memberOf, kinds = null, docRefs = null, limit = 8, log = () => {} }) {
  const match = matchQuery(question);
  if (!match) return [];
  const rows = await store.indexSearch(match, CANDIDATES, { chats: [...memberOf], kinds, docRefs }).catch((err) => (log(`search: ${err.message}`), []));
  return rows.filter((r) => (PUBLIC_KINDS.has(r.kind) || memberOf.has(r.chat_id)) && (!kinds || kinds.includes(r.kind)) && (!docRefs || r.kind !== 'doc' || docRefs.includes(r.ref))).slice(0, limit);
}

// Merges ranked lists (reciprocal rank fusion). An item keeps whether a keyword matched it
// and its best meaning score, so callers can tell a real match from a loose one.
export function fuse(lists, limit) {
  const merged = new Map();
  for (const list of lists) {
    list.forEach((row, rank) => {
      const id = `${row.kind}|${row.ref}|${String(row.body || '').slice(0, 60)}`;
      const cur = merged.get(id) || { ...row, rrf: 0, keyword: false, meaning: 0 };
      cur.rrf += 1 / (RRF_K + rank + 1);
      if (row.score === undefined) cur.keyword = true;
      else cur.meaning = Math.max(cur.meaning, row.score);
      merged.set(id, cur);
    });
  }
  return [...merged.values()].sort((a, b) => b.rrf - a.rrf).slice(0, limit);
}

// Keyword + meaning search, merged. `allowed`: the chats whose pins, chat and memory this person
// may see (open kinds are always visible). `kinds`: only these (e.g. ['memory'] for a chat's own memory).
// `docRefs`: wiki rows only from these pages (the wikis this chat may use; null: every page).
// Keyword search filters them before ranking; meaning search after.
export async function hybridSearch({ env, store, question, allowed, kinds = null, docRefs = null, limit = 8, log = () => {} }) {
  const wanted = (k) => !kinds || kinds.includes(k);
  const pageOk = docRefs ? ((set) => (r) => r.kind !== 'doc' || set.has(r.ref))(new Set(docRefs)) : () => true;
  const visible = (r) => wanted(r.kind) && (PUBLIC_KINDS.has(r.kind) || allowed.has(r.chat_id)) && pageOk(r);
  const keyword = (await searchFor({ store, question, memberOf: allowed, kinds, docRefs, limit: CANDIDATES, log })).filter(visible);
  let meaning = [];
  let meaningOn = false;
  if (vectorsOn(env) && String(question || '').trim()) {
    try {
      const [vector] = await embed(env, [question]);
      // Two filtered lookups, so rows they can't see never take up the top places.
      const open = [...PUBLIC_KINDS].filter(wanted);
      const mine = [...allowed];
      const lists = await Promise.all([
        open.length ? nearest(env, vector, { filter: { kind: { $in: open } } }) : [],
        mine.length ? nearest(env, vector, { filter: { chat_id: { $in: mine }, ...(kinds ? { kind: { $in: kinds } } : {}) } }) : [],
      ]);
      const all = lists.flat().sort((a, b) => b.score - a.score);
      log(`meaning: ${all.slice(0, 3).map((m) => `${m.kind} ${m.score.toFixed(2)}`).join(', ') || 'nothing'}`);
      meaning = all.filter((m) => m.score >= VECTOR_MIN).filter(visible);
      meaningOn = true;
    } catch (err) {
      log(`meaning search: ${err.message}`);
    }
  }
  const hits = fuse([keyword, meaning], limit);
  return (await freshMemory(store, hits)).map((h) => ({ ...h, meaningOn }));
}

// Memory hits are read again from D1, the source of truth: a fact updated or removed since its
// vector was written shows as it is now, or not at all.
async function freshMemory(store, hits) {
  const ids = hits.filter((h) => h.kind === 'memory').map((h) => Number(h.ref));
  if (!ids.length) return hits;
  const rows = new Map((await store.memoriesByIds(ids).catch(() => [])).map((m) => [String(m.id), m]));
  const seen = new Set();
  return hits.flatMap((h) => {
    if (h.kind !== 'memory') return [h];
    const row = rows.get(String(h.ref));
    if (!row || seen.has(h.ref)) return [];
    seen.add(h.ref);
    return [{ ...h, body: row.text, chat_id: row.chat_id }];
  });
}

// A hit that shows the message is about the club: a strong meaning match, or a keyword match the
// meaning agrees with ("best pizza" matches the word "best" in a wiki page, but not its meaning).
// Without meaning search (it failed), a keyword match counts on its own.
export const isClubMatch = (h) => h.kind !== 'chat' && (h.meaning >= VECTOR_STRONG || (h.keyword && (h.meaning >= VECTOR_MIN || !h.meaningOn)));
