// Long-term memory for each chat, after Mem0 (github.com/mem0ai/mem0; see the README):
// 1. extract: new messages are turned into small facts by one AI call, in batches;
// 2. compare: the AI sees the facts already remembered that look related;
// 3. decide: each fact is added, updates an old one, or removes one that's no longer true;
// 4. retrieve: an answer loads the chat card plus only the facts that match the question.
// Facts live in D1 (`memories`), in the keyword index (`search`, kind 'memory') and in Vectorize.
// Raw messages are kept (only "/clear" in a DM deletes them): memory is a layer on top, not a replacement.

import { thinkJson } from './brain.js';
import { memorySystem, memoryPrompt } from './prompts.js';
import { hybridSearch } from './search.js';
import { vectorsOn, vectorId, vectorMeta, upsertVectors, deleteVectors } from './embed.js';
import { formatTime } from './text.js';

export const FOLD_AT = 15; // people's new messages before memory is updated
const MAX_NEW = 60;
const MAX_KNOWN = 30;
const RELATED = 10;
const CARD_CHARS = 800;
const ITEM_CHARS = 300;
const MAX_CHANGES = 20;
const LINE_CHARS = 400;
const MEANING_MESSAGES = 10; // the newest few say best what to compare with
const MAX_FACTS = 300; // per chat; Vectorize's free tier holds ~4,900 items in all
const MAX_TRIES = 3; // a batch no model can take in is skipped after this (its messages stay searchable)
const SLOT_MS = 120_000;
const FOREVER_MS = 3650 * 24 * 3600 * 1000;
// Cloudflare gives a message ~30 s in the background; memory waits if less than this is left.
const WINDOW_MS = 28_000;
const NEEDS_MS = 14_000;
const APPLY_MS = 5000;
const PENDING = 'memory:vectors-pending';

const key = (what, chatId) => `memory:${what}:${chatId}`;
const get = (store, k) => store.kvGet(k, FOREVER_MS).catch(() => undefined);

// `cursor`: the row number (seq) of the last message memory has taken in.
export async function chatMemory(store, chatId) {
  return { card: (await get(store, key('card', chatId))) || '', cursor: Number((await get(store, key('cursor', chatId))) || 0) };
}

// The facts already remembered that the new messages might change (Mem0's "similar memories"):
// the latest, plus older ones that share words with them or mean something close.
async function knownFacts(env, store, chatId, messages) {
  const recent = await store.memories(chatId, MAX_KNOWN);
  const text = messages.slice(-MEANING_MESSAGES).map((m) => m.text).join('\n');
  const related = await hybridSearch({ env, store, question: text, allowed: new Set([chatId]), kinds: ['memory'], limit: RELATED * 2 }).catch(() => []);
  const extraIds = related.map((r) => Number(r.ref)).filter((id) => !recent.some((m) => m.id === id)).slice(0, RELATED);
  return [...recent, ...(await store.memoriesByIds(extraIds))];
}

const cleanText = (t) => String(t || '').replace(/\s+/g, ' ').trim().slice(0, ITEM_CHARS);

// The AI's plan, checked: only known ids are changed, only real message labels are cited.
export function checkPlan(value, knownIds, labels) {
  const ids = new Set(knownIds);
  const cite = (from) => (Array.isArray(from) ? from.filter((l) => labels.has(l)) : []);
  const list = (x) => (Array.isArray(x) ? x : []);
  const add = list(value?.add).map((a) => ({ text: cleanText(a?.text), from: cite(a?.from) })).filter((a) => a.text).slice(0, MAX_CHANGES);
  const update = list(value?.update).map((u) => ({ id: Number(u?.id), text: cleanText(u?.text), from: cite(u?.from) })).filter((u) => ids.has(u.id) && u.text).slice(0, MAX_CHANGES);
  const remove = [...new Set(list(value?.remove).map(Number).filter((id) => ids.has(id)))].slice(0, MAX_CHANGES);
  const card = typeof value?.card === 'string' ? value.card.trim().slice(0, CARD_CHARS) : null;
  return { add, update: update.filter((u) => !remove.includes(u.id)), remove, card };
}

// Ids are made here, not by the database, so a whole update can be written in one batch.
function newId() {
  const [hi, lo] = crypto.getRandomValues(new Uint32Array(2));
  return (hi % 0x10000) * 0x100000000 + lo; // 48 bits: exact in JavaScript and in SQLite
}

