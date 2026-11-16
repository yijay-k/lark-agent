// Offline tests: fake Lark, fake AI, in-memory store. No network, no cost.
import test from 'node:test';
import assert from 'node:assert/strict';
import { encryptLark, decryptLark, signatureOk, sha256Hex } from '../src/crypto.js';
import { messageText, findLinks, eventIdsFromDescription, htmlToText, isBotMentioned } from '../src/text.js';
import { readLarkBody } from '../src/index.js';
import { onMessage } from '../src/handlers.js';
import { syncMembers, runCron } from '../src/cron.js';
import { think } from '../src/brain.js';

const BOT = 'ou_bot';
const ME = 'ou_me';

function fakeStore() {
  const messages = [];
  const briefings = new Set();
  const seen = new Set();
  return {
    messages,
    briefings,
    firstTime: async (id) => (seen.has(id) ? false : (seen.add(id), true)),
    saveMessage: async (m) => { messages.push({ ...m, chat_id: m.chatId, sender_name: m.senderName, created_at: m.createdAt }); },
    recentMessages: async (chatId) => messages.filter((m) => m.chatId === chatId),
    cachedPage: async () => null,
    savePage: async () => {},
    briefed: async (c, k) => briefings.has(`${c}|${k}`),
    markBriefed: async (c, k) => { briefings.add(`${c}|${k}`); },
  };
}

function fakeLark({ attendees = {}, members = [{ member_id: ME, name: 'Yi Koh' }], description = 'Day 1 · event:EV1 event:EV2', start = '1796169600' } = {}) {
  const calls = [];
  return {
    calls,
    botOpenId: async () => BOT,
    listChats: async () => [{ chat_id: 'oc_1', description }, { chat_id: 'oc_team', description: '' }],
    chatInfo: async () => ({ name: 'AiSED · 2 Dec', description }),
    chatMembers: async () => members,
    addMembers: async (chatId, ids) => calls.push(['addMembers', chatId, ids]),
    pinnedMessageIds: async () => ['om_pin'],
    getMessage: async () => ({ msg_type: 'post', body: { content: JSON.stringify({ title: 'AiSED', content: [[{ tag: 'text', text: 'Parking: SITC basement' }], [{ tag: 'a', text: 'Programme', href: 'https://example.org/programme' }]] }) } }),
    replyPost: async (id, t, md) => calls.push(['reply', id, md]),
    react: async (id, emoji) => calls.push(['react', id, emoji]),
    sendPost: async (chatId, t, md) => calls.push(['send', chatId, t, md]),
    primaryCalendarId: async () => 'cal_bot',
    getEvent: async (cal, id) => ({ summary: `Event ${id}`, status: 'confirmed', start_time: { timestamp: start }, end_time: { timestamp: String(Number(start) + 3600) }, location: { name: 'SITC' }, description: 'Dress: Batik' }),
    eventAttendees: async (cal, id) => attendees[id] || [],
  };
}

const fakeFetch = async (url) => ({
  ok: true,
  headers: { get: () => 'text/html' },
  text: async () => '<html><body><h1>Programme</h1><script>x()</script><p>Ends 5 PM</p></body></html>',
  json: async () => ({}),
});
const env = { GEMINI_API_KEY: '', AI: { run: async () => ({ response: '**Park in the basement.**' }) }, TIMEZONE: 'Asia/Kuala_Lumpur' };

test('crypto: decrypts what Lark encrypts, and checks signatures', async () => {
  const enc = await encryptLark('{"hello":"world"}', 'key123');
  assert.equal(await decryptLark(enc, 'key123'), '{"hello":"world"}');
  const raw = '{"encrypt":"x"}';
  const sig = await sha256Hex('ts' + 'nonce' + 'key123' + raw);
  const headers = new Headers({ 'x-lark-request-timestamp': 'ts', 'x-lark-request-nonce': 'nonce', 'x-lark-signature': sig });
  assert.equal(await signatureOk(headers, raw, 'key123'), true);
  assert.equal(await signatureOk(headers, raw, 'wrong'), false);
});

test('webhook: url verification and token checks', async () => {
  await assert.rejects(readLarkBody(new Request('https://x', { method: 'POST', body: '{"type":"url_verification"}' }), {}), /not set yet/);
  await assert.rejects(readLarkBody(new Request('https://x', { method: 'POST', body: '{"token":"T"}' }), { LARK_VERIFICATION_TOKEN: 'T', LARK_ENCRYPT_KEY: 'K' }), /encrypted/);
  const challenge = await readLarkBody(new Request('https://x/lark/events', { method: 'POST', body: JSON.stringify({ type: 'url_verification', challenge: 'c1', token: 'T' }) }), { LARK_VERIFICATION_TOKEN: 'T' });
  assert.equal(challenge.challenge, 'c1');
  await assert.rejects(readLarkBody(new Request('https://x', { method: 'POST', body: JSON.stringify({ type: 'url_verification', token: 'bad' }) }), { LARK_VERIFICATION_TOKEN: 'T' }), /verification token/);
  const enc = await encryptLark(JSON.stringify({ schema: '2.0', header: { token: 'T', event_type: 'im.message.receive_v1' } }), 'K');
  await assert.rejects(readLarkBody(new Request('https://x', { method: 'POST', body: JSON.stringify({ encrypt: enc }) }), { LARK_ENCRYPT_KEY: 'K', LARK_VERIFICATION_TOKEN: 'T' }), /signature/);
});

