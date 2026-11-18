// The owner adds people to a group: "add kai here", "add kai and chelsea to the Qwen group".
// Everything is decided in code, never by the AI: the request is parsed, names are matched to
// people in Eleyna's groups, the owner confirms (or picks from several matches), then they're added.
// Only the owner (OWNER_OPEN_IDS, a Cloudflare secret) can do this; anyone else is told so.

import { keywords } from './text.js';

const PENDING_TTL_MS = 30 * 60 * 1000;
const MAX_PEOPLE = 20;
const MIN_PREFIX = 3;
const ADD_RE = /\b(?:add|invite|put|bring)\b\s+(.+)/i;
// Where to add them: "here", "this group", or "to/into/in <group name>".
const HERE_RE = /\b(here|this (?:group|chat))\b/i;
const TO_RE = /\s+\b(?:to|into|in)\b\s+(?:the\s+)?(.+)$/i;
const FILLER_RE = /\b(as well|too|also|please|pls|plz|for me|now|again|thanks|thank you|the group|the chat|group|chat)\b/gi;
const NO_RE = /^(no|nope|cancel|stop|never ?mind|nvm)\b/i;

export const isOwner = (env, openId) => Boolean(openId) && String(env.OWNER_OPEN_IDS || '').split(',').map((s) => s.trim()).includes(openId);
const pendingKey = (chatId) => `admin:add:${chatId}`;

