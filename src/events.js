// The owner sets up an event: a Lark group for the event day, calendar invites, and adding the
// people who accepted. Like admin.js, code decides everything: the request is parsed
// (eventparse.js), the events and people are matched, the owner sees the whole plan (group name,
// people, events) and nothing happens until they say yes. Only the owner (OWNER_OPEN_IDS) may.
// Lark calls are few: events come from the search index, attendees are read once per event.
// "Invite" means both: people are added to the event's group (if it has one) and get calendar
// invites. A group gets the event details posted and pinned once.

import { eventIdsFromDescription, formatTime, keywords } from './text.js';
import { knownPeople, matchName, matchGroup, addPeople } from './admin.js';
import { chatLink } from './join.js';
import { parseEventRequest } from './eventparse.js';
import { detailsText, postAndPin, ensurePinned } from './eventdetails.js';

export { parseEventRequest };

const PENDING_TTL_MS = 30 * 60 * 1000;
const DAY_S = 86400;
const LOOK_AHEAD_S = 180 * DAY_S;
// Lark takes at most 50 people when a group is made; the rest are added after, 50 at a time.
const BATCH = 50;
const NAME_CHARS = 50;
const NO_RE = /^(no|nope|cancel|stop|never ?mind|nvm)\b/i;
const SELF_RE = /^(me|myself|us|i)$/i;
const DEFAULT_TZ = 'Asia/Kuala_Lumpur';
const pendingKey = (chatId) => `admin:event:${chatId}`;
// admin.js's pending add in the same chat: one plan at a time, so one "yes" never runs a stale one.
const addKey = (chatId) => `admin:add:${chatId}`;
const list = (people) => people.map((p) => `**${p.name}**`).join(', ');
const larkSaid = (err) => String(err?.message || err).replace(/^Lark \S+ \S+: /, '').slice(0, 120);

// "The team": everyone in the team groups. TEAM_CHATS (comma-separated chat ids) if set, else
// the groups in GROUP_WIKIS ("oc_a=space,oc_b=space"), else the onboarding group.
export function teamChatIds(env = {}) {
  const ids = (s) => String(s || '').split(',').map((x) => x.trim()).filter(Boolean);
  if (env.TEAM_CHATS) return ids(env.TEAM_CHATS);
  const wikiGroups = ids(env.GROUP_WIKIS).map((pair) => pair.split('=')[0].trim()).filter(Boolean);
  return wikiGroups.length ? [...new Set(wikiGroups)] : ids(env.ONBOARDING_CHAT_ID);
}

