// Memory (the Mem0 method) and hybrid search. Fake embeddings, fake vector index, fake AI.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeStore } from './fakes.js';
import { checkPlan, foldChat, maybeFold, forgetChat, memoryReport, recentWindow, FOLD_AT } from '../src/memory.js';
import { hybridSearch, fuse, isClubMatch } from '../src/search.js';
import { parseJson } from '../src/brain.js';
import { onMessage } from '../src/handlers.js';
import { catchUpMemory } from '../src/cron.js';

const ME = 'ou_me';
const BOT = 'ou_bot';
const GROUP = 'oc_team';

// Embeddings: each word lands in one of 32 slots, so texts sharing words point the same way.
function vec(text) {
  const v = new Array(32).fill(0);
  for (const w of String(text).toLowerCase().match(/[a-z0-9]{3,}/g) || []) {
    let h = 0;
    for (const c of w) h = (h * 31 + c.charCodeAt(0)) % 32;
    v[h] += 1;
  }
  const n = Math.hypot(...v) || 1;
  return v.map((x) => x / n);
}
function fakeVectors() {
  const rows = new Map();
  return {
    rows,
    upsert: async (items) => items.forEach((it) => rows.set(it.id, it)),
    deleteByIds: async (ids) => ids.forEach((id) => rows.delete(id)),
    query: async (q, { topK = 20, filter } = {}) => ({
      matches: [...rows.values()]
        .filter((r) => !filter || Object.entries(filter).every(([k, v]) => (v && v.$in ? v.$in.includes(r.metadata[k]) : r.metadata[k] === v)))
        .map((r) => ({ id: r.id, metadata: r.metadata, score: r.values.reduce((s, x, i) => s + x * q[i], 0) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, topK),
    }),
  };
}
// The AI: embeddings for { text }, a memory plan for the memory writer, else it echoes its prompt.
function fakeAI(plan = () => ({ card: '', add: [], update: [], remove: [] })) {
  const prompts = [];
  return {
    prompts,
    run: async (model, input) => {
      if (input.text) return { data: input.text.map(vec) };
      const [system, user] = input.messages;
      prompts.push(user.content);
      if (system.content.includes('long-term memory')) return { response: '```json\n' + JSON.stringify(plan(user.content)) + '\n```' };
      return { response: user.content };
    },
  };
}
const envWith = (plan) => ({ GEMINI_API_KEY: '', TIMEZONE: 'Asia/Kuala_Lumpur', AI: fakeAI(plan), VECTORS: fakeVectors() });

function groupLark() {
  const calls = [];
  return {
    calls,
    botOpenId: async () => BOT,
    listChats: async () => [{ chat_id: GROUP, name: 'Team', description: 'core team' }],
    chatInfo: async () => ({ name: 'Team', description: 'core team' }),
    chatMembers: async () => [{ member_id: ME, name: 'EJ' }],
    pinnedMessageIds: async () => [],
    react: async () => {},
    replyPost: async (id, t, md) => { calls.push(md); return { message_id: `om_r${calls.length}` }; },
  };
}
let clock = Date.UTC(2026, 10, 18, 4, 0);
const say = (text, mention = false, chatId = GROUP, type = 'group') => ({
  sender: { sender_type: 'user', sender_id: { open_id: ME } },
  message: { message_id: `om_${(clock += 1000)}`, chat_id: chatId, chat_type: type, message_type: 'text', create_time: String(clock), content: JSON.stringify({ text }), mentions: mention ? [{ id: { open_id: BOT } }] : [] },
});

test('a plan from the AI is checked: unknown ids, fake citations and empty facts are dropped', () => {
  const plan = checkPlan({ card: 'x'.repeat(2000), add: [{ text: ' demo on  Friday ', from: ['m1', 'm99'] }, { text: '' }], update: [{ id: 5, text: 'moved' }, { id: 9, text: 'not ours' }], remove: [5, 7, 'x'] }, [5, 7], new Set(['m1']));
  assert.deepEqual(plan.add, [{ text: 'demo on Friday', from: ['m1'] }]);
  assert.deepEqual(plan.update, []); // 5 is removed, 9 isn't known
  assert.deepEqual(plan.remove, [5, 7]);
  assert.equal(plan.card.length, 800);
  assert.deepEqual(parseJson('```json\n{"a":1}\n```'), { a: 1 });
});

test('after 15 messages a group remembers: facts with sources, a card, both indexes; memory starts after them', async () => {
  const store = fakeStore();
  const env = envWith(() => ({ card: 'The core team plans the demo.', add: [{ text: '18 Nov: EJ: the demo is on Friday', from: ['m3'] }], update: [], remove: [] }));
  const lark = groupLark();
  for (let i = 1; i < FOLD_AT; i += 1) await onMessage({ env, lark, store, event: say(`message ${i} about the demo`), log: () => {} });
  assert.equal(store.memoryRows.length, 0);
  await onMessage({ env, lark, store, event: say('last one'), log: () => {} });
  assert.equal(store.memoryRows.length, 1);
  const fact = store.memoryRows[0];
  assert.equal(JSON.parse(fact.sources).length, 1);
  assert.equal(store.index.some((r) => r.kind === 'memory' && r.ref === String(fact.id)), true);
  assert.equal(env.VECTORS.rows.has(`memory:${fact.id}:0`), true);
  assert.match(await memoryReport(store, GROUP), /The core team plans the demo[\s\S]*the demo is on Friday/);
  assert.equal(await store.countSince(GROUP, Number(await store.kvGet('memory:cursor:' + GROUP))), 0);
});

test('new messages update or remove what is remembered, never duplicate it', async () => {
  const store = fakeStore();
  // The second time, the AI reads the remembered facts' ids from its prompt ("[id] text").
  const idOf = (prompt, text) => Number(prompt.match(new RegExp(`\\[(\\d+)\\] ${text}`))?.[1]);
  const env = envWith((prompt) => (prompt.includes('demo Friday')
    ? { card: 'c2', add: [], update: [{ id: idOf(prompt, 'demo Friday'), text: '19 Nov: demo moved to Monday' }], remove: [idOf(prompt, 'Tam brings')] }
    : { card: 'c1', add: [{ text: 'demo Friday' }, { text: 'Tam brings the projector' }], update: [], remove: [] }));
  const lark = groupLark();
  for (let i = 0; i < 3; i += 1) await store.saveMessage({ messageId: `a${i}`, chatId: GROUP, senderId: ME, text: 'plan', createdAt: (clock += 1000) });
  await foldChat({ env, lark, store, chatId: GROUP, isPrivate: false, today: 'today', now: clock });
  await store.saveMessage({ messageId: 'b1', chatId: GROUP, senderId: ME, text: 'demo moved to Monday, no projector needed', createdAt: (clock += 1000) });
  await foldChat({ env, lark, store, chatId: GROUP, isPrivate: false, today: 'today', now: clock + 200_000 });
  assert.deepEqual(store.memoryRows.map((m) => m.text), ['19 Nov: demo moved to Monday']);
  const kept = store.memoryRows[0].id;
  assert.deepEqual([...env.VECTORS.rows.keys()], [`memory:${kept}:0`]); // the removed fact's vector is gone
  assert.equal(env.VECTORS.rows.get(`memory:${kept}:0`).metadata.body, '19 Nov: demo moved to Monday');
});

test('two folds of the same batch at once: only one runs', async () => {
  const store = fakeStore();
  const env = envWith(() => ({ card: 'c', add: [{ text: 'a fact' }], update: [], remove: [] }));
  await store.saveMessage({ messageId: 'x', chatId: GROUP, senderId: ME, text: 'hello', createdAt: clock });
  const runs = await Promise.all([1, 2].map(() => foldChat({ env, lark: groupLark(), store, chatId: GROUP, isPrivate: false, today: 't', now: clock })));
  assert.equal(runs.filter(Boolean).length, 1);
  assert.equal(store.memoryRows.length, 1);
});

test('a group answer reads its memory and only the messages memory has not taken in', async () => {
  const store = fakeStore();
  const env = envWith(() => ({ card: 'Team chat for the demo.', add: [{ text: 'demo on Friday at 3 PM' }], update: [], remove: [] }));
  const lark = groupLark();
  for (let i = 0; i < 20; i += 1) await onMessage({ env, lark, store, event: say(`old chatter ${i}`), log: () => {} });
  await onMessage({ env, lark, store, event: say('when is the demo?', true), log: () => {} });
  const prompt = lark.calls.at(-1);
  assert.match(prompt, /CHAT MEMORY[\s\S]*Team chat for the demo\.[\s\S]*- demo on Friday at 3 PM/);
  assert.doesNotMatch(prompt, /old chatter 0\b/);
  assert.match(prompt, /old chatter 19/); // the last few are always read word for word
});

test('meaning search finds a fact with other words; a group\'s memory only for its members, a DM\'s only in it', async () => {
  const store = fakeStore();
  const env = envWith();
  const put = async (id, chatId, body) => {
    await store.applyMemory(chatId, { add: [{ id, text: body }], update: [], remove: [] }, [], 0);
    await env.VECTORS.upsert([{ id: `memory:${id}:0`, values: vec(body), metadata: { kind: 'memory', ref: String(id), chat_id: chatId, title: '', body, url: '', at: 0 } }]);
  };
  await put(1, GROUP, 'parking basement level two near lift');
  await put(2, 'oc_dm', 'likes poster typography');
  const q = 'basement parking lift';
  assert.deepEqual((await hybridSearch({ env, store, question: q, allowed: new Set([GROUP]) })).map((h) => h.ref), ['1']);
  assert.deepEqual((await hybridSearch({ env, store, question: q, allowed: new Set() })).map((h) => h.ref), []);
  assert.deepEqual((await hybridSearch({ env, store, question: 'poster typography', allowed: new Set([GROUP]) })).map((h) => h.ref), []);
  assert.deepEqual((await hybridSearch({ env, store, question: 'poster typography', allowed: new Set(['oc_dm']), focusChat: 'oc_dm' })).map((h) => h.ref), ['2']);
});

test('rank fusion: found by both lists ranks first; a loose meaning match is not proof of club business', () => {
  const a = { kind: 'doc', ref: 'a', body: 'A' };
  const b = { kind: 'doc', ref: 'b', body: 'B' };
  const fused = fuse([[b, a], [{ ...a, score: 0.9 }]], 5);
  assert.equal(fused[0].ref, 'a');
  assert.equal(fused[0].keyword && fused[0].meaning === 0.9, true);
  assert.equal(isClubMatch({ kind: 'doc', keyword: false, meaning: 0.55, meaningOn: true }), false);
  assert.equal(isClubMatch({ kind: 'doc', keyword: false, meaning: 0.7, meaningOn: true }), true);
  assert.equal(isClubMatch({ kind: 'doc', keyword: true, meaning: 0, meaningOn: true }), false); // "best pizza"
  assert.equal(isClubMatch({ kind: 'event', keyword: true, meaning: 0.52, meaningOn: true }), true); // "Alibaba this week"
  assert.equal(isClubMatch({ kind: 'doc', keyword: true, meaning: 0, meaningOn: false }), true);
  assert.equal(isClubMatch({ kind: 'chat', keyword: true, meaning: 0.9, meaningOn: true }), false);
});

test('/memory shows what she remembers; /clear in a DM forgets it everywhere', async () => {
  const store = fakeStore();
  const env = envWith(() => ({ card: 'EJ, the lead.', add: [{ text: 'EJ focuses on typography' }], update: [], remove: [] }));
  const lark = { ...groupLark(), listChats: async () => [], wikiSpaces: async () => [], wikiNodes: async () => [] };
  await store.markBriefed('onboard', ME);
  await store.saveMessage({ messageId: 'd1', chatId: 'oc_dm', senderId: ME, text: 'I want to explore typography', createdAt: clock });
  await foldChat({ env, lark, store, chatId: 'oc_dm', isPrivate: true, today: 't', now: clock });
  assert.equal(await onMessage({ env, lark, store, event: say('/memory', false, 'oc_dm', 'p2p'), log: () => {} }), 'memory');
  assert.match(lark.calls.at(-1), /EJ focuses on typography/);
  assert.equal(await onMessage({ env, lark, store, event: say('/clear', false, 'oc_dm', 'p2p'), log: () => {} }), 'cleared');
  assert.equal(store.memoryRows.length, 0);
  assert.equal([...env.VECTORS.rows.keys()].some((k) => k.startsWith('memory:')), false);
  assert.match(await memoryReport(store, 'oc_dm'), /don't remember anything/);
});

test('the cron catches up quiet chats only; waiting memory never blocks an answer', async () => {
  const store = fakeStore();
  const env = envWith(() => ({ card: 'c', add: [{ text: 'f' }], update: [], remove: [] }));
  const now = clock + 3_600_000;
  await store.saveMessage({ messageId: 'q', chatId: GROUP, senderId: ME, text: 'quiet', createdAt: clock });
  await store.saveMessage({ messageId: 'b', chatId: 'oc_busy', senderId: ME, text: 'just now', createdAt: now - 60_000 });
  assert.equal(await catchUpMemory({ env, lark: groupLark(), store, now }), 1);
  assert.equal(store.memoryRows[0].chat_id, GROUP);
  assert.equal(await maybeFold({ env, store, chatId: GROUP, startedAt: Date.now() - 20_000, lark: groupLark() }), null); // too little time left
  assert.deepEqual(recentWindow([1, 2, 3, 4, 5, 6, 7, 8].map((n) => ({ created_at: n })), 7, { tail: 3 }).map((m) => m.created_at), [6, 7, 8]);
});

test('a fact changed or removed after its vector was written shows as it is now, or not at all', async () => {
  const store = fakeStore();
  const env = envWith();
  const vecOf = (id, body) => ({ id: `memory:${id}:0`, values: vec(body), metadata: { kind: 'memory', ref: String(id), chat_id: GROUP, title: '', body, url: '', at: 0 } });
  await store.applyMemory(GROUP, { add: [{ id: 7, text: 'demo Thursday afternoon' }, { id: 8, text: 'demo room booked Thursday' }], update: [], remove: [] }, [], 0);
  await env.VECTORS.upsert([vecOf(7, 'demo Thursday afternoon'), vecOf(8, 'demo room booked Thursday')]);
  // D1 changes, the vectors don't (as when writing them failed).
  await store.applyMemory(GROUP, { add: [], update: [{ id: 7, text: 'demo moved to Friday afternoon' }], remove: [8] }, [], 1);
  const hits = await hybridSearch({ env, store, question: 'demo Thursday', allowed: new Set([GROUP]), kinds: ['memory'] });
  assert.deepEqual(hits.map((h) => h.body), ['demo moved to Friday afternoon']);
});

test('a batch no model can take in is skipped after three tries; a /clear mid-way makes the plan stale', async () => {
  const { foldChat: fold } = await import('../src/memory.js');
  const store = fakeStore();
  const failing = { GEMINI_API_KEY: '', TIMEZONE: 'Asia/Kuala_Lumpur', AI: { run: async () => ({ response: 'not json' }) } };
  await store.saveMessage({ messageId: 'z1', chatId: GROUP, senderId: ME, text: 'hello', createdAt: clock });
  for (let i = 0; i < 3; i += 1) await assert.rejects(fold({ env: failing, lark: groupLark(), store, chatId: GROUP, isPrivate: false, today: 't', now: clock + i * 200_000 }));
  assert.equal(await store.kvGet('memory:cursor:' + GROUP), 1); // skipped; the message stays searchable
  // The AI answers, but a /clear happened while it was thinking: nothing is written.
  await store.saveMessage({ messageId: 'z2', chatId: 'oc_dm', senderId: ME, text: 'I like typography', createdAt: clock });
  const slow = { ...failing, AI: { run: async () => { await store.kvSet('memory:cursor:oc_dm', 99); return { response: JSON.stringify({ card: 'x', add: [{ text: 'likes typography' }], update: [], remove: [] }) }; } } };
  assert.equal(await fold({ env: slow, lark: groupLark(), store, chatId: 'oc_dm', isPrivate: true, today: 't', now: clock }), null);
  assert.equal(store.memoryRows.length, 0);
});

test('a Join tap adds the person once; a closed group is never joined', async () => {
  const { joinFromTap } = await import('../src/join.js');
  const store = fakeStore();
  const added = [];
  const lark = { ...groupLark(), listChats: async () => [{ chat_id: 'oc_ev', name: 'Event' }, { chat_id: 'oc_core', name: 'Core' }], chatMembers: async () => [], addMembers: async (c, ids) => { added.push(c); return {}; } };
  const tap = (chatId, id) => ({ header: { event_id: id }, event: { operator: { open_id: ME }, action: { value: { action: 'join', chat_id: chatId } } } });
  const out = await joinFromTap({ env: {}, lark, store, body: tap('oc_ev', 'e1') });
  assert.equal(out.toast.type, 'success');
  assert.equal(await joinFromTap({ env: {}, lark, store, body: tap('oc_ev', 'e1') }), null); // the same tap delivered twice
  const closed = await joinFromTap({ env: { CLOSED_GROUPS: 'oc_core' }, lark, store, body: tap('oc_core', 'e2') });
  assert.equal(closed.toast.type, 'error');
  assert.deepEqual(added, ['oc_ev']);
  assert.equal(await joinFromTap({ env: {}, lark, store, body: { event: { action: { value: '{bad' } } } }), null);
});