test('text helpers', () => {
  assert.equal(messageText('text', JSON.stringify({ text: '@_user_1 where to park?' })), 'where to park?');
  assert.match(messageText('post', JSON.stringify({ en_us: { title: 'T', content: [[{ tag: 'a', text: 'Site', href: 'https://a.org' }]] } })), /Site \(https:\/\/a\.org\)/);
  assert.deepEqual(findLinks('see https://a.org/x and https://a.org/x.'), ['https://a.org/x', 'https://a.org/x.']);
  assert.deepEqual(eventIdsFromDescription('Day 1 · event:EV1 event:EV2_0'), ['EV1', 'EV2_0']);
  assert.equal(htmlToText('<p>Hi</p><script>bad()</script>'), 'Hi');
  assert.equal(isBotMentioned([{ id: { open_id: BOT } }], BOT), true);
  assert.equal(isBotMentioned([{ id: { open_id: 'x' } }], BOT), false);
  assert.equal(isBotMentioned([{ id: BOT, id_type: 'open_id' }], BOT), true);
});

const groupMessage = (text, mentions = []) => ({
  sender: { sender_type: 'user', sender_id: { open_id: ME } },
  message: { message_id: 'om_1', chat_id: 'oc_1', chat_type: 'group', message_type: 'text', content: JSON.stringify({ text }), mentions, create_time: '1' },
});

test('messages are remembered; the bot answers only when @mentioned, from that group', async () => {
  const lark = fakeLark();
  const store = fakeStore();
  assert.equal(await onMessage({ env, lark, store, event: groupMessage('we meet at 8'), log: () => {}, fetchImpl: fakeFetch }), 'saved');
  assert.equal(store.messages[0].senderName, 'Yi Koh');
  assert.equal(lark.calls.length, 0);
  assert.equal(await onMessage({ env, lark, store, event: groupMessage('@_user_1 where to park?', [{ id: { open_id: BOT } }]), log: () => {}, fetchImpl: fakeFetch }), 'answered');
  assert.deepEqual(lark.calls.map((c) => c[0]), ['react', 'reply']);
});

test('every group is read, and each group only sees its own messages', async () => {
  const store = fakeStore();
  const teamLark = { ...fakeLark(), chatInfo: async () => ({ name: 'Team', description: 'our team chat' }) };
  const inTeam = groupMessage('team decision: demo on Friday');
  inTeam.message.chat_id = 'oc_team';
  inTeam.message.message_id = 'om_t';
  assert.equal(await onMessage({ env, lark: teamLark, store, event: inTeam, log: () => {} }), 'saved');
  assert.equal(await onMessage({ env, lark: fakeLark(), store, event: groupMessage('event chat'), log: () => {} }), 'saved');
  assert.deepEqual((await store.recentMessages('oc_team')).map((m) => m.text), ['team decision: demo on Friday']);
  assert.deepEqual((await store.recentMessages('oc_1')).map((m) => m.text), ['event chat']);
});

test('bot messages are ignored; private messages get an answer without an @mention', async () => {
  const store = fakeStore();
  const fromBot = { ...groupMessage('hi'), sender: { sender_type: 'app' } };
  assert.equal(await onMessage({ env, lark: fakeLark(), store, event: fromBot, log: () => {} }), 'ignored');
  const lark = { ...fakeLark(), listChats: async () => [{ chat_id: 'oc_1', name: 'AiSED', description: 'event:EV1' }],
    wikiSpaces: async () => [{ space_id: 'sp', name: 'AI Exploration', description: 'club wiki' }],
    wikiNodes: async () => [{ obj_type: 'docx', title: 'Core Philosophy', obj_token: 'doc1', has_child: false }],
    docText: async () => 'We explore, experiment, apply, share.' };
  const p2p = groupMessage('what is on tomorrow?');
  p2p.message.chat_type = 'p2p';
  assert.equal(await onMessage({ env, lark, store, event: p2p, log: () => {}, fetchImpl: fakeFetch }), 'answered');
  assert.deepEqual(lark.calls.map((c) => c[0]), ['react', 'reply']);
});

