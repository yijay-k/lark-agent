// Search, private-chat answers and joining groups. Fake Lark, fake AI, in-memory store.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeStore } from './fakes.js';
import { chunk, matchQuery, refreshIndex, searchFor } from '../src/search.js';
import { onMessage } from '../src/handlers.js';
import { isYes, wantsToJoin, joinGroup, answerCard } from '../src/join.js';

const ME = 'ou_me';
const NOW = Date.UTC(2026, 10, 18, 5, 0); // 18 Nov 2026, 1 PM in KL
const QWEN = { event_id: 'EVQ', summary: 'Qwen Conference Malaysia 2026', status: 'confirmed', start_time: { timestamp: '1795051800' }, end_time: { timestamp: '1795078800' }, location: { name: 'Kuala Lumpur' }, description: 'Register: https://luma.com/qwen\nVenue sent after approval.' };
const AISED = { event_id: 'EVA', summary: 'AiSED Opening Ceremony', status: 'confirmed', start_time: { timestamp: '1796171400' }, end_time: { timestamp: '1796175000' }, location: { name: 'SITC' }, description: 'Dress: smart casual' };
const GROUPS = [
  { chat_id: 'oc_aised', name: 'AiSED 2026', description: 'AiSED · event:EVA' },
  { chat_id: 'oc_team', name: 'Team', description: 'The core team' },
];

function lark({ members = { oc_aised: [], oc_team: [{ member_id: ME }] }, docs = { d1: 'Project 001 is about AI posters.' } } = {}) {
  const calls = [];
  return {
    calls,
    botOpenId: async () => 'ou_bot',
    listChats: async () => GROUPS,
    chatMembers: async (id) => members[id] || [],
    addMembers: async (id, ids) => { calls.push(['add', id, ids]); members[id] = [...(members[id] || []), ...ids.map((m) => ({ member_id: m }))]; return {}; },
    pinnedMessageIds: async (id) => (id === 'oc_aised' ? ['om_pin'] : []),
    getMessage: async () => ({ msg_type: 'text', body: { content: JSON.stringify({ text: 'Parking at SITC basement B2' }) } }),
    primaryCalendarId: async () => 'cal',
    listEvents: async () => [QWEN, AISED, { event_id: 'gone', status: 'cancelled' }],
    wikiSpaces: async () => [{ space_id: 'sp', name: 'AI Exploration', description: 'club wiki' }],
    wikiNodes: async () => Object.keys(docs).map((t) => ({ obj_type: 'docx', title: 'Project 001', obj_token: t, node_token: `n_${t}`, obj_edit_time: '1', has_child: false })),
    docText: async (t) => { calls.push(['doc', t]); return docs[t]; },
    react: async () => {},
    replyPost: async (id, t, md) => { calls.push(['reply', md]); return { message_id: `om_r${calls.length}` }; },
    replyCard: async (id, card) => { calls.push(['card', card]); return { message_id: `om_c${calls.length}` }; },
  };
}

// The fake AI answers with the prompt it was given, so tests can see what Eleyna was shown.
const env = { GEMINI_API_KEY: '', TIMEZONE: 'Asia/Kuala_Lumpur', AI: { run: async (model, { messages }) => ({ response: messages[1].content }) } };
const page = async () => ({ ok: true, headers: { get: () => 'text/html' }, text: async () => '<p>Register to see address</p><p>9:30am - 5:00pm</p>' });
const dm = (text, id = `om_${Math.random()}`) => ({ sender: { sender_type: 'user', sender_id: { open_id: ME } }, message: { message_id: id, chat_id: 'oc_dm', chat_type: 'p2p', message_type: 'text', content: JSON.stringify({ text }), create_time: String(Date.now()) } });

// The part of the prompt Eleyna was given for this message (before the chat history).
const contextOf = (prompt) => prompt.split('### CHAT SO FAR')[0];
const lastReply = (l) => l.calls.filter((c) => c[0] === 'reply').at(-1)[1];

async function ready(l = lark()) {
  const store = fakeStore();
  await store.markBriefed('onboard', ME); // already welcomed
  await refreshIndex({ env, lark: l, store, now: NOW });
  return { store, l };
}

test('chunks keep paragraphs together up to the size; queries skip filler words', () => {
  assert.deepEqual(chunk('a\nb\nc', 3), ['a\nb', 'c']);
  assert.equal(chunk('x'.repeat(10), 4).length, 3);
  assert.equal(matchQuery('is there a map of the Qwen conference?'), '"map" OR "qwen" OR "conference"');
  assert.equal(matchQuery('yeah ok'), '');
});

test('the index holds events (with their group), groups, pins and wiki sections; an unedited page is not re-read', async () => {
  const { store, l } = await ready();
  const event = store.index.find((r) => r.ref === 'EVA');
  assert.equal(event.chat_id, 'oc_aised');
  assert.equal(store.index.find((r) => r.ref === 'EVQ').chat_id, '');
  assert.equal(store.index.some((r) => r.ref === 'gone'), false);
  assert.equal(store.index.find((r) => r.kind === 'group' && r.ref === 'oc_aised').body.includes('AiSED Opening Ceremony'), true);
  assert.equal(store.index.find((r) => r.kind === 'pin').body, 'Parking at SITC basement B2');
  assert.equal(store.index.find((r) => r.kind === 'doc').title, 'AI Exploration › Project 001');
  await refreshIndex({ env, lark: l, store, now: NOW });
  assert.equal(l.calls.filter((c) => c[0] === 'doc').length, 1);
});

