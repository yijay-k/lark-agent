// The owner sets up an event: a group for the event day, calendar invites, and adding people
// who accepted. Parsed and matched in code, confirmed, then done; nobody else may do it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeStore } from './fakes.js';
import { parseEventRequest, teamChatIds, eventDay } from '../src/events.js';
import { parseAdd } from '../src/admin.js';
import { onMessage } from '../src/handlers.js';

const OWNER = 'ou_owner';
const BOT = 'ou_bot';
const TZ = 'Asia/Kuala_Lumpur';
// Event times in Kuala Lumpur (UTC+8), in 2037 so they stay upcoming: 2 Dec 2037 is a Wednesday too.
const at = (day, hour) => Date.UTC(2037, 11, day, hour - 8) / 1000;
const NOW = Date.now();
const AI_TEAM = 'oc_team';
const PR_TEAM = 'oc_pr';
const GROUPS = [
  { chat_id: AI_TEAM, name: 'AI Exploration ( BASECAMP ✨)', description: '' },
  { chat_id: PR_TEAM, name: 'PR Exploration', description: '' },
  { chat_id: 'oc_qwen', name: 'Qwen Conference Malaysia 2026 | AI Exploration', description: 'Qwen · event:ev_qwen' },
];
const MEMBERS = {
  [AI_TEAM]: [{ member_id: OWNER, name: 'Yi Jay Koh' }, { member_id: 'ou_cindy', name: 'Cindy Tan' }, { member_id: 'ou_ken', name: 'Ken Wong' }],
  [PR_TEAM]: [{ member_id: 'ou_ken', name: 'Ken Wong' }, { member_id: 'ou_mei', name: 'Mei Ling' }],
  oc_qwen: [{ member_id: OWNER, name: 'Yi Jay Koh' }, { member_id: 'ou_kai', name: 'Kai Lim' }],
};
const env = { GEMINI_API_KEY: '', TIMEZONE: TZ, OWNER_OPEN_IDS: OWNER, TEAM_CHATS: `${AI_TEAM},${PR_TEAM}`, AI: { run: async () => ({ response: 'AI answer' }) } };

// The calendar's own copy of each event: where the details message comes from.
const DETAILS = 'Sessions: 09:00 keynote, 10:30 workshops\nDress code: smart casual\nParking: B2, or the LRT to KLCC\nRegister: https://aised.example/register\nRSVP by 28 Nov';
const CALENDAR = {
  ev_open: { summary: 'AiSED International Conference 2026: Opening', start_time: { timestamp: String(at(2, 9)) }, end_time: { timestamp: String(at(2, 12)) }, location: { name: 'KLCC Hall 3', address: 'Kuala Lumpur City Centre, 50088 KL' }, description: DETAILS },
  ev_panel: { summary: 'AiSED International Conference 2026: Panel', start_time: { timestamp: String(at(2, 14)) }, end_time: { timestamp: String(at(2, 17)) }, location: { name: 'KLCC Hall 3' }, description: DETAILS },
};

function fakeLark({ groups = GROUPS, attendees = {}, refuseInvites = false, pins = {}, createError = null } = {}) {
  const calls = [];
  const members = structuredClone(MEMBERS);
  let chats = [...groups];
  return {
    calls,
    botOpenId: async () => BOT,
    listChats: async () => chats,
    chatInfo: async (id) => chats.find((g) => g.chat_id === id),
    chatMembers: async (id) => members[id] || [],
    addMembers: async (id, ids) => { calls.push(['add', id, ids]); return {}; },
    createChat: async (opts) => {
      calls.push(['create', opts]);
      if (createError) throw new Error(createError);
      chats = [...chats, { chat_id: 'oc_new', name: opts.name, description: opts.description }];
      return { chat_id: 'oc_new', invalid_id_list: [] };
    },
    sendPost: async (id, title, md) => { calls.push(['post', id, title, md]); return { message_id: 'om_details' }; },
    pinMessage: async (id) => { calls.push(['pin', id]); return {}; },
    primaryCalendarId: async () => 'cal_bot',
    listEvents: async () => { calls.push(['listEvents']); return []; },
    eventAttendees: async (cal, id) => { calls.push(['attendees', cal, id]); return attendees[id] || []; },
    addAttendees: async (cal, id, ids) => {
      calls.push(['invite', cal, id, ids]);
      if (refuseInvites) throw new Error(`Lark POST /calendar/v4/calendars/${cal}/events/${id}/attendees: 193003 no permission`);
      return {};
    },
    pinnedMessageIds: async (id) => Object.keys(pins[id] || {}),
    getMessage: async (mid) => { const text = Object.values(pins).map((p) => p[mid]).find(Boolean); return { msg_type: 'text', body: { content: JSON.stringify({ text }) } }; },
    getEvent: async (cal, id) => CALENDAR[id] || null,
    react: async () => {},
    replyPost: async (id, t, md) => { calls.push(['reply', md]); return { message_id: `om_r${calls.length}` }; },
    wikiSpaces: async () => [],
    wikiNodes: async () => [],
  };
}

