// The owner adds people: parsed and matched in code, confirmed, then added.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeStore } from './fakes.js';
import { parseAdd, nameScore, matchName, matchGroup } from '../src/admin.js';
import { onMessage } from '../src/handlers.js';

const OWNER = 'ou_owner';
const BOT = 'ou_bot';
const QWEN = 'oc_qwen';
const PEOPLE = [
  { member_id: OWNER, name: 'Yi Jay Koh' },
  { member_id: 'ou_tam', name: 'Tam Zhao Kai' },
  { member_id: 'ou_chelsea', name: 'Chelsea Choo' },
  { member_id: 'ou_kai2', name: 'Kai Lim' },
];
const GROUPS = [
  { chat_id: 'oc_team', name: 'AI Exploration ( BASECAMP ✨)' },
  { chat_id: QWEN, name: 'Qwen Conference Malaysia 2026 | AI Exploration' },
  { chat_id: 'oc_aised', name: 'AiSED International Conference 2026 · 2 Dec' },
];

function lark(people = PEOPLE) {
  const calls = [];
  const members = { oc_team: people, [QWEN]: [{ member_id: OWNER, name: 'Yi Jay Koh' }], oc_aised: [] };
  return {
    calls,
    botOpenId: async () => BOT,
    listChats: async () => GROUPS,
    chatInfo: async (id) => GROUPS.find((g) => g.chat_id === id),
    chatMembers: async (id) => members[id] || [],
    addMembers: async (id, ids) => { calls.push(['add', id, ids]); return {}; },
    pinnedMessageIds: async () => [],
    react: async () => {},
    replyPost: async (id, t, md) => { calls.push(['reply', md]); return { message_id: `om_r${calls.length}` }; },
    wikiSpaces: async () => [],
    wikiNodes: async () => [],
  };
}
const env = { GEMINI_API_KEY: '', TIMEZONE: 'Asia/Kuala_Lumpur', OWNER_OPEN_IDS: OWNER, AI: { run: async (m, { messages }) => ({ response: 'AI answer' }) } };
let n = 0;
const msg = (text, { from = OWNER, chat = QWEN, mention = true, type = 'group' } = {}) => ({
  sender: { sender_type: 'user', sender_id: { open_id: from } },
  message: { message_id: `om_${(n += 1)}`, chat_id: chat, chat_type: type, message_type: 'text', create_time: String(Date.now() + n), content: JSON.stringify({ text }), mentions: mention ? [{ id: { open_id: BOT } }] : [] },
});
const lastReply = (l) => l.calls.filter((c) => c[0] === 'reply').at(-1)?.[1];

test('add requests are read in code: names, "here", or a group by name', () => {
  assert.deepEqual(parseAdd('ADD kai here as well'), { names: ['kai'], here: true, group: '' });
  assert.deepEqual(parseAdd('can you add kai and chelsea to the qwen group please'), { names: ['kai', 'chelsea'], here: false, group: 'qwen' });
  assert.deepEqual(parseAdd('add Tam Zhao Kai, Chelsea Choo into the AiSED chat'), { names: ['Tam Zhao Kai', 'Chelsea Choo'], here: false, group: 'AiSED' });
  assert.equal(parseAdd('what time is the opening?'), null);
});

test('names match in any order, with or without spaces, by one word or the start of one', () => {
  assert.equal(nameScore('zhao kai tam', 'Tam Zhao Kai'), 3);
  assert.equal(nameScore('ZHAOKAITAM', 'Tam Zhao Kai'), 3);
  assert.equal(nameScore('kai tam', 'Tam Zhao Kai'), 2);
  assert.equal(nameScore('chel', 'Chelsea Choo'), 1);
  assert.equal(nameScore('ka', 'Tam Zhao Kai'), 0); // too short to guess
  const people = PEOPLE.map((p) => ({ id: p.member_id, name: p.name }));
  assert.deepEqual(matchName('kai', people).map((p) => p.name), ['Tam Zhao Kai', 'Kai Lim']);
  assert.deepEqual(matchName('zhao kai tam', people).map((p) => p.name), ['Tam Zhao Kai']); // the exact one wins
  assert.equal(matchGroup('qwen', GROUPS).chat_id, QWEN);
  assert.equal(matchGroup('ai exploration', GROUPS), null); // two groups share those words
});