// Vectors that couldn't be written are kept in a list the cron retries.
async function notePending(store, { upsert = [], remove = [] }) {
  const p = (await get(store, PENDING)) || { upsert: [], remove: [] };
  await store.kvSet(PENDING, { upsert: [...new Set([...p.upsert, ...upsert])], remove: [...new Set([...p.remove, ...remove])] }).catch(() => {});
}

async function writeVectors(env, store, chatId, facts, removedIds, log) {
  if (!vectorsOn(env)) return;
  try {
    await upsertVectors(env, facts.map((f) => ({ id: vectorId('memory', f.id), meta: vectorMeta('memory', f.id, { chatId, body: f.text, at: f.at }) })));
  } catch (err) {
    log(`memory vectors: ${err.message}`);
    await notePending(store, { upsert: facts.map((f) => f.id) });
  }
  const ids = removedIds.map((id) => vectorId('memory', id));
  await deleteVectors(env, ids).catch(async (err) => (log(`memory vectors: ${err.message}`), notePending(store, { remove: ids })));
}

// The cron: write the vectors that failed before. Facts are re-read from D1, so a fact changed or
// removed since is written as it is now (or not at all).
export async function retryPendingVectors({ env, store, log = () => {} }) {
  const p = await get(store, PENDING);
  if (!vectorsOn(env) || !p || (!p.upsert.length && !p.remove.length)) return 0;
  await store.kvSet(PENDING, { upsert: [], remove: [] });
  const rows = await store.memoriesByIds(p.upsert);
  const gone = p.upsert.filter((id) => !rows.some((r) => r.id === id)).map((id) => vectorId('memory', id));
  for (const chatId of new Set(rows.map((r) => r.chat_id))) {
    await writeVectors(env, store, chatId, rows.filter((r) => r.chat_id === chatId).map((r) => ({ id: r.id, text: r.text, at: r.updated_at })), [], log);
  }
  await deleteVectors(env, [...p.remove, ...gone]).catch(() => notePending(store, { remove: [...p.remove, ...gone] }));
  return rows.length + p.remove.length;
}

// A failed batch is counted; after MAX_TRIES it's skipped so it can't use up the AI quota forever.
async function noteFailure(store, chatId, cursor, lastSeq, log) {
  const k = key('fails', chatId);
  const f = (await get(store, k)) || {};
  const n = f.cursor === cursor ? f.n + 1 : 1;
  if (n < MAX_TRIES) return store.kvSet(k, { cursor, n });
  log(`memory ${chatId}: skipped messages ${cursor + 1}..${lastSeq} after ${n} failed tries`);
  await store.kvSet(key('cursor', chatId), lastSeq);
  return store.kvSet(k, {});
}

// Takes in the chat's new messages. Returns what changed, or null when there was nothing to do.
export async function foldChat({ env, lark, store, chatId, isPrivate, today, log = () => {}, fetchImpl = fetch, timeoutMs = 15_000, now = Date.now() }) {
  const { card, cursor } = await chatMemory(store, chatId);
  // One fold per batch: claiming it is an atomic insert-once, so two at the same moment can't both
  // run. The claim is per 2-minute slot, so a fold that crashed is retried later.
  if (!(await store.firstTime(`fold:${chatId}:${cursor}:${Math.floor(now / SLOT_MS)}`))) return null;
  const fresh = await store.messagesSince(chatId, cursor, MAX_NEW);
  if (fresh.length === 0) return null;
  const names = isPrivate ? new Map() : new Map((await lark.chatMembers(chatId).catch(() => [])).map((m) => [m.member_id, m.name]));
  const info = isPrivate ? null : await lark.chatInfo(chatId).catch(() => null);
  const about = info ? `${info.name || ''}: ${String(info.description || '').replace(/event:[A-Za-z0-9_-]+/g, '').trim()}` : '';
  const who = (m) => (m.sender_id === 'bot' ? 'Eleyna' : isPrivate ? 'Member' : names.get(m.sender_id) || m.sender_name || 'someone');
  const tz = env.TIMEZONE || 'Asia/Kuala_Lumpur';
  const lines = fresh.map((m, i) => `m${i + 1} [${formatTime(Number(m.created_at) / 1000, tz)}] ${who(m)}: ${String(m.text || '').slice(0, LINE_CHARS)}`);
  const known = await knownFacts(env, store, chatId, fresh);
  const lastSeq = Number(fresh.at(-1).seq);
  let answer;
  try {
    answer = await thinkJson(env, memorySystem(isPrivate, today), memoryPrompt(card, known, lines, about), { log, fetchImpl, timeoutMs });
  } catch (err) {
    await noteFailure(store, chatId, cursor, lastSeq, log).catch(() => {});
    throw err;
  }
  const checked = checkPlan(answer.value, known.map((m) => m.id), new Set(fresh.map((_, i) => `m${i + 1}`)));
  // Something changed while the AI was thinking (a "/clear", another fold): this plan is stale.
  if ((await chatMemory(store, chatId)).cursor !== cursor) return null;
  const sourcesOf = (from) => from.map((l) => fresh[Number(l.slice(1)) - 1]?.message_id).filter(Boolean);
  const plan = { add: checked.add.map((a) => ({ id: newId(), text: a.text, sources: sourcesOf(a.from) })), update: checked.update, remove: checked.remove };
  const kv = [[key('cursor', chatId), lastSeq], [key('fails', chatId), {}], ...(checked.card !== null ? [[key('card', chatId), checked.card]] : [])];
  await store.applyMemory(chatId, plan, kv, now);
  // Over the cap: the facts unchanged the longest go (their messages stay searchable).
  const over = (await store.memoryCount(chatId)) - MAX_FACTS;
  const trimmed = over > 0 ? await store.oldestMemoryIds(chatId, over) : [];
  if (trimmed.length) await store.applyMemory(chatId, { add: [], update: [], remove: trimmed }, [], now);
  await writeVectors(env, store, chatId, [...plan.add, ...plan.update].map((f) => ({ ...f, at: now })), [...plan.remove, ...trimmed], log);
  const result = { messages: fresh.length, added: plan.add.length, updated: plan.update.length, removed: plan.remove.length + trimmed.length, via: answer.via };
  log(`memory ${chatId}: ${JSON.stringify(result)}`);
  return result;
}