async function storeWithEvents() {
  const store = fakeStore();
  await store.markBriefed('onboard', OWNER); // the owner was welcomed long ago
  await store.indexAdd('event', 'ev_open', { title: 'AiSED International Conference 2026: Opening', body: 'Wed 2 Dec, 09:00 – 12:00\nWhere: KLCC', at: at(2, 9) });
  await store.indexAdd('event', 'ev_panel', { title: 'AiSED International Conference 2026: Panel', body: 'Wed 2 Dec, 14:00 – 17:00\nWhere: KLCC', at: at(2, 14) });
  await store.indexAdd('event', 'ev_day2', { title: 'AiSED International Conference 2026: Day 2', body: 'Thu 3 Dec, 09:00 – 17:00', at: at(3, 9) });
  await store.indexAdd('event', 'ev_qwen', { title: 'Qwen Conference Malaysia 2026', body: 'Sat 5 Dec', at: at(5, 9), chatId: 'oc_qwen' });
  return store;
}

let n = 0;
const msg = (text, { from = OWNER, chat = 'oc_dm', type = 'p2p', mention = type === 'group' } = {}) => ({
  sender: { sender_type: 'user', sender_id: { open_id: from } },
  message: { message_id: `om_${(n += 1)}`, chat_id: chat, chat_type: type, message_type: 'text', create_time: String(NOW + n), content: JSON.stringify({ text }), mentions: mention ? [{ id: { open_id: BOT } }] : [] },
});
const send = (l, store, text, opts) => onMessage({ env, lark: l, store, event: msg(text, opts), log: () => {} });
const lastReply = (l) => l.calls.filter((c) => c[0] === 'reply').at(-1)?.[1];
const did = (l, kind) => l.calls.filter((c) => c[0] === kind);

test('event requests are read in code: set up a group, send invites, add who accepted', () => {
  assert.deepEqual(parseEventRequest('make a group for AiSED on 2 Dec and invite the team'), { kind: 'setup', what: 'AiSED', date: { day: 2, month: 11 }, team: true, names: [], here: false });
  assert.deepEqual(parseEventRequest('Create an event group for the AiSED conference'), { kind: 'setup', what: 'AiSED conference', date: null, team: false, names: [], here: false });
  assert.deepEqual(parseEventRequest('invite Cindy and Ken to the AiSED events'), { kind: 'invite', what: 'AiSED', date: null, team: false, names: ['Cindy', 'Ken'], here: false });
  assert.deepEqual(parseEventRequest('send calendar invites to the team for AiSED on Dec 3rd'), { kind: 'invite', what: 'AiSED', date: { day: 3, month: 11 }, team: true, names: [], here: false });
  assert.deepEqual(parseEventRequest('add everyone who accepted to the AiSED group'), { kind: 'accepted', what: 'AiSED', date: null, team: false, names: [], here: false });
  assert.deepEqual(parseEventRequest('add everyone who accepted here'), { kind: 'accepted', what: '', date: null, team: false, names: [], here: true });
  assert.equal(parseEventRequest('add kai to the qwen group'), null); // a plain add stays with admin.js
  assert.equal(parseEventRequest('add kai to the AiSED events group'), null);
  assert.equal(parseEventRequest('invite Ken to the 5 decisions meeting'), null); // not 5 Dec
  assert.equal(parseEventRequest('create a chat summary of today'), null);
  assert.equal(parseEventRequest('start a chat with Kai'), null);
  assert.deepEqual(parseEventRequest('invite Cindy and Ken to the AiSED group'), { kind: 'invite', what: 'AiSED', date: null, team: false, names: ['Cindy', 'Ken'], here: false, toGroup: true });
  assert.equal(parseEventRequest('what time is the AiSED opening?'), null);
  assert.ok(parseAdd('add kai to the qwen group'));
});