// "ADD kai here as well" → { names: ['kai'], here: true, group: '' }. null when it isn't an add request.
export function parseAdd(text) {
  const m = String(text || '').replace(/@_user_\d+|@\S+/g, ' ').match(ADD_RE);
  if (!m) return null;
  let rest = m[1].trim();
  const here = HERE_RE.test(rest);
  rest = rest.replace(HERE_RE, ' ');
  let group = '';
  const to = rest.match(TO_RE);
  if (to) { group = to[1].replace(FILLER_RE, ' ').trim(); rest = rest.slice(0, to.index); }
  const names = rest.replace(FILLER_RE, ' ').split(/,|&|\band\b|\+/i).map((n) => n.replace(/[^\p{L}\p{N}\s'-]/gu, ' ').replace(/\s+/g, ' ').trim()).filter(Boolean);
  return names.length ? { names: names.slice(0, MAX_PEOPLE), here, group } : null;
}

const norm = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);
function permutations(list) {
  if (list.length <= 1) return [list];
  return list.flatMap((x, i) => permutations([...list.slice(0, i), ...list.slice(i + 1)]).map((p) => [x, ...p]));
}

// How well a typed name fits a person's name: 3 exact (any order, spaces or not), 2 every word is one
// of theirs ("kai" → Tam Zhao Kai), 1 every word starts one of theirs ("chel"), 0 no match.
export function nameScore(query, name) {
  const q = norm(query);
  const n = norm(name);
  if (!q.length || !n.length) return 0;
  const joined = q.join('');
  if ((q.length === n.length && [...q].sort().join() === [...n].sort().join()) || (n.length <= 4 && permutations(n).some((p) => p.join('') === joined))) return 3;
  if (q.every((w) => n.includes(w))) return 2;
  if (q.every((w) => w.length >= MIN_PREFIX && n.some((t) => t.startsWith(w)))) return 1;
  return 0;
}

// Everyone in Eleyna's groups (the club's people), with a name. Member lists are cached for hours.
async function knownPeople(lark, groups) {
  const people = new Map();
  for (const g of groups) {
    for (const m of await lark.chatMembers(g.chat_id).catch(() => [])) if (m.member_id && m.name) people.set(m.member_id, { id: m.member_id, name: m.name });
  }
  return [...people.values()];
}

// The best-scoring people for one typed name.
export function matchName(query, people) {
  const scored = people.map((p) => ({ ...p, score: nameScore(query, p.name) })).filter((p) => p.score > 0);
  const best = Math.max(0, ...scored.map((p) => p.score));
  return scored.filter((p) => p.score === best).map(({ id, name }) => ({ id, name }));
}

// The group a name points to ("the qwen group"): the one sharing the most words with it, if only one does.
export function matchGroup(words, groups) {
  const want = new Set(keywords(words));
  if (!want.size) return null;
  const scored = groups.map((g) => ({ g, n: keywords(g.name).filter((w) => want.has(w)).length })).filter((x) => x.n > 0).sort((a, b) => b.n - a.n);
  return scored.length && (scored.length === 1 || scored[0].n > scored[1].n) ? scored[0].g : null;
}

const list = (people) => people.map((p) => `**${p.name}**`).join(', ');

// What to ask the owner, and what's saved until they answer.
function confirmText(found, target) {
  const options = found.flatMap((f) => (f.options.length > 1 ? f.options : []));
  if (options.length) {
    const sure = found.filter((f) => f.options.length === 1).map((f) => f.options[0]);
    return {
      text: [
        `More than one person matches. Which ${options.length > 2 ? 'ones' : 'one'} should I add to **${target.name}**? Reply with the number(s):`,
        ...options.map((p, i) => `${i + 1}. ${p.name}`),
        ...(sure.length ? [`(Also adding ${list(sure)}.)`] : []),
      ].join('\n'),
      pending: { target, sure, options },
    };
  }
  const people = found.map((f) => f.options[0]);
  return { text: `Just to check: add ${list(people)} to **${target.name}**? Reply **yes** to confirm.`, pending: { target, sure: people, options: [] } };
}

// A new "add …" message from the owner. Returns the reply text, or null if it isn't one.
export async function startAdd({ lark, store, chatId, isGroup, text }) {
  const req = parseAdd(text);
  if (!req) return null;
  const groups = await lark.listChats();
  const people = await knownPeople(lark, groups);
  const found = req.names.map((q) => ({ query: q, options: matchName(q, people) }));
  // "I want to add a poster idea", "add it to the wiki": nobody matches and no real group is named,
  // so it isn't a request to add people.
  if (found.every((f) => !f.options.length) && !req.here && !(req.group && matchGroup(req.group, groups))) return null;
  const missing = found.filter((f) => !f.options.length).map((f) => `"${f.query}"`);
  if (missing.length) return `I couldn't find ${missing.join(', ')} in any of my groups. Check the spelling, or add them yourself once (then I'll know them).`;
  const target = req.group ? matchGroup(req.group, groups) : isGroup ? groups.find((g) => g.chat_id === chatId) || { chat_id: chatId, name: 'this group' } : null;
  if (!target) {
    const named = req.group ? `I'm not sure which group "${req.group}" is.` : 'Which group should I add them to?';
    return `${named} Say it again with the group, e.g. "add ${req.names[0]} to ${groups[0]?.name || 'the event group'}". My groups: ${groups.map((g) => `**${g.name}**`).join(', ')}.`;
  }
  const { text: reply, pending } = confirmText(found, target);
  await store.kvSet(pendingKey(chatId), pending);
  return reply;
}

// The owner's answer to a pending add ("yes", "2", "1 and 3", "no"). Returns the reply, or null if
// nothing is pending or the message isn't an answer.
export async function answerAdd({ lark, store, chatId, text, isYes, log = () => {} }) {
  const pending = await store.kvGet(pendingKey(chatId), PENDING_TTL_MS).catch(() => undefined);
  if (!pending?.target) return null;
  const said = String(text || '').trim();
  if (NO_RE.test(said)) { await store.kvSet(pendingKey(chatId), null); return "OK, I won't add anyone."; }
  let people;
  if (pending.options.length) {
    const picks = /\b(all|both)\b/i.test(said) ? pending.options : [...said.matchAll(/\d+/g)].map((n) => pending.options[Number(n[0]) - 1]).filter(Boolean);
    if (!picks.length) return null;
    people = [...pending.sure, ...picks];
  } else if (isYes(said)) {
    people = pending.sure;
  } else {
    return null;
  }
  await store.kvSet(pendingKey(chatId), null);
  return addPeople({ lark, store, target: pending.target, people, log });
}

async function addPeople({ lark, store, target, people, log }) {
  const members = await (lark.chatMembersFresh || lark.chatMembers)(target.chat_id).catch(() => []);
  const already = people.filter((p) => members.some((m) => m.member_id === p.id));
  const toAdd = people.filter((p) => !already.includes(p));
  let refused = [];
  if (toAdd.length) {
    try {
      const res = await lark.addMembers(target.chat_id, toAdd.map((p) => p.id));
      const bad = new Set([...(res?.invalid_id_list || []), ...(res?.not_existed_id_list || [])]);
      refused = toAdd.filter((p) => bad.has(p.id));
    } catch (err) {
      log(`admin add ${target.chat_id}: ${err.message}`);
      return `I couldn't add ${list(toAdd)} to **${target.name}**: Lark said "${err.message.replace(/^Lark \S+ \S+: /, '').slice(0, 120)}". I may need to be the group's owner or an admin.`;
    }
    await store.kvSet(`lark:chatMembers:${target.chat_id}`, [...members, ...toAdd.filter((p) => !refused.includes(p)).map((p) => ({ member_id: p.id, name: p.name }))]).catch(() => {});
  }
  const added = toAdd.filter((p) => !refused.includes(p));
  return [
    added.length ? `Added ${list(added)} to **${target.name}** ✅` : '',
    already.length ? `${list(already)} ${already.length > 1 ? 'were' : 'was'} already in it.` : '',
    refused.length ? `Lark refused ${list(refused)}.` : '',
  ].filter(Boolean).join('\n');
}

// Someone other than the owner asks to add a person they named (not "add a poster to the wiki").
export async function asksToAddSomeone(lark, text) {
  const req = parseAdd(text);
  if (!req) return false;
  const people = await knownPeople(lark, await lark.listChats());
  return req.names.some((q) => matchName(q, people).length > 0);
}

export const NOT_OWNER = "Only EJ can add other people to groups. If you'd like to join one yourself, ask me about it in our DM.";