test('a group\'s chat and pins are found only by its members; events and the wiki by everyone', async () => {
  const { store } = await ready();
  await store.indexAdd('chat', 'om_x', { chatId: 'oc_aised', body: 'parking is free after 6' });
  const outsider = await searchFor({ store, question: 'parking', memberOf: new Set() });
  assert.deepEqual(outsider.map((h) => h.kind), []);
  const member = await searchFor({ store, question: 'parking', memberOf: new Set(['oc_aised']) });
  assert.deepEqual(member.map((h) => h.kind).sort(), ['chat', 'pin']);
  const anyone = await searchFor({ store, question: 'qwen project', memberOf: new Set() });
  assert.deepEqual(anyone.map((h) => h.kind).sort(), ['doc', 'event']);
});

test('in a DM, an event with no group is answered from the calendar and its page, and called club business', async () => {
  const { store, l } = await ready();
  assert.equal(await onMessage({ env, lark: l, store, event: dm('Qwen conference: is there a map or a timeline?'), log: () => {}, fetchImpl: page }), 'answered');
  const prompt = l.calls.find((c) => c[0] === 'reply')[1];
  assert.match(prompt, /\[Event\] Qwen Conference Malaysia 2026/);
  assert.match(prompt, /Register to see address/);
  assert.doesNotMatch(prompt, /JOINABLE GROUPS/);
});

test('her own replies are remembered, so a correction is read against what she said', async () => {
  const { store, l } = await ready();
  await onMessage({ env, lark: l, store, event: dm('Qwen conference timeline?'), log: () => {}, fetchImpl: page });
  assert.equal(store.messages.filter((m) => m.senderId === 'bot').length, 1);
  await onMessage({ env, lark: l, store, event: dm("But that's not under qwen conference"), log: () => {}, fetchImpl: page });
  const second = lastReply(l);
  assert.match(second, /CHAT SO FAR[\s\S]*Eleyna \(you\): /);
  assert.doesNotMatch(contextOf(second), /JOINABLE GROUPS/); // her old reply isn't searched as the question
});

test('a group they are not in is offered, never shown; "yes" adds them and sends the details', async () => {
  const { store, l } = await ready();
  await store.indexAdd('chat', 'om_secret', { chatId: 'oc_aised', body: 'AiSED secret plan for the opening' });
  await onMessage({ env, lark: l, store, event: dm('What is the AiSED opening?'), log: () => {}, fetchImpl: page });
  const offer = lastReply(l);
  assert.match(contextOf(offer), /JOINABLE GROUPS[\s\S]*AiSED 2026/);
  assert.doesNotMatch(offer, /secret plan/);
  assert.match(offer, /Reply \*\*yes\*\* and I'll add you to \*\*AiSED 2026\*\*/);
  assert.equal(await onMessage({ env, lark: l, store, event: dm('yes please'), log: () => {}, fetchImpl: page }), 'joined');
  assert.deepEqual(l.calls.find((c) => c[0] === 'add'), ['add', 'oc_aised', [ME]]);
  const details = l.calls.filter((c) => c[0] === 'reply').at(-1)[1];
  assert.match(details, /You're in \*\*AiSED 2026\*\* now/);
  assert.match(details, /AiSED Opening Ceremony/);
  assert.match(details, /openChatId=oc_aised/);
  // Now a member: the group is no longer offered and its chat is visible.
  await onMessage({ env, lark: l, store, event: dm('AiSED secret plan?'), log: () => {}, fetchImpl: page });
  const after = contextOf(lastReply(l));
  assert.doesNotMatch(after, /JOINABLE GROUPS/);
  assert.match(after, /\[Said in AiSED 2026\] AiSED secret plan for the opening/);
});

test('with the button on, the offer is a card with a Join button; "add me to ..." joins at once', async () => {
  const { store, l } = await ready();
  await onMessage({ env: { ...env, JOIN_BUTTON: 'on' }, lark: l, store, event: dm('When is the AiSED opening?'), log: () => {}, fetchImpl: page });
  const card = l.calls.find((c) => c[0] === 'card')[1];
  assert.equal(card.schema, '2.0');
  assert.deepEqual(card.body.elements[1].behaviors[0].value, { action: 'join', chat_id: 'oc_aised' });
  const { store: s2, l: l2 } = await ready();
  assert.equal(await onMessage({ env, lark: l2, store: s2, event: dm('add me to the AiSED group'), log: () => {}, fetchImpl: page }), 'joined');
});

test('joining: only groups the bot is in; a member is told so; a refusal is explained', async () => {
  const store = fakeStore();
  const l = lark({ members: { oc_aised: [{ member_id: ME }], oc_team: [] } });
  assert.equal((await joinGroup({ lark: l, store, userId: ME, chatId: 'oc_nope' })).ok, false);
  assert.equal((await joinGroup({ lark: l, store, userId: ME, chatId: 'oc_aised' })).already, true);
  const refusing = { ...l, addMembers: async () => { throw new Error('Lark 232002 no permission'); } };
  assert.match((await joinGroup({ lark: refusing, store, userId: ME, chatId: 'oc_team' })).error, /Ask EJ/);
  assert.equal(isYes('Yes please!'), true);
  assert.equal(isYes('yes but what time is it'), false);
  assert.equal(wantsToJoin('can I join?'), false);
  assert.equal(answerCard('hi', []).body.elements.length, 1);
});

test('/clear forgets the private chat', async () => {
  const { store, l } = await ready();
  await onMessage({ env, lark: l, store, event: dm('Qwen conference timeline?'), log: () => {}, fetchImpl: page });
  assert.equal(await onMessage({ env, lark: l, store, event: dm('/clear'), log: () => {}, fetchImpl: page }), 'cleared');
  assert.equal((await store.recentMessages('oc_dm')).length, 0);
});