export const eventDay = (ts, tz) => new Date(Number(ts) * 1000).toLocaleDateString('en-CA', { timeZone: tz });
const dayLabel = (ts, tz) => new Date(Number(ts) * 1000).toLocaleDateString('en-GB', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short' });
const dayMonth = (ts, tz) => new Date(Number(ts) * 1000).toLocaleDateString('en-GB', { timeZone: tz, day: 'numeric', month: 'short' });

// The bot's own calendar, where the events it's a guest of appear (as everywhere else in the code):
// events are found, read and given guests there, so the ids always belong to it.
const eventCalendar = (lark) => lark.primaryCalendarId();

// Upcoming events from the search index (no Lark call); the calendar is read once only if the
// index has none that match (say, an event added since the last 6-hourly refresh).
async function findEvents({ lark, store, req, tz, now }) {
  const nowS = Math.floor(now / 1000);
  const indexed = (await store.indexList('event').catch(() => []))
    .filter((e) => Number(e.at) >= nowS - DAY_S)
    .map((e) => ({ id: e.ref, title: e.title, body: e.body, at: Number(e.at) }));
  const hits = matchEvents(indexed, req.what, req.date, tz);
  if (hits.length) return hits;
  const calendarId = await eventCalendar(lark);
  const live = (await lark.listEvents(calendarId, nowS - DAY_S, nowS + LOOK_AHEAD_S).catch(() => []))
    .filter((e) => e.status !== 'cancelled' && e.summary)
    .map((e) => ({ id: e.event_id, title: e.summary, at: Number(e.start_time?.timestamp), body: [`${formatTime(e.start_time?.timestamp, tz)} – ${formatTime(e.end_time?.timestamp, tz)}`, e.location?.name && `Where: ${e.location.name}`].filter(Boolean).join('\n') }));
  return matchEvents(live, req.what, req.date, tz);
}

// A group's own events (its `event:` tags), from the index; any not indexed are read from the calendar.
async function groupEvents({ lark, store, ids, tz }) {
  const indexed = new Map((await store.indexList('event').catch(() => [])).map((e) => [e.ref, e]));
  const calendarId = ids.some((id) => !indexed.has(id)) ? await eventCalendar(lark) : null;
  const events = await Promise.all(ids.map(async (id) => {
    const e = indexed.get(id);
    if (e) return { id, title: e.title, body: e.body, at: Number(e.at) };
    const live = await lark.getEvent(calendarId, id).catch(() => null);
    return live && live.status !== 'cancelled' ? { id, title: live.summary, at: Number(live.start_time?.timestamp), body: formatTime(live.start_time?.timestamp, tz) } : null;
  }));
  return events.filter(Boolean).sort((a, b) => a.at - b.at);
}

// The events whose titles share the most words with the request, on the day named (if any).
export function matchEvents(events, what, date, tz) {
  const want = new Set(keywords(what));
  const scored = events.map((e) => ({ e, n: keywords(e.title).filter((w) => want.has(w)).length })).filter((x) => x.n > 0);
  const best = Math.max(0, ...scored.map((x) => x.n));
  const onDay = (e) => { const [, m, d] = eventDay(e.at, tz).split('-').map(Number); return !date || (m - 1 === date.month && d === date.day); };
  return scored.filter((x) => x.n === best && onDay(x.e)).map((x) => x.e).sort((a, b) => a.at - b.at);
}

// Named people (matched like admin.js) and/or the team. The owner is never in the list.
async function resolvePeople({ env, lark, req, groups, ownerId }) {
  const team = req.team ? await knownPeople(lark, teamChatIds(env).map((id) => ({ chat_id: id }))) : [];
  const everyone = req.names.length ? await knownPeople(lark, groups) : [];
  const found = req.names.map((q) => ({ q, options: matchName(q, everyone) }));
  const sure = found.filter((f) => f.options.length === 1).map((f) => f.options[0]);
  const people = [...new Map([...team, ...sure].map((p) => [p.id, p])).values()].filter((p) => p.id !== ownerId);
  return { people, missing: found.filter((f) => !f.options.length), unsure: found.filter((f) => f.options.length > 1) };
}

// "AiSED International Conference 2026: Opening" + "…: Panel" → the words they share, and the day.
export function groupFor(events, tz) {
  const words = events.map((e) => String(e.title).split(/\s+/));
  const shared = [];
  for (let i = 0; i < words[0].length && words.every((w) => w[i] === words[0][i]); i += 1) shared.push(words[0][i]);
  const base = (shared.length >= 2 ? shared.join(' ') : events[0].title).replace(/[\s:–—|·,-]+$/, '').slice(0, NAME_CHARS).trim();
  return {
    name: `${base} · ${dayMonth(events[0].at, tz)}`,
    description: `${base} · ${dayLabel(events[0].at, tz)} · ${events.map((e) => `event:${e.id}`).join(' ')}`,
  };
}

// The same events always give the same id, so a retried request can't make a second group.
function groupUuid(events) {
  let h = 0x811c9dc5;
  for (const ch of events.map((e) => e.id).sort().join(',')) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193) >>> 0;
  return `eleyna-${h.toString(16)}`;
}

