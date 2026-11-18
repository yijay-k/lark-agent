// What Eleyna can look up, in one full-text index (D1 / SQLite FTS5, ranked by BM25):
// calendar events, wiki sections, the groups she's in, their pinned messages and group chat.
// Who sees what: events, wiki and the list of groups are open to everyone; a group's pinned
// messages and chat only to its members. Private chats are never indexed.
// Filled by the cron every 6 hours with few Lark calls: a wiki page is re-read only when edited.

import { messageText, eventIdsFromDescription, findLinks, keywords, formatTime } from './text.js';
import { wikiIndex } from './knowledge.js';

const DAY_S = 86400;
const EVENTS_BACK_S = 2 * DAY_S;
const EVENTS_AHEAD_S = 180 * DAY_S;
const CHUNK_CHARS = 900;
const EVENT_CHARS = 1500;
// Cloudflare's free plan allows 50 outside calls per run; the rest of the wiki waits for the next run.
const DOC_READS_PER_RUN = 8;
const DOC_RECHECK_MS = 7 * DAY_S * 1000;
const MAX_TERMS = 12;
const CANDIDATES = 30;
export const PUBLIC_KINDS = Object.freeze(new Set(['event', 'doc', 'group']));
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

const withoutEventTags = (d) => String(d || '').replace(/event:[A-Za-z0-9_-]+/g, '').replace(/\s*·\s*$/, '').trim();

async function indexEvents({ lark, store, tz, nowS, groupOfEvent }) {
  const calendarId = await lark.primaryCalendarId();
  const events = (await lark.listEvents(calendarId, nowS - EVENTS_BACK_S, nowS + EVENTS_AHEAD_S)).filter((e) => e.status !== 'cancelled' && e.summary);
  for (const e of events) {
    const start = Number(e.start_time?.timestamp);
    const where = [e.location?.name, e.location?.address].filter(Boolean).join(', ');
    const body = [`${formatTime(start, tz)} – ${formatTime(e.end_time?.timestamp, tz)}`, where && `Where: ${where}`, String(e.description || '').slice(0, EVENT_CHARS)].filter(Boolean).join('\n');
    await store.indexReplace('event', e.event_id, [{ chatId: groupOfEvent.get(e.event_id) || '', title: e.summary, body, url: findLinks(e.description)[0] || '', at: start }]);
  }
  await store.indexKeepOnly('event', events.map((e) => e.event_id));
  return events;
}

async function indexGroups({ lark, store, groups, events }) {
  let pinCount = 0;
  for (const g of groups) {
    const titles = eventIdsFromDescription(g.description).map((id) => events.find((e) => e.event_id === id)?.summary).filter(Boolean);
    const body = [withoutEventTags(g.description), titles.length ? `Events: ${titles.join('; ')}` : ''].filter(Boolean).join('\n');
    await store.indexReplace('group', g.chat_id, [{ chatId: g.chat_id, title: g.name || '', body }]);
    const pinIds = await lark.pinnedMessageIds(g.chat_id).catch(() => []);
    const pins = (await Promise.all(pinIds.map((id) => lark.getMessage(id).catch(() => null)))).filter(Boolean).map((m) => messageText(m.msg_type, m.body?.content)).filter(Boolean);
    await store.indexReplace('pin', g.chat_id, pins.flatMap((p) => chunk(p)).map((text) => ({ chatId: g.chat_id, title: `Pinned in ${g.name}`, body: text })));
    pinCount += pins.length;
  }
  await store.indexKeepOnly('group', groups.map((g) => g.chat_id));
  await store.indexKeepOnly('pin', groups.map((g) => g.chat_id));
  return pinCount;
}

async function indexWiki({ env, lark, store, log, docReads }) {
  const pages = await wikiIndex(lark, store, log);
  let read = 0;
  let left = 0;
  for (const p of pages) {
    const mark = `index:doc:${p.token}`;
    if ((await store.kvGet(mark, DOC_RECHECK_MS)) === String(p.edited)) continue;
    if (read >= docReads) { left += 1; continue; }
    read += 1;
    const text = await lark.docText(p.token).catch(() => null);
    if (text === null) continue;
    await store.savePage(`lark:doc:${p.token}`, text);
    const url = env.LARK_WEB && p.node ? `${env.LARK_WEB}/wiki/${p.node}` : '';
    await store.indexReplace('doc', p.token, chunk(text).map((body) => ({ title: `${p.space} › ${p.title}`, body, url })));
    await store.kvSet(mark, String(p.edited));
  }
  if (pages.length) await store.indexKeepOnly('doc', pages.map((p) => p.token));
  return { read, left };
}

// One step failing (say the wiki) never stops the others.
export async function refreshIndex({ env, lark, store, log = () => {}, now = Date.now(), docReads = DOC_READS_PER_RUN }) {
  const tz = env.TIMEZONE || 'Asia/Kuala_Lumpur';
  const stats = {};
  const groups = await lark.listChats();
  const groupOfEvent = new Map(groups.flatMap((g) => eventIdsFromDescription(g.description).map((id) => [id, g.chat_id])));
  let events = [];
  try { events = await indexEvents({ lark, store, tz, nowS: Math.floor(now / 1000), groupOfEvent }); stats.events = events.length; } catch (err) { log(`index events: ${err.message}`); }
  try { stats.pins = await indexGroups({ lark, store, groups, events }); stats.groups = groups.length; } catch (err) { log(`index groups: ${err.message}`); }
  try { stats.wiki = await indexWiki({ env, lark, store, log, docReads }); } catch (err) { log(`index wiki: ${err.message}`); }
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
// pinned messages and chat only if they're in that group.
export async function searchFor({ store, question, memberOf, limit = 8, log = () => {} }) {
  const match = matchQuery(question);
  if (!match) return [];
  const rows = await store.indexSearch(match, CANDIDATES).catch((err) => (log(`search: ${err.message}`), []));
  return rows.filter((r) => PUBLIC_KINDS.has(r.kind) || memberOf.has(r.chat_id)).slice(0, limit);
}
