// Which wiki each chat may use: a group only its own wiki space(s) from GROUP_WIKIS; a DM every space.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeStore } from './fakes.js';
import { refreshIndex } from '../src/search.js';
import { onMessage } from '../src/handlers.js';
import { groupWikis, dmWikis } from '../src/knowledge.js';
import { groupContext } from '../src/context.js';

const ME = 'ou_me';
const BOT = 'ou_bot';
const NOW = Date.UTC(2026, 10, 24, 5, 0);
// Real space ids: they also pick the team's "about" text (src/handbook.js).
const AI = '7704003696610250272';
const PR = '7711718462715874858';
const SPACES = [
  { space_id: AI, name: 'AI Exploration ', description: 'club wiki' },
  { space_id: PR, name: 'PR Exploration', description: 'PR team hub' },
];
const NODES = {
  [AI]: [{ obj_type: 'docx', title: 'Project 001 schedule', obj_token: 'doc_ai', node_token: 'n_ai', obj_edit_time: '1', has_child: false }],
  [PR]: [{ obj_type: 'docx', title: 'PR Weekly Playbook schedule', obj_token: 'doc_pr', node_token: 'n_pr', obj_edit_time: '1', has_child: false }],
};
const TEXT = { doc_ai: 'AI SECRET: poster schedule is every Tuesday.', doc_pr: 'PR SECRET: posting schedule is every Friday.' };
const GROUPS = [
  { chat_id: 'oc_pr', name: 'PR Exploration', description: 'PR team' },
  { chat_id: 'oc_other', name: 'Random group', description: '' },
  { chat_id: 'oc_both', name: 'Leads', description: 'both teams' },
];

function lark({ nodes = NODES, text = TEXT } = {}) {
  const calls = [];
  return {
    calls,
    botOpenId: async () => BOT,
    listChats: async () => GROUPS,
    chatInfo: async (id) => GROUPS.find((g) => g.chat_id === id),
    chatMembers: async () => [{ member_id: ME, name: 'Yi Koh' }],
    pinnedMessageIds: async () => [],
    getMessage: async () => null,
    primaryCalendarId: async () => 'cal',
    listEvents: async () => [],
    wikiSpaces: async () => SPACES,
    wikiNodes: async (spaceId) => nodes[spaceId] || [],
    docText: async (t) => text[t],
    react: async () => {},
    replyPost: async (id, t, md) => { calls.push(['reply', md]); return { message_id: `om_r${calls.length}` }; },
  };
}

// The fake AI answers with the prompt it was given, so tests can see what Eleyna was shown.
const env = {
  GEMINI_API_KEY: '', TIMEZONE: 'Asia/Kuala_Lumpur', BOT_OPEN_ID: BOT,
  GROUP_WIKIS: `oc_pr=${PR},oc_both=${AI}|${PR}`,
  OPEN_WIKIS: AI,
  AI: { run: async (model, { messages }) => ({ response: `${messages[0].content}\n=====\n${messages[1].content}` }) },
};
const lastReply = (l) => l.calls.filter((c) => c[0] === 'reply').at(-1)[1];

function groupAsk(chatId, text) {
  return { sender: { sender_type: 'user', sender_id: { open_id: ME } }, message: { message_id: `om_${Math.random()}`, chat_id: chatId, chat_type: 'group', message_type: 'text', content: JSON.stringify({ text }), mentions: [{ id: { open_id: BOT } }], create_time: String(NOW) } };
}
function dmAsk(text) {
  return { sender: { sender_type: 'user', sender_id: { open_id: ME } }, message: { message_id: `om_${Math.random()}`, chat_id: 'oc_dm', chat_type: 'p2p', message_type: 'text', content: JSON.stringify({ text }), create_time: String(NOW) } };
}

async function ready(opts) {
  const l = lark(opts);
  const store = fakeStore();
  await store.markBriefed('onboard', ME); // already welcomed
  await refreshIndex({ env, lark: l, store, now: NOW });
  return { l, store };
}

test('GROUP_WIKIS maps a group to its wiki space ids; unlisted groups get none', () => {
  const e = { GROUP_WIKIS: ' oc_pr = sp_pr , oc_both=sp_ai|sp_pr,bad, =x' }; // ids are opaque strings here
  assert.deepEqual(groupWikis(e, 'oc_pr'), ['sp_pr']);
  assert.deepEqual(groupWikis(e, 'oc_both'), ['sp_ai', 'sp_pr']);
  assert.deepEqual(groupWikis(e, 'oc_other'), []);
  assert.deepEqual(groupWikis({}, 'oc_pr'), []);
});