test('research questions are recognised; same-site useful links are found', async () => {
  const { isResearch, usefulSameSiteLinks } = await import('../src/text.js');
  assert.equal(isResearch('who are the panelists, should I go?'), true);
  assert.equal(isResearch('where do I park'), false);
  const html = '<a href="/speakers/">S</a><a href="https://other.com/speakers">X</a><a href="/blog">B</a><a href="faq.html">F</a>';
  assert.deepEqual(usefulSameSiteLinks(html, 'https://a.org/home/'), ['https://a.org/speakers/', 'https://a.org/home/faq.html']);
});

test('accepting any one event adds you; pending or declined does not; nobody is removed', async () => {
  const lark = fakeLark({
    members: [{ member_id: ME, name: 'Yi Koh' }],
    attendees: {
      EV1: [{ type: 'user', user_id: 'ou_tam', rsvp_status: 'needs_action' }, { type: 'user', user_id: ME, rsvp_status: 'accept' }],
      EV2: [{ type: 'user', user_id: 'ou_chelsea', rsvp_status: 'accept' }, { type: 'user', user_id: 'ou_x', rsvp_status: 'decline' }],
    },
  });
  const added = await syncMembers({ lark, chatId: 'oc_1', eventIds: ['EV1', 'EV2'], calendarId: 'cal' });
  assert.deepEqual(added, ['ou_chelsea']);
  assert.deepEqual(lark.calls, [['addMembers', 'oc_1', ['ou_chelsea']]]);
});

test('cron: one intro note per group, plus a reminder the day before', async () => {
  const now = Date.parse('2026-12-01T09:00:00+08:00');
  const lark = fakeLark({ start: String(Date.parse('2026-12-02T08:30:00+08:00') / 1000) });
  const store = fakeStore();
  await runCron({ env, lark, store, log: () => {}, fetchImpl: fakeFetch, now });
  assert.equal(lark.calls.filter((c) => c[0] === 'send').length, 0, 'no notes without a Gemini key');
  const withKey = { ...env, GEMINI_API_KEY: 'k' };
  const geminiDown = async (url, init) => (String(url).includes('generativelanguage') ? { ok: false, status: 429, json: async () => ({}) } : fakeFetch(url, init));
  await runCron({ env: withKey, lark, store, log: () => {}, fetchImpl: geminiDown, now });
  await runCron({ env: withKey, lark, store, log: () => {}, fetchImpl: geminiDown, now });
  const sends = lark.calls.filter((c) => c[0] === 'send').map((c) => c[2]);
  assert.deepEqual(sends, ['💡 Good to know', '🔔 Tomorrow: good to know']);
});

test('brain: the backup reads both Workers AI reply shapes', async () => {
  const oai = { AI: { run: async () => ({ choices: [{ message: { content: 'hello' } }] }) } };
  assert.equal((await think(oai, 's', 'p', () => {})).text, 'hello');
});

test('brain: Gemini with search, then without, then the free backup', async () => {
  const seen = [];
  const failing = async (url, init) => { seen.push(JSON.parse(init.body).tools ? 'search' : 'plain'); return { ok: false, status: 429, json: async () => ({ error: { message: 'quota' } }) }; };
  const out = await think({ ...env, GEMINI_API_KEY: 'k', GEMINI_SEARCH: 'on' }, 's', 'p', () => {}, failing);
  assert.deepEqual(seen, ['search', 'plain', 'search', 'plain']);
  assert.equal(out.via, 'workers-ai');
  const ok = async () => ({ ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: 'hi' }] } }] }) });
  assert.deepEqual(await think({ GEMINI_API_KEY: 'k' }, 's', 'p', () => {}, ok), { text: 'hi', via: 'gemini-3.5-flash-lite' });
});

test('lark client: reads results with or without the data wrapper (bot info has none)', async () => {
  const { createLark } = await import('../src/lark.js');
  const fakeApi = async (url) => ({
    json: async () => (String(url).includes('tenant_access_token') ? { code: 0, tenant_access_token: 't', expire: 7200 }
      : String(url).includes('/bot/v3/info') ? { code: 0, msg: 'ok', bot: { open_id: 'ou_bot' } }
      : { code: 0, data: { items: [{ chat_id: 'oc_1' }] } }),
  });
  const lark = createLark({ LARK_APP_ID: 'a', LARK_APP_SECRET: 'b' }, fakeApi);
  assert.equal(await lark.botOpenId(), 'ou_bot');
  assert.deepEqual(await lark.listChats(), [{ chat_id: 'oc_1' }]);
});

test('wiki pages are ranked by the question', async () => {
  const { rankPages } = await import('../src/knowledge.js');
  const index = ['Introduction', 'Core Philosophy', "THE IDIOT'S VISION", 'Project 001', 'AI Exploration Hub', 'Meeting notes'].map((title, i) => ({ title, token: `d${i}` }));
  assert.equal(rankPages(index, 'what is our core philosophy?')[0].title, 'Core Philosophy');
  assert.equal(rankPages(index, 'tell me about project 001')[0].title, 'Project 001');
});