test('the team is the members of the team groups: TEAM_CHATS, else the GROUP_WIKIS groups, else the onboarding group', () => {
  assert.deepEqual(teamChatIds({ TEAM_CHATS: 'oc_a, oc_b' }), ['oc_a', 'oc_b']);
  assert.deepEqual(teamChatIds({ GROUP_WIKIS: 'oc_a=123,oc_b=456|789' }), ['oc_a', 'oc_b']);
  assert.deepEqual(teamChatIds({ ONBOARDING_CHAT_ID: 'oc_on' }), ['oc_on']);
  assert.equal(eventDay(at(2, 9), TZ), '2037-12-02');
});

test('"make a group for AiSED on 2 Dec and invite the team": the plan first, then the group, the pinned details and the invites', async () => {
  const store = await storeWithEvents();
  // Cindy was invited to the opening already; nobody else was.
  const l = fakeLark({ attendees: { ev_open: [{ type: 'user', user_id: 'ou_cindy', rsvp_status: 'needs_action' }] } });
  assert.equal(await send(l, store, 'make a group for AiSED on 2 Dec and invite the team'), 'admin');
  const plan = lastReply(l);
  assert.match(plan, /\*\*AiSED International Conference 2026 · 2 Dec\*\*/);
  assert.match(plan, /\*\*Cindy Tan\*\*, \*\*Ken Wong\*\*, \*\*Mei Ling\*\*/); // both team groups, Ken once, not the owner
  assert.match(plan, /Opening[\s\S]*Panel/);
  assert.doesNotMatch(plan, /Day 2/); // another day
  assert.match(plan, /Reply \*\*yes\*\*/);
  assert.equal(did(l, 'create').length + did(l, 'invite').length, 0); // nothing done before the yes

  assert.equal(await send(l, store, 'yes'), 'admin');
  const [, opts] = did(l, 'create')[0];
  assert.equal(opts.name, 'AiSED International Conference 2026 · 2 Dec');
  assert.match(opts.description, /^AiSED International Conference 2026 · Wed 2 Dec · event:ev_open event:ev_panel$/);
  assert.equal(opts.ownerId, OWNER);
  assert.deepEqual(opts.userIds, ['ou_cindy', 'ou_ken', 'ou_mei']);
  assert.ok(opts.uuid);
  const [, postedIn, , details] = did(l, 'post')[0];
  assert.equal(postedIn, 'oc_new');
  assert.match(details, /Opening[\s\S]*📍 KLCC Hall 3, Kuala Lumpur City Centre[\s\S]*Panel/);
  assert.match(details, /Dress code: smart casual[\s\S]*Parking: B2[\s\S]*https:\/\/aised\.example\/register[\s\S]*RSVP by 28 Nov/);
  assert.equal(details.split('Dress code').length, 2); // the shared description once
  assert.deepEqual(did(l, 'pin')[0], ['pin', 'om_details']);
  assert.deepEqual(did(l, 'invite').map((c) => [c[2], c[3]]), [['ev_open', ['ou_ken', 'ou_mei']], ['ev_panel', ['ou_cindy', 'ou_ken', 'ou_mei']]]);
  const done = lastReply(l);
  assert.match(done, /Made \*\*AiSED International Conference 2026 · 2 Dec\*\*/);
  assert.match(done, /Calendar invites sent/);
  // The new group is known at once (no wait for the 10-minute cache).
  assert.ok((await store.kvGet('lark:listChats:all')).some((g) => g.chat_id === 'oc_new'));
});