// After a message: update memory once enough new messages wait, if the time window allows.
export async function maybeFold({ env, startedAt, chatId, store, ...rest }) {
  const left = WINDOW_MS - (Date.now() - startedAt);
  if (left < NEEDS_MS || !(env.GEMINI_API_KEY || env.AI)) return null;
  const { cursor } = await chatMemory(store, chatId);
  if ((await store.countSince(chatId, cursor)) < FOLD_AT) return null;
  return foldChat({ env, store, chatId, timeoutMs: left - APPLY_MS, ...rest }).catch((err) => (rest.log?.(`memory ${chatId}: ${err.message}`), null));
}

// "/clear" in a DM: forget everything remembered about that chat (its messages are deleted too).
export async function forgetChat({ env, store, chatId, log = () => {} }) {
  const ids = await store.deleteMemoriesOf(chatId);
  await store.kvSet(key('card', chatId), '');
  await store.kvSet(key('cursor', chatId), await store.lastSeq());
  await writeVectors(env, store, chatId, [], ids, log);
  return ids.length;
}

// "/memory": what she remembers about this chat, newest first.
export async function memoryReport(store, chatId) {
  const { card } = await chatMemory(store, chatId);
  const items = await store.memories(chatId, 25);
  const total = await store.memoryCount(chatId);
  if (!card && items.length === 0) return "I don't remember anything about this chat yet. Memory starts after about 15 messages.";
  return [
    card ? `**What this chat is about**\n${card}` : '',
    items.length ? `**What I remember** (${total} ${total === 1 ? 'fact' : 'facts'}${total > items.length ? `, newest ${items.length}` : ''})\n${items.map((m) => `- ${m.text}`).join('\n')}` : '',
  ].filter(Boolean).join('\n\n');
}

const ALL_IF_AT_MOST = 12;
const RECALL = 8;

// The facts an answer needs: all of them while the chat has few, else the best matches for the question.
export async function recallFacts({ env, store, chatId, question, log = () => {} }) {
  if ((await store.memoryCount(chatId)) <= ALL_IF_AT_MOST) return (await store.memories(chatId, ALL_IF_AT_MOST)).reverse().map((m) => m.text);
  const hits = await hybridSearch({ env, store, question, allowed: new Set([chatId]), kinds: ['memory'], limit: RECALL, log });
  return hits.map((h) => h.body);
}

// The raw messages an answer still reads: those memory hasn't taken in, at least the last `tail`
// (follow-ups need the exact words), at most `max`.
export function recentWindow(messages, cursor, { tail = 6, max = 20 } = {}) {
  const unfolded = messages.filter((m) => Number(m.seq) > cursor).length;
  return messages.slice(-Math.min(max, Math.max(tail, unfolded)));
}