test('a group listed in GROUP_WIKIS sees its own wiki and never another space', async () => {
  const { l, store } = await ready();
  await onMessage({ env, lark: l, store, event: groupAsk('oc_pr', '@_user_1 what is the posting schedule?'), log: () => {} });
  const shown = lastReply(l);
  assert.match(shown, /PR SECRET/);
  assert.doesNotMatch(shown, /AI SECRET/);
  assert.match(shown, /PR Exploration in one minute/); // the PR team's own "about" text
  assert.doesNotMatch(shown, /AI Exploration in one minute/);
});

test('a group sees its own pages even when another space has many better keyword matches', async () => {
  const nodes = { ...NODES, [AI]: Array.from({ length: 40 }, (_, i) => ({ obj_type: 'docx', title: `Schedule ${i}`, obj_token: `ai_${i}`, node_token: `n_ai_${i}`, obj_edit_time: '1', has_child: false })) };
  const text = { ...TEXT, ...Object.fromEntries(nodes[AI].map((n) => [n.obj_token, 'AI SECRET: schedule schedule schedule posting schedule'])) };
  const { l, store } = await ready({ nodes, text });
  // Index every page (the cron reads 8 a run).
  await refreshIndex({ env, lark: l, store, now: NOW, docReads: 100 });
  // Found by search itself, not by the title fallback (which adds a "Wiki spaces" entry).
  const ctx = await groupContext({ env, lark: l, store, chatId: 'oc_pr', question: 'posting schedule?' });
  assert.deepEqual(ctx.docs.map((d) => d.title), ['PR Exploration › PR Weekly Playbook schedule']);
  assert.match(ctx.docs[0].text, /PR SECRET/);
});

test('a group with both wikis gets both teams\' "about" text and both wikis', async () => {
  const { l, store } = await ready();
  await onMessage({ env, lark: l, store, event: groupAsk('oc_both', '@_user_1 what is the schedule?'), log: () => {} });
  const shown = lastReply(l);
  assert.match(shown, /AI Exploration in one minute/);
  assert.match(shown, /PR Exploration in one minute/);
  assert.match(shown, /PR SECRET/);
  assert.match(shown, /AI SECRET/);
});

test('small talk in a group reads no wiki pages', async () => {
  const { l, store } = await ready();
  let reads = 0;
  const counting = { ...l, docText: async (t) => { reads += 1; return TEXT[t]; } };
  const ctx = await groupContext({ env, lark: counting, store, chatId: 'oc_pr', question: 'lol nice one' });
  assert.deepEqual(ctx.docs, []);
  assert.equal(reads, 0);
});