test('a group that already has those events is reused: people are added to it, no second group', async () => {
  const store = await storeWithEvents();
  const existing = { chat_id: 'oc_aised', name: 'AiSED International Conference 2026 · 2 Dec', description: 'AiSED 2026 · Wed 2 Dec · event:ev_open event:ev_panel' };
  const l = fakeLark({ groups: [...GROUPS, existing] });
  await send(l, store, 'set up a group for AiSED on 2 Dec and invite the team');
  assert.match(lastReply(l), /already have \*\*AiSED International Conference 2026 · 2 Dec\*\*/);
  await send(l, store, 'yes');
  assert.equal(did(l, 'create').length, 0);
  assert.deepEqual(did(l, 'add')[0], ['add', 'oc_aised', ['ou_cindy', 'ou_ken', 'ou_mei']]);
  assert.equal(did(l, 'invite').length, 2);
  assert.equal(did(l, 'post')[0][1], 'oc_aised'); // its details weren't pinned yet
  assert.equal(did(l, 'pin').length, 1);
  assert.match(lastReply(l), /pinned the event details in \*\*AiSED/);
});

test('"invite Cindy and Ken to the AiSED group": added to the group and invited to its events; details already pinned stay as they are', async () => {
  const store = await storeWithEvents();
  const existing = { chat_id: 'oc_aised', name: 'AiSED International Conference 2026 · 2 Dec', description: 'AiSED 2026 · Wed 2 Dec · event:ev_open event:ev_panel' };
  const l = fakeLark({ groups: [...GROUPS, existing], pins: { oc_aised: { om_card: 'AiSED International Conference 2026: Opening, KLCC, 9am' } } });
  await send(l, store, 'invite Cindy and Ken to the AiSED group');
  assert.match(lastReply(l), /add them to \*\*AiSED International Conference 2026 · 2 Dec\*\*[\s\S]*\*\*Cindy Tan\*\*, \*\*Ken Wong\*\*[\s\S]*Opening[\s\S]*Panel/);
  await send(l, store, 'yes');
  assert.deepEqual(did(l, 'add')[0], ['add', 'oc_aised', ['ou_cindy', 'ou_ken']]);
  assert.deepEqual(did(l, 'invite').map((c) => c[2]), ['ev_open', 'ev_panel']);
  assert.equal(did(l, 'post').length + did(l, 'pin').length, 0);
  // A group without events is a plain add (admin.js): no calendar invites.
  await send(l, store, 'invite Kai to the basecamp group');
  assert.match(lastReply(l), /Just to check: add \*\*Kai Lim\*\* to \*\*AI Exploration \( BASECAMP/);
});

test('several days match and none was named: she asks which day instead of guessing', async () => {
  const store = await storeWithEvents();
  const l = fakeLark();
  await send(l, store, 'make a group for AiSED');
  assert.match(lastReply(l), /Which day\?[\s\S]*Wed 2 Dec[\s\S]*Thu 3 Dec/);
  assert.equal(await send(l, store, 'yes'), 'answered'); // nothing pending: an ordinary message
  assert.equal(did(l, 'create').length, 0);
});

test('"invite Cindy and Ken to the AiSED events" in a group: invites only, skipping anyone already invited', async () => {
  const store = await storeWithEvents();
  const l = fakeLark({ attendees: { ev_day2: [{ type: 'user', user_id: 'ou_ken', rsvp_status: 'accept' }] } });
  await send(l, store, 'invite Cindy and Ken to the AiSED events', { chat: AI_TEAM, type: 'group' });
  const plan = lastReply(l);
  assert.match(plan, /\*\*Cindy Tan\*\*, \*\*Ken Wong\*\*/);
  assert.match(plan, /Opening[\s\S]*Panel[\s\S]*Day 2/);
  assert.match(plan, /no group yet, so calendar invites only/);
  await send(l, store, 'yes', { chat: AI_TEAM, type: 'group', mention: false });
  assert.deepEqual(did(l, 'invite').map((c) => [c[2], c[3]]), [['ev_open', ['ou_cindy', 'ou_ken']], ['ev_panel', ['ou_cindy', 'ou_ken']], ['ev_day2', ['ou_cindy']]]);
  assert.equal(did(l, 'create').length + did(l, 'add').length, 0);
  assert.match(lastReply(l), /already invited[\s\S]*Ken Wong/);
});

test('"add everyone who accepted to the Qwen group": the people who accepted and are not in it, confirmed, then added', async () => {
  const store = await storeWithEvents();
  const l = fakeLark({ attendees: { ev_qwen: [
    { type: 'user', user_id: 'ou_cindy', display_name: 'Cindy Tan', rsvp_status: 'accept' },
    { type: 'user', user_id: 'ou_kai', display_name: 'Kai Lim', rsvp_status: 'accept' }, // already in
    { type: 'user', user_id: 'ou_mei', display_name: 'Mei Ling', rsvp_status: 'decline' },
  ] } });
  await send(l, store, 'add everyone who accepted to the qwen group');
  assert.match(lastReply(l), /\*\*Cindy Tan\*\* accepted[\s\S]*\*\*Qwen Conference/);
  await send(l, store, 'yes');
  assert.deepEqual(did(l, 'add')[0], ['add', 'oc_qwen', ['ou_cindy']]);
  assert.match(lastReply(l), /Added \*\*Cindy Tan\*\*/);
});

test('only the owner may set up events; "no" cancels; a calendar refusal says what to change', async () => {
  const store = await storeWithEvents();
  const l = fakeLark({ refuseInvites: true });
  assert.equal(await send(l, store, 'make a group for AiSED on 2 Dec and invite the team', { from: 'ou_cindy' }), 'admin');
  assert.match(lastReply(l), /Only EJ can/);
  assert.equal(await send(l, store, 'invite Cindy and Ken to the AiSED events', { from: 'ou_cindy' }), 'admin');
  assert.equal(did(l, 'create').length + did(l, 'invite').length, 0);

  await send(l, store, 'invite Cindy to the AiSED events on 2 Dec');
  await send(l, store, 'no');
  assert.match(lastReply(l), /won't do anything/);
  assert.equal(did(l, 'invite').length, 0);

  await send(l, store, 'invite Cindy to the AiSED events on 2 Dec');
  await send(l, store, 'yes');
  assert.equal(did(l, 'invite').length, 1); // stops after the first refusal: the others would fail the same way
  assert.match(lastReply(l), /couldn't send the calendar invites[\s\S]*193003 no permission[\s\S]*invite others/);
});

test('an unknown name or event is reported, not guessed', async () => {
  const store = await storeWithEvents();
  const l = fakeLark();
  await send(l, store, 'invite Bartholomew to the AiSED events');
  assert.match(lastReply(l), /couldn't find "Bartholomew"/);
  await send(l, store, 'make a group for the Gemma hackathon');
  assert.match(lastReply(l), /couldn't find an upcoming event matching "Gemma hackathon"/);
  assert.equal(did(l, 'listEvents').length, 1); // one look at the calendar before giving up
});

test('one plan at a time: a new event plan drops a pending add, and a new add drops a pending plan', async () => {
  const store = await storeWithEvents();
  const l = fakeLark();
  await send(l, store, 'add mei to the qwen group');
  assert.match(lastReply(l), /Just to check: add \*\*Mei Ling\*\*/);
  await send(l, store, 'invite Cindy to the AiSED events on 2 Dec');
  await send(l, store, 'yes');
  assert.equal(did(l, 'invite').length, 2);
  assert.equal(await send(l, store, 'yes'), 'answered'); // the add was dropped: nothing left to confirm
  assert.equal(did(l, 'add').length, 0);
  await send(l, store, 'invite Cindy to the AiSED events on 2 Dec');
  await send(l, store, 'add mei to the qwen group');
  await send(l, store, 'yes');
  assert.deepEqual(did(l, 'add')[0], ['add', 'oc_qwen', ['ou_mei']]);
  assert.equal(did(l, 'invite').length, 2); // the event plan was dropped
});

test('if Lark will not make the group, nothing else is done and only a permission error mentions the permission', async () => {
  const store = await storeWithEvents();
  const l = fakeLark({ createError: 'Lark POST /im/v1/chats: 232043 description too long' });
  await send(l, store, 'make a group for AiSED on 2 Dec and invite the team');
  await send(l, store, 'yes');
  assert.match(lastReply(l), /couldn't make the group: Lark said "232043 description too long"\. Nothing else was done/);
  assert.doesNotMatch(lastReply(l), /im:chat:create/);
  assert.equal(did(l, 'invite').length + did(l, 'post').length, 0);
  const denied = fakeLark({ createError: 'Lark POST /im/v1/chats: 99991672 Access denied' });
  await send(denied, store, 'make a group for AiSED on 2 Dec');
  await send(denied, store, 'yes');
  assert.match(lastReply(denied), /im:chat:create/);
});