function planText(plan, tz) {
  const lines = ["Here's the plan:"];
  if (plan.create) lines.push(`- **Group:** make **${plan.create.name}** with you as its owner${plan.groupPeople.length ? `, and add ${list(plan.groupPeople)}` : ' (people who accept the events join it on their own)'}. I'll post the event details there and pin them.`);
  else if (plan.group) lines.push(`- **Group:** ${plan.kind === 'setup' ? 'you already have' : 'add them to'} **${plan.group.name}**${plan.kind === 'setup' ? `; I'll add ${list(plan.groupPeople)} to it` : ''}, and pin the event details there if they aren't yet.`);
  else lines.push('- **Group:** these events have no group yet, so calendar invites only. To make one: "make a group for … on <day>".');
  if (plan.invite.length) lines.push(`- **Calendar invites** (Accept / Decline in Lark) to ${list(plan.invite)}. Anyone already invited is skipped.`);
  lines.push(`- **Events:**\n${plan.events.map((e) => `  - ${e.title} · ${formatTime(e.at, tz)}`).join('\n')}`);
  lines.push('Reply **yes** to go ahead, or **no** to cancel.');
  return lines.join('\n');
}

// What's wrong with a request before any plan, or null when it's fine.
function problems({ req, events, who, tz }) {
  if (who.missing.length) return `I couldn't find ${who.missing.map((f) => `"${f.q}"`).join(', ')} in any of my groups. Check the spelling, or add them to a group yourself once (then I'll know them).`;
  if (who.unsure.length) return who.unsure.map((f) => `"${f.q}" could be ${f.options.map((p) => `**${p.name}**`).join(' or ')}.`).join('\n') + '\nSay it again with the full name.';
  if (!events.length) return `I couldn't find an upcoming event matching "${req.what}"${req.date ? ' on that day' : ''}. Check the event's name in the calendar (I only see events I'm a guest of).`;
  const days = [...new Set(events.map((e) => eventDay(e.at, tz)))];
  if (req.kind === 'setup' && days.length > 1) {
    const first = days.map((d) => events.find((e) => eventDay(e.at, tz) === d));
    return `Which day? I make one group per event day:\n${first.map((e) => `- ${dayLabel(e.at, tz)}: ${e.title}`).join('\n')}\nSay it again with the day, e.g. "make a group for ${req.what} on ${dayMonth(first[0].at, tz)}".`;
  }
  if (req.kind === 'invite' && !who.people.length) return 'Everyone you named is you: there is nobody else to invite.';
  return null;
}

// A new event request from the owner. Returns the reply, or null if the message isn't one.
export async function startEvent({ env, lark, store, chatId, isGroup, text, ownerId, now = Date.now() }) {
  const req = parseEventRequest(text);
  if (!req) return null;
  const tz = env.TIMEZONE || DEFAULT_TZ;
  const groups = await lark.listChats();
  if (req.kind === 'accepted') return startAccepted({ lark, store, req, chatId, isGroup, groups });
  // "invite Cindy to the AiSED group": that group's own events. A group without events is
  // admin.js's plain add (null here).
  const named = req.toGroup ? (req.here ? (isGroup ? groups.find((g) => g.chat_id === chatId) : null) : matchGroup(req.what, groups)) : null;
  if (req.toGroup && !eventIdsFromDescription(named?.description).length) return null;
  const events = named ? await groupEvents({ lark, store, ids: eventIdsFromDescription(named.description), tz }) : await findEvents({ lark, store, req, tz, now });
  const who = await resolvePeople({ env, lark, req, groups, ownerId });
  // "I want to add a poster to the events page": no such event and nobody named, so not a request.
  if (req.kind === 'invite' && !events.length && !who.people.length) return null;
  const problem = problems({ req, events, who, tz });
  if (problem) return problem;
  const ids = events.map((e) => e.id);
  const existing = named || groups.find((g) => eventIdsFromDescription(g.description).some((id) => ids.includes(id)));
  const group = existing ? { chat_id: existing.chat_id, name: existing.name } : null;
  if (req.kind === 'setup' && group && !who.people.length) return `You already have **${group.name}** for these events. Name people (or "the team") to invite, e.g. "invite the team to the ${req.what} events".`;
  const plan = {
    kind: req.kind, ownerId, events, group,
    create: req.kind === 'setup' && !group ? groupFor(events, tz) : null,
    groupPeople: who.people,
    invite: who.people,
  };
  await store.kvSet(addKey(chatId), null).catch(() => {});
  await store.kvSet(pendingKey(chatId), plan);
  return planText(plan, tz);
}

// "add everyone who accepted to the AiSED group": accepted guests of the group's events not in it yet.
async function startAccepted({ lark, store, req, chatId, isGroup, groups }) {
  const withEvents = groups.filter((g) => eventIdsFromDescription(g.description).length);
  const target = req.here ? (isGroup ? groups.find((g) => g.chat_id === chatId) : null) : matchGroup(req.what, withEvents) || matchGroup(req.what, groups);
  if (!target) return `Which group? Say it with the group's name, e.g. "add everyone who accepted to the ${withEvents[0]?.name || 'AiSED'} group".`;
  const eventIds = eventIdsFromDescription(target.description);
  if (!eventIds.length) return `**${target.name}** has no events linked to it (no \`event:\` tags in its description), so I can't tell who accepted.`;
  const calendarId = await eventCalendar(lark);
  const accepted = new Map();
  for (const id of eventIds) {
    for (const a of await lark.eventAttendees(calendarId, id).catch(() => [])) {
      if (a.type === 'user' && a.user_id && a.rsvp_status === 'accept') accepted.set(a.user_id, { id: a.user_id, name: a.display_name || 'a guest' });
    }
  }
  const members = new Set((await (lark.chatMembersFresh || lark.chatMembers)(target.chat_id).catch(() => [])).map((m) => m.member_id));
  const missing = [...accepted.values()].filter((p) => !members.has(p.id));
  if (!missing.length) return `Everyone who accepted is already in **${target.name}**.`;
  await store.kvSet(addKey(chatId), null).catch(() => {});
  await store.kvSet(pendingKey(chatId), { kind: 'accepted', group: { chat_id: target.chat_id, name: target.name }, groupPeople: missing, invite: [], events: [] });
  return `${list(missing)} accepted but ${missing.length > 1 ? "aren't" : "isn't"} in **${target.name}** yet. Add them? Reply **yes** to confirm.`;
}

// The owner's answer to a pending plan ("yes" / "no"). Returns the reply, or null if nothing is
// pending or the message isn't an answer.
export async function answerEvent({ env, lark, store, chatId, text, isYes, log = () => {} }) {
  const plan = await store.kvGet(pendingKey(chatId), PENDING_TTL_MS).catch(() => undefined);
  if (!plan?.kind) return null;
  const said = String(text || '').trim();
  if (NO_RE.test(said)) { await store.kvSet(pendingKey(chatId), null); return "OK, I won't do anything."; }
  if (!isYes(said)) return null;
  // Cleared first: a retried "yes" (Lark resends slow events) can't run the plan twice.
  await store.kvSet(pendingKey(chatId), null);
  if (plan.kind === 'accepted') return addPeople({ lark, store, target: plan.group, people: plan.groupPeople, log });
  return carryOut({ env, lark, store, plan, log });
}

async function carryOut({ env, lark, store, plan, log }) {
  const tz = env.TIMEZONE || DEFAULT_TZ;
  const calendarId = await eventCalendar(lark);
  const lines = [];
  if (plan.create) {
    const made = await createGroup({ lark, store, plan, calendarId, tz, log });
    lines.push(made.text);
    // No group, no invites: the owner fixes the cause and asks again.
    if (!made.ok) return made.text;
  } else if (plan.group) {
    if (plan.groupPeople.length) lines.push(await addPeople({ lark, store, target: plan.group, people: plan.groupPeople, log }));
    const pin = await ensurePinned({ lark, store, chatId: plan.group.chat_id, title: `📌 ${plan.group.name}`, calendarId, events: plan.events, tz, log });
    if (pin === 'pinned') lines.push(`Posted and pinned the event details in **${plan.group.name}**.`);
    if (pin === 'failed') lines.push(`I couldn't post or pin the event details in **${plan.group.name}**.`);
  }
  if (plan.invite.length) lines.push(await sendInvites({ lark, plan, calendarId, log }));
  return lines.filter(Boolean).join('\n\n');
}

// Lark's words, and the permission to check only when it's a permission error.
function createFailed(err) {
  const said = larkSaid(err);
  const permission = /99991672|99991663|permission|scope|access denied/i.test(said);
  return `I couldn't make the group: Lark said "${said}".${permission ? ' I need the `im:chat:create` permission (AGENTS.md step 3).' : ''} Nothing else was done.`;
}

// Makes the group (the owner as its owner, the bot as an admin), posts the event details and pins them.
async function createGroup({ lark, store, plan, calendarId, tz, log }) {
  const { name, description } = plan.create;
  const ids = plan.groupPeople.map((p) => p.id);
  let res;
  try {
    res = await lark.createChat({ name, description, ownerId: plan.ownerId, userIds: ids.slice(0, BATCH), uuid: groupUuid(plan.events) });
  } catch (err) {
    log(`event group ${name}: ${err.message}`);
    return { ok: false, text: createFailed(err) };
  }
  const group = { chat_id: res.chat_id, name };
  for (let i = BATCH; i < ids.length; i += BATCH) await lark.addMembers(group.chat_id, ids.slice(i, i + BATCH)).catch((err) => log(`event group add: ${err.message}`));
  const refused = new Set(res.invalid_id_list || []);
  const inIt = plan.groupPeople.filter((p) => !refused.has(p.id));
  // Known at once: the group list and its members are cached for minutes to hours.
  const chats = await lark.listChats().catch(() => []);
  await store.kvSet('lark:listChats:all', [...chats.filter((g) => g.chat_id !== group.chat_id), { chat_id: group.chat_id, name, description }]).catch(() => {});
  await store.kvSet(`lark:chatMembers:${group.chat_id}`, [{ member_id: plan.ownerId }, ...inIt.map((p) => ({ member_id: p.id, name: p.name }))]).catch(() => {});
  const text = await detailsText({ lark, calendarId, events: plan.events, tz });
  const pinned = await postAndPin({ lark, store, chatId: group.chat_id, title: `📌 ${name}`, text, log });
  return { ok: true, text: [
    `Made **${name}** ✅ You're its owner${inIt.length ? `, with ${list(inIt)}` : ''}. [Open the group](${chatLink(group.chat_id)})`,
    pinned ? 'The event details are pinned there.' : "I posted the event details there but couldn't pin them.",
    refused.size ? `Lark refused ${list(plan.groupPeople.filter((p) => refused.has(p.id)))}.` : '',
  ].filter(Boolean).join('\n') };
}

// Adds the people as guests of each event, skipping anyone already on it. Stops at the first
// refusal: the rest would fail the same way.
async function sendInvites({ lark, plan, calendarId, log }) {
  const sentTo = new Map();
  const skipped = [];
  for (const e of plan.events) {
    try {
      const invited = new Set((await lark.eventAttendees(calendarId, e.id)).filter((a) => a.type === 'user' && a.user_id).map((a) => a.user_id));
      const missing = plan.invite.filter((p) => !invited.has(p.id));
      plan.invite.filter((p) => invited.has(p.id)).forEach((p) => skipped.push(`${p.name} (${e.title})`));
      if (missing.length) await lark.addAttendees(calendarId, e.id, missing.map((p) => p.id));
      missing.forEach((p) => sentTo.set(p.id, p));
    } catch (err) {
      log(`invite ${e.id}: ${err.message}`);
      return [
        inviteSummary(sentTo, skipped),
        `I couldn't send the calendar invites for **${e.title}**: Lark said "${larkSaid(err)}". I can only invite people to an event I organise, or one whose guests may invite others: in Lark, open the event → guest permissions → **Guests can invite others**, with me (Eleyna) as a guest. Setup: AGENTS.md step 3.`,
      ].filter(Boolean).join('\n');
    }
  }
  return inviteSummary(sentTo, skipped) || 'Everyone was already invited.';
}

function inviteSummary(sentTo, skipped) {
  return [
    sentTo.size ? `Calendar invites sent ✅ to ${list([...sentTo.values()])}: they'll see Accept / Decline in Lark.` : '',
    skipped.length ? `Skipped, already invited: ${skipped.map((s) => `**${s}**`).join(', ')}.` : '',
  ].filter(Boolean).join('\n');
}

// Someone other than the owner asks for an event set-up (not "invite me to the AiSED event").
export function asksForEventSetup(text) {
  const req = parseEventRequest(text);
  if (!req) return false;
  return req.kind !== 'invite' || req.team || req.names.some((n) => !SELF_RE.test(n));
}
