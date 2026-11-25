// Reading the owner's event requests, in code (never by the AI):
//   "make a group for AiSED on 2 Dec and invite the team"   → setup
//   "invite Cindy and Ken to the AiSED events"              → invite (calendar invites)
//   "add everyone who accepted to the AiSED group"          → accepted (into the group)
// A plain "add kai to the qwen group" is not one of these: admin.js handles it.

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
// Month names only, whole words: "5 decisions" is not 5 Dec.
const MON = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\b\\.?';
const ORD = '(?:st|nd|rd|th)?';
const DAY_MONTH_RE = new RegExp(`\\b(?:on\\s+)?(\\d{1,2})${ORD}\\s+(?:of\\s+)?${MON}(?:\\s+\\d{4})?`, 'i');
const MONTH_DAY_RE = new RegExp(`\\b(?:on\\s+)?${MON}\\s+(\\d{1,2})${ORD}\\b(?:,?\\s+\\d{4})?`, 'i');
const MAX_PEOPLE = 50;

const SETUP_RE = /\b(?:make|create|set\s?up|open|start)\s+(?:an?\s+|the\s+)?(?:new\s+)?(?:event\s+)?(?:group(?:\s?chat)?|gc)\s+(?:for\s+)?(.+)$/i;
const SETUP_INVITE_RE = /\s*,?\s+\band\s+(?:invite|add)\s+(.+)$/i;
const ACCEPTED_RE = /\b(?:add|invite|put|bring|pull)\s+(?:in\s+)?(?:everyone|everybody|all|people|those|anyone)\b.*?\b(?:accepted|is going|are going|rsvp'?d|confirmed|said yes)\b(.*)$/i;
const INVITE_RE = /\b(send\s+(?:calendar\s+)?invites?\s+to|invite|add)\s+(.+?)\s+\b(?:to|for)\s+(.+)$/i;
const INVITE_HERE_RE = /\binvite\s+(.+?)\s+(?:here|in(?:to)? this (?:group|chat)|to this (?:group|chat))\b/i;
const EVENT_WORD_RE = /\b(?:events?|calendar(?:\s+events?)?|sessions?|invites?)\b/gi;
const GROUP_WORD_RE = /\b(?:group|gc|chat)\b/i;
const HERE_RE = /\b(?:here|this (?:group|chat))\b/i;
const TEAM_RE = /^(?:the\s+)?(?:whole\s+|entire\s+|full\s+)?team$|^everyone(?:\s+in\s+the\s+team)?$/i;
const FILLER_RE = /\b(?:as well|too|also|please|pls|plz|for me|now|thanks|thank you)\b/gi;
const TARGET_FILLER_RE = /^(?:\s*(?:to|into|in|for|of|the|all|my|our)\b\s*)+|\b(?:group(?:\s?chat)?|gc|chat)\b/gi;

const tidy = (s) => String(s || '').replace(/[?!.]+$/g, '').replace(/\s+/g, ' ').trim();

// "on 2 Dec", "Dec 3rd", "2 December 2026" → { day, month (0-11), rest: the text without it }.
export function takeDate(text) {
  const s = String(text || '');
  const dm = s.match(DAY_MONTH_RE);
  if (dm) return { date: { day: Number(dm[1]), month: MONTHS.indexOf(dm[2].slice(0, 3).toLowerCase()) }, rest: s.replace(dm[0], ' ') };
  const md = s.match(MONTH_DAY_RE);
  if (md) return { date: { day: Number(md[2]), month: MONTHS.indexOf(md[1].slice(0, 3).toLowerCase()) }, rest: s.replace(md[0], ' ') };
  return { date: null, rest: s };
}

// "the team and Cindy, Ken" → { team: true, names: ['Cindy', 'Ken'] }.
export function splitPeople(text) {
  const parts = tidy(String(text || '').replace(FILLER_RE, ' '))
    .split(/,|&|\band\b|\+/i)
    .map((p) => p.replace(/[^\p{L}\p{N}\s'-]/gu, ' ').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  const team = parts.some((p) => TEAM_RE.test(p));
  return { team, names: parts.filter((p) => !TEAM_RE.test(p)).slice(0, MAX_PEOPLE) };
}

// Which event(s) the words name: "the AiSED events on 2 Dec" → { what: 'AiSED', date }.
function eventTarget(text) {
  const { date, rest } = takeDate(text);
  const what = tidy(rest.replace(EVENT_WORD_RE, ' ').replace(TARGET_FILLER_RE, ' ').replace(FILLER_RE, ' ').replace(/\bon\s*$/i, ''));
  return { what, date };
}

function parseSetup(text) {
  const m = text.match(SETUP_RE);
  if (!m) return null;
  const invite = m[1].match(SETUP_INVITE_RE);
  const who = invite ? splitPeople(invite[1]) : { team: false, names: [] };
  const { what, date } = eventTarget(invite ? m[1].slice(0, invite.index) : m[1]);
  return what ? { kind: 'setup', what, date, team: who.team, names: who.names, here: false } : null;
}

function parseAccepted(text) {
  const m = text.match(ACCEPTED_RE);
  if (!m) return null;
  const here = HERE_RE.test(m[1]);
  const { what, date } = eventTarget(m[1].replace(HERE_RE, ' '));
  return { kind: 'accepted', what, date, team: false, names: [], here };
}

// An invite names events ("to the AiSED events", "for AiSED on 3 Dec") or, said with "invite",
// a group ("invite Cindy to the AiSED group", "invite Cindy here"): `toGroup`, which events.js
// takes only if that group has events (else admin.js adds them plainly). "add kai to the qwen
// group" names neither an event nor a date, so it isn't one.
function parseInvite(text) {
  const here = text.match(INVITE_HERE_RE);
  if (here) {
    const who = splitPeople(here[1]);
    return who.team || who.names.length ? { kind: 'invite', what: '', date: null, team: who.team, names: who.names, here: true, toGroup: true } : null;
  }
  const m = text.match(INVITE_RE);
  if (!m) return null;
  const [, verb, people, target] = m;
  const toGroup = GROUP_WORD_RE.test(target);
  if (toGroup ? !/invite/i.test(verb) : !new RegExp(EVENT_WORD_RE.source, 'i').test(target) && !takeDate(target).date) return null;
  const who = splitPeople(people);
  const { what, date } = eventTarget(target);
  if (!what || (!who.team && !who.names.length)) return null;
  return { kind: 'invite', what, date, team: who.team, names: who.names, here: false, ...(toGroup ? { toGroup: true } : {}) };
}

// The request, or null when the message isn't one.
export function parseEventRequest(text) {
  const s = String(text || '').replace(/@_user_\d+|@\S+/g, ' ').replace(/\s+/g, ' ').trim();
  return parseAccepted(s) || parseSetup(s) || parseInvite(s);
}