test('in a group: "ADD kai here" asks which Kai, then "1" (no @mention needed) adds Tam Zhao Kai', async () => {
  const store = fakeStore();
  const l = lark();
  assert.equal(await onMessage({ env, lark: l, store, event: msg('ADD kai here as well'), log: () => {} }), 'admin');
  assert.match(lastReply(l), /More than one person matches[\s\S]*1\. Tam Zhao Kai\n2\. Kai Lim/);
  assert.equal(await onMessage({ env, lark: l, store, event: msg('1', { mention: false }), log: () => {} }), 'admin');
  assert.deepEqual(l.calls.find((c) => c[0] === 'add'), ['add', QWEN, ['ou_tam']]);
  assert.match(lastReply(l), /Added \*\*Tam Zhao Kai\*\* to \*\*Qwen Conference Malaysia 2026 \| AI Exploration\*\* ✅/);
});

test('one clear match is confirmed first; "no" cancels; nothing is added without a yes', async () => {
  const store = fakeStore();
  const l = lark();
  await onMessage({ env, lark: l, store, event: msg('add zhao kai tam here'), log: () => {} });
  assert.match(lastReply(l), /Just to check: add \*\*Tam Zhao Kai\*\* to \*\*Qwen Conference/);
  await onMessage({ env, lark: l, store, event: msg('no', { mention: false }), log: () => {} });
  assert.match(lastReply(l), /won't add anyone/);
  assert.equal(await onMessage({ env, lark: l, store, event: msg('yes', { mention: false }), log: () => {} }), 'saved'); // nothing pending now
  assert.equal(l.calls.some((c) => c[0] === 'add'), false);
});

test('in the owner\'s DM: a list of people to a group by name, confirmed, then added', async () => {
  const store = fakeStore();
  await store.markBriefed('onboard', OWNER);
  const l = lark();
  const dm = (text) => msg(text, { chat: 'oc_dm', type: 'p2p', mention: false });
  await onMessage({ env, lark: l, store, event: dm('add zhaokaitam and chelsea to the qwen group'), log: () => {} });
  assert.match(lastReply(l), /add \*\*Tam Zhao Kai\*\*, \*\*Chelsea Choo\*\* to \*\*Qwen Conference/);
  assert.equal(await onMessage({ env, lark: l, store, event: dm('yes'), log: () => {} }), 'admin');
  assert.deepEqual(l.calls.find((c) => c[0] === 'add'), ['add', QWEN, ['ou_tam', 'ou_chelsea']]);
  // No group named in a DM: she asks which one.
  await onMessage({ env, lark: l, store, event: dm('add chelsea'), log: () => {} });
  assert.match(lastReply(l), /Which group should I add them to\?/);
  // Someone she doesn't know.
  await onMessage({ env, lark: l, store, event: dm('add Bartholomew to the qwen group'), log: () => {} });
  assert.match(lastReply(l), /couldn't find "Bartholomew"/);
});

test('only the owner can add people; "add a poster idea" is not a request at all', async () => {
  const store = fakeStore();
  const l = lark();
  assert.equal(await onMessage({ env, lark: l, store, event: msg('add kai here', { from: 'ou_chelsea' }), log: () => {} }), 'admin');
  assert.match(lastReply(l), /Only EJ can add other people/);
  assert.equal(l.calls.some((c) => c[0] === 'add'), false);
  assert.equal(await onMessage({ env, lark: l, store, event: msg('I want to add a poster idea'), log: () => {} }), 'answered');
});

test('someone already in the group is told so; a Lark refusal is explained', async () => {
  const store = fakeStore();
  const l = lark();
  await onMessage({ env, lark: l, store, event: msg('add yi jay koh here'), log: () => {} });
  await onMessage({ env, lark: l, store, event: msg('yes', { mention: false }), log: () => {} });
  assert.match(lastReply(l), /\*\*Yi Jay Koh\*\* was already in it/);
  const refusing = { ...lark(), addMembers: async () => { throw new Error('Lark POST /im/v1/chats/x/members: 232011 no permission'); } };
  await onMessage({ env, lark: refusing, store, event: msg('add chelsea here'), log: () => {} });
  await onMessage({ env, lark: refusing, store, event: msg('yes', { mention: false }), log: () => {} });
  assert.match(lastReply(refusing), /couldn't add \*\*Chelsea Choo\*\*[\s\S]*232011 no permission/);
});
