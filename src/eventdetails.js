// The event-details message in an event group, posted once and pinned. Built from each calendar
// event itself: the time, the venue and address, and its description (where the organisers put the
// schedule and sessions, dress code, parking and transport, forms and registration links, the RSVP
// deadline). One read per event (cached 30 min); the description is shown once if sessions share it.

import { formatTime, messageText, keywords } from './text.js';

const DESC_CHARS = 2500;
const PINS_CHECKED = 5;
const MARK_TTL_MS = 365 * 86400 * 1000;
const markKey = (chatId) => `event-details:${chatId}`;

export async function detailsText({ lark, calendarId, events, tz }) {
  const full = await Promise.all(events.map((e) => lark.getEvent(calendarId, e.id).catch(() => null)));
  const descriptions = [];
  const heads = events.map((e, i) => {
    const f = full[i];
    if (!f) return `**${e.title}**\n${e.body || ''}`.trim();
    const where = [f.location?.name, f.location?.address].filter(Boolean).join(', ');
    const about = String(f.description || '').trim();
    if (about && !descriptions.includes(about)) descriptions.push(about);
    return [`**${f.summary || e.title}**`, `🕘 ${formatTime(f.start_time?.timestamp, tz)} – ${formatTime(f.end_time?.timestamp, tz)}`, where && `📍 ${where}`].filter(Boolean).join('\n');
  });
  return [...heads, ...descriptions.map((d) => d.slice(0, DESC_CHARS))].join('\n\n');
}

// Posts the details in the group and pins them. True when pinned.
export async function postAndPin({ lark, store, chatId, title, text, log = () => {} }) {
  try {
    const sent = await lark.sendPost(chatId, title, text);
    await lark.pinMessage(sent.message_id);
    await store.kvSet(markKey(chatId), true).catch(() => {});
    return true;
  } catch (err) {
    log(`event details ${chatId}: ${err.message}`);
    return false;
  }
}

// A pin already about these events: it names the first event, or shares most of its title's words.
function aboutEvents(pinText, events) {
  const text = String(pinText || '').toLowerCase();
  const title = String(events[0]?.title || '').toLowerCase();
  if (title && text.includes(title)) return true;
  const want = keywords(title);
  return want.length > 0 && want.filter((w) => text.includes(w)).length * 2 >= want.length;
}

// For a group that already exists: post and pin the details unless they're pinned there already.
// Returns 'already', 'pinned' or 'failed'.
export async function ensurePinned({ lark, store, chatId, title, calendarId, events, tz, log = () => {} }) {
  if (await store.kvGet(markKey(chatId), MARK_TTL_MS).catch(() => undefined)) return 'already';
  const pinIds = (await lark.pinnedMessageIds(chatId).catch(() => [])).slice(0, PINS_CHECKED);
  const pins = await Promise.all(pinIds.map((id) => lark.getMessage(id).catch(() => null)));
  if (pins.some((m) => m && aboutEvents(messageText(m.msg_type, m.body?.content), events))) {
    await store.kvSet(markKey(chatId), true).catch(() => {});
    return 'already';
  }
  const text = await detailsText({ lark, calendarId, events, tz });
  return (await postAndPin({ lark, store, chatId, title, text, log })) ? 'pinned' : 'failed';
}
