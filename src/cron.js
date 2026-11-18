// Every 6 hours (the cron in wrangler.toml), in order of importance: add people who accepted any of a
// group's events and post its "Good to know" note (once) and the reminder the day before; refresh the
// search index; retry failed memory vectors; catch up memory for quiet chats; prune old rows.

import { eventIdsFromDescription } from './text.js';
import { groupContext, contextText } from './context.js';
import { briefingSystem, briefingPrompt } from './prompts.js';
import { think } from './brain.js';
import { today } from './handlers.js';
import { checkAlerts } from './usage.js';
import { refreshIndex } from './search.js';
import { foldChat, chatMemory, retryPendingVectors } from './memory.js';

const DAY_S = 86400;

// Accepted any event → member. Never removes anyone.
export async function syncMembers({ lark, chatId, eventIds, calendarId }) {
  const accepted = new Set();
  for (const id of eventIds) {
    const attendees = await lark.eventAttendees(calendarId, id).catch(() => []);
    attendees.filter((a) => a.type === 'user' && a.rsvp_status === 'accept' && a.user_id).forEach((a) => accepted.add(a.user_id));
  }
  const members = new Set((await (lark.chatMembersFresh || lark.chatMembers)(chatId)).map((m) => m.member_id));
  const missing = [...accepted].filter((id) => !members.has(id));
  if (missing.length > 0) await lark.addMembers(chatId, missing);
  return missing;
}

function dayKey(ts, tz) {
  return new Date(Number(ts) * 1000).toLocaleDateString('en-CA', { timeZone: tz });
}

async function brief({ env, lark, store, chatId, kind, log, fetchImpl }) {
  const tz = env.TIMEZONE || 'Asia/Kuala_Lumpur';
  const ctx = await groupContext({ env, lark, store, chatId, fetchImpl });
  const { text, via } = await think(env, briefingSystem(ctx.name, today(tz)), briefingPrompt(contextText(ctx), kind), log, fetchImpl);
  await lark.sendPost(chatId, kind === 'eve' ? '🔔 Tomorrow: good to know' : '💡 Good to know', text);
  await store.markBriefed(chatId, kind);
  log(`briefing ${kind} in ${chatId} via ${via}`);
}

const QUIET_MS = 30 * 60 * 1000;
const LOOK_BACK_MS = 7 * DAY_S * 1000;
const FOLDS_PER_RUN = 3;
// Each fold makes 1–3 outside calls; memory stops for this run past this many (50 is the free limit).
const CALLS_BEFORE_MEMORY_STOPS = 40;

// Quiet chats with messages memory hasn't taken in (fewer than the 15 that trigger it at once).
export async function catchUpMemory({ env, lark, store, log = () => {}, fetchImpl = fetch, now = Date.now() }) {
  if (!(env.GEMINI_API_KEY || env.AI)) return 0;
  const groups = new Set((await lark.listChats()).map((g) => g.chat_id));
  let done = 0;
  for (const { chat_id: chatId, last, seq } of await store.activeChats(now - LOOK_BACK_MS)) {
    if (done >= FOLDS_PER_RUN || (lark.callsMade && lark.callsMade() + done * 2 > CALLS_BEFORE_MEMORY_STOPS)) break;
    if (now - Number(last) < QUIET_MS || Number(seq) <= (await chatMemory(store, chatId)).cursor) continue;
    const result = await foldChat({ env, lark, store, chatId, isPrivate: !groups.has(chatId), today: today(env.TIMEZONE || 'Asia/Kuala_Lumpur'), log, fetchImpl, now })
      .catch((err) => (log(`memory ${chatId}: ${err.message}`), null));
    if (result) done += 1;
  }
  return done;
}

// Event groups: add people who accepted, post the notes. Done first: it's the cron's main job.
async function runEventGroups({ env, lark, store, log, fetchImpl, now }) {
  const tz = env.TIMEZONE || 'Asia/Kuala_Lumpur';
  const groups = (await lark.listChats()).filter((c) => eventIdsFromDescription(c.description).length > 0);
  if (groups.length === 0) return;
  const calendarId = await lark.primaryCalendarId();
  for (const group of groups) {
    const eventIds = eventIdsFromDescription(group.description);
    try {
      // Nothing to do for a group whose events are all over: saves Lark API calls.
      const events = (await Promise.all(eventIds.map((id) => lark.getEvent(calendarId, id).catch(() => null)))).filter((e) => e && e.status !== 'cancelled');
      if (events.length === 0 || events.every((e) => Number(e.end_time?.timestamp) * 1000 < now)) continue;
      const added = await syncMembers({ lark, chatId: group.chat_id, eventIds, calendarId });
      if (added.length > 0) log(`added ${added.length} to ${group.chat_id}`);
      // Notes wait for Gemini: the backup brain can't search, so it would write a thinner note.
      if (!env.GEMINI_API_KEY) continue;
      if (!(await store.briefed(group.chat_id, 'intro'))) {
        await brief({ env, lark, store, chatId: group.chat_id, kind: 'intro', log, fetchImpl });
      }
      const starts = events.map((e) => Number(e.start_time?.timestamp));
      const first = Math.min(...starts);
      const tomorrow = dayKey(now / 1000 + DAY_S, tz);
      const eveKind = `eve:${dayKey(first, tz)}`;
      if (Number.isFinite(first) && dayKey(first, tz) === tomorrow && !(await store.briefed(group.chat_id, eveKind))) {
        await brief({ env, lark, store, chatId: group.chat_id, kind: 'eve', log, fetchImpl });
        await store.markBriefed(group.chat_id, eveKind);
      }
    } catch (err) {
      log(`cron: group ${group.chat_id} failed: ${err.message}`);
    }
  }
}

// In order of importance, so the outside-call limit runs out on the least important step.
export async function runCron({ env, lark, store, log = console.log, fetchImpl = fetch, now = Date.now() }) {
  const step = (name, fn) => fn().catch((err) => log(`${name}: ${err.message}`));
  await step('alerts', () => checkAlerts({ env, lark, store, log }));
  await step('event groups', () => runEventGroups({ env, lark, store, log, fetchImpl, now }));
  await step('index', () => refreshIndex({ env, lark, store, log, now }));
  await step('vectors', () => retryPendingVectors({ env, store, log }));
  await step('memory', () => catchUpMemory({ env, lark, store, log, fetchImpl, now }));
  await step('prune', async () => store.prune(now, (await lark.listChats()).map((g) => g.chat_id)));
}
