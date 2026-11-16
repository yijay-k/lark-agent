// Every 10 minutes: add people who accepted any of a group's events, and post the
// group's "Good to know" note once, plus a reminder the day before.

import { eventIdsFromDescription } from './text.js';
import { groupContext, contextText } from './context.js';
import { briefingSystem, briefingPrompt } from './prompts.js';
import { think } from './brain.js';
import { today } from './handlers.js';

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

export async function runCron({ env, lark, store, log = console.log, fetchImpl = fetch, now = Date.now() }) {
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