test('a group not in GROUP_WIKIS gets no wiki at all', async () => {
  const { l, store } = await ready();
  await onMessage({ env, lark: l, store, event: groupAsk('oc_other', '@_user_1 what is the schedule?'), log: () => {} });
  const shown = lastReply(l);
  assert.doesNotMatch(shown, /PR SECRET|AI SECRET/);
  assert.doesNotMatch(shown, /### CLUB DOCUMENTS/);
});

test('DM wikis: open spaces for everyone, a team space for its group members, all for the owner', () => {
  const e = { GROUP_WIKIS: `oc_pr=${PR}`, OPEN_WIKIS: AI };
  assert.deepEqual(dmWikis(e, new Set()), [AI]);
  assert.deepEqual(dmWikis(e, new Set(['oc_pr', 'oc_other'])), [AI, PR]);
  assert.equal(dmWikis(e, new Set(), true), null);
  assert.equal(dmWikis({}, new Set()), null); // not configured: every space, as before
});

test('a PR group member sees both wikis in a DM', async () => {
  const { l, store } = await ready();
  await onMessage({ env, lark: l, store, event: dmAsk('what is the schedule?'), log: () => {} });
  const shown = lastReply(l);
  assert.match(shown, /PR SECRET/);
  assert.match(shown, /AI SECRET/);
});

test('someone outside the PR group never sees the PR wiki, or the PR team\'s handbook, in a DM', async () => {
  const { l, store } = await ready();
  const outsider = { ...l, chatMembers: async () => [{ member_id: 'ou_someone_else' }] };
  await onMessage({ env, lark: outsider, store, event: dmAsk('what is the posting schedule?'), log: () => {} });
  const shown = lastReply(l);
  assert.doesNotMatch(shown, /PR SECRET/);
  assert.doesNotMatch(shown, /PR Exploration in one minute/);
  assert.match(shown, /AI SECRET/);
  assert.match(shown, /AI Exploration in one minute/);
});

test('a PR member gets the PR team\'s handbook in a DM', async () => {
  const { l, store } = await ready();
  await onMessage({ env, lark: l, store, event: dmAsk('what do we do on wednesday?'), log: () => {} });
  assert.match(lastReply(l), /PR Exploration in one minute/);
});

test('without a question (cron briefings) a group reads no wiki pages', async () => {
  const { l, store } = await ready();
  let reads = 0;
  const counting = { ...l, docText: async (t) => { reads += 1; return TEXT[t]; } };
  const ctx = await groupContext({ env, lark: counting, store, chatId: 'oc_pr', question: '' });
  assert.deepEqual(ctx.docs, []);
  assert.deepEqual(ctx.docs, []);
  assert.equal(reads, 0);
});

// ---- The PR Tracker (a Base in the PR wiki) ----
import { cellText, recordLine } from '../src/base.js';

test('Base cells read as text: people, options, links and dates; ids-only links are skipped', () => {
  assert.equal(cellText([{ name: 'Cindy', id: 'ou_1', email: 'x@y.z' }]), 'Cindy');
  assert.equal(cellText(['LinkedIn', 'Instagram']), 'LinkedIn, Instagram');
  assert.equal(cellText({ link: 'https://e.org', text: 'Event page' }), 'Event page');
  assert.equal(cellText([{ text_arr: ['AiSED meetup'], record_ids: ['rec1'] }]), 'AiSED meetup');
  assert.equal(cellText({ link_record_ids: ['rec1'] }), '');
  assert.match(cellText(Date.UTC(2026, 10, 28, 2, 0)), /28 Nov 2026, 10:00/); // KL time
  assert.equal(recordLine('Tasks', { Task: 'Post roundup', Assignee: [{ name: 'Cindy' }], Notes: '' }), '[Tasks] Task: Post roundup · Assignee: Cindy');
  assert.equal(cellText({ type: 1, value: [{ text: 'Shortlisted' }] }), 'Shortlisted'); // formula / lookup
  assert.equal(recordLine('Sources', { Notes: 'mail a@b.co or call 012-345 6789, due 2026-11-24' }), '[Sources] Notes: mail [email] or call [phone], due 2026-11-24');
});

function trackerLark() {
  const base = { obj_type: 'bitable', title: '📊 PR Tracker', obj_token: 'base_pr', node_token: 'n_base', obj_edit_time: '1', has_child: false };
  const l = lark({ nodes: { ...NODES, [PR]: [...NODES[PR], base] } });
  return {
    ...l,
    baseTables: async () => [{ table_id: 'tbl_post', name: '🗓️ Posting Schedule' }],
    baseRecords: async () => [{ fields: { 'Post Title': 'Weekly roundup', Poster: [{ name: 'Cindy' }], 'Scheduled Time': Date.UTC(2026, 10, 28, 2, 0), Status: 'Scheduled' } }],
  };
}

test('the PR group can ask about the PR Tracker', async () => {
  const l = trackerLark();
  const store = fakeStore();
  await refreshIndex({ env, lark: l, store, now: NOW });
  const ctx = await groupContext({ env, lark: l, store, chatId: 'oc_pr', question: 'who is the poster for the weekly roundup?' });
  const text = ctx.docs.map((d) => d.text).join('\n');
  assert.match(text, /Post Title: Weekly roundup · Poster: Cindy · Scheduled Time: 28 Nov 2026, 10:00 · Status: Scheduled/);
});

test('the PR Tracker stays out of other groups and outsiders\' DMs', async () => {
  const l = trackerLark();
  const store = fakeStore();
  await store.markBriefed('onboard', ME);
  await refreshIndex({ env, lark: l, store, now: NOW });
  const other = await groupContext({ env, lark: l, store, chatId: 'oc_other', question: 'weekly roundup poster?' });
  assert.equal(other.docs.length, 0);
  const outsider = { ...l, chatMembers: async () => [{ member_id: 'ou_someone_else' }] };
  await onMessage({ env, lark: outsider, store, event: dmAsk('who is the poster for the weekly roundup?'), log: () => {} });
  assert.doesNotMatch(lastReply(l), /Weekly roundup · Poster/);
});

test('a Base keeps its newest rows when a table is long', async () => {
  const { baseText } = await import('../src/base.js');
  const rows = Array.from({ length: 350 }, (_, i) => ({ fields: { Post: `post ${i}` } }));
  const text = await baseText({ baseTables: async () => [{ table_id: 't', name: 'Posts' }], baseRecords: async () => rows }, 'b');
  assert.match(text, /post 349/);
  assert.doesNotMatch(text, /Post: post 0\n/);
});

test('a Base is re-read on a timer, not on every run', async () => {
  const l = trackerLark();
  let reads = 0;
  const counting = { ...l, baseTables: async (...a) => { reads += 1; return l.baseTables(...a); } };
  const store = fakeStore();
  await refreshIndex({ env, lark: counting, store, now: NOW });
  await refreshIndex({ env, lark: counting, store, now: NOW });
  assert.equal(reads, 1);
});
