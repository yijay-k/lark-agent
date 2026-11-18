// Joining a group from a private chat. Every event and group is open to everyone, but a
// group's chat is for its members: Eleyna offers the group a question is about, adds the
// person when they tap Join (or reply "yes"), then sends them its details.
// Code decides what is offered and who is added; the AI only words the answer.

const OFFER_TTL_MS = 60 * 60 * 1000;
const MAX_OFFERS = 2;
const DETAILS_CHARS = 700;
const YES_RE = /^(y|ya|yah|yes|yea|yeah|yep|yup|sure|ok|okay|okie|pls|please|add me|join|go ahead|do it|of course)([\s,!.]+(please|pls|thanks|thank you|thx|add me|sure|yes|ok))*[\s!.]*$/i;
// Said outright only: "can I join?" gets an offer and a question first.
const JOIN_RE = /\b(add me|let me in|invite me|put me in)\b/i;

export const isYes = (text) => String(text || '').trim().length <= 40 && YES_RE.test(String(text || '').trim());
export const wantsToJoin = (text) => JOIN_RE.test(String(text || ''));
const chatLink = (chatId) => `https://applink.larksuite.com/client/chat/open?openChatId=${encodeURIComponent(chatId)}`;
const offerKey = (dmChatId) => `join-offer:${dmChatId}`;

// Groups the owner keeps closed (CLOSED_GROUPS in wrangler.toml): never offered, never joined.
export const closedGroups = (env = {}) => new Set(String(env.CLOSED_GROUPS || '').split(',').map((s) => s.trim()).filter(Boolean));

// The groups the search hits belong to that this person isn't in (at most two).
export function offersFrom(hits, memberOf, groupName, closed = new Set()) {
  const ids = [...new Set(hits.map((h) => h.chat_id).filter((id) => id && !memberOf.has(id) && groupName.has(id) && !closed.has(id)))];
  return ids.slice(0, MAX_OFFERS).map((id) => ({ chat_id: id, name: groupName.get(id) }));
}

export const saveOffer = (store, dmChatId, offers) => store.kvSet(offerKey(dmChatId), offers).catch(() => {});
export const dropOffer = (store, dmChatId) => store.kvSet(offerKey(dmChatId), []).catch(() => {});
export async function pendingOffer(store, dmChatId) {
  return (await store.kvGet(offerKey(dmChatId), OFFER_TTL_MS).catch(() => undefined)) || [];
}

// The line under an answer that offers groups.
export function offerHint(offers, button) {
  const names = offers.map((o) => `**${o.name}**`).join(' or ');
  return button ? `_Tap **Join** below (or reply **yes**) and I'll add you to ${names}._` : `_Reply **yes** and I'll add you to ${names}._`;
}

// A Lark card (JSON 2.0): the answer, then one Join button per group.
export function answerCard(markdown, offers) {
  return {
    schema: '2.0',
    body: {
      elements: [
        { tag: 'markdown', content: markdown },
        ...offers.map((o) => ({
          tag: 'button',
          type: 'primary_filled',
          text: { tag: 'plain_text', content: `Join ${o.name}`.slice(0, 100) },
          behaviors: [{ type: 'callback', value: { action: 'join', chat_id: o.chat_id } }],
        })),
      ],
    },
  };
}

// What a new member gets right after joining: the group's events from the index, and a link to open it.
async function groupDetails({ store, group }) {
  const events = (await store.indexList('event').catch(() => [])).filter((e) => e.chat_id === group.chat_id);
  const about = String(group.description || '').replace(/event:[A-Za-z0-9_-]+/g, '').trim();
  const lines = [`You're in **${group.name}** now 🎉 [Open the group](${chatLink(group.chat_id)})`];
  if (events.length) {
    lines.push(events.map((e) => `**${e.title}**\n${String(e.body || '').slice(0, events.length > 1 ? 200 : DETAILS_CHARS)}`).join('\n\n'));
  } else if (about) {
    lines.push(about);
  }
  lines.push('Ask me anything about it inside the group: I know its pinned notes and chat there.');
  return lines.join('\n\n');
}

// Adds one person to one group the bot is in. Returns { ok, name, already, details } or { ok: false, error }.
export async function joinGroup({ env = {}, lark, store, userId, chatId, log = () => {} }) {
  const group = (await lark.listChats()).find((g) => g.chat_id === chatId);
  if (!group || closedGroups(env).has(chatId)) return { ok: false, error: "That group doesn't take new members through me. Ask EJ." };
  const members = await (lark.chatMembersFresh || lark.chatMembers)(chatId).catch(() => []);
  const already = members.some((m) => m.member_id === userId);
  if (!already) {
    try {
      const res = await lark.addMembers(chatId, [userId]);
      if ((res?.invalid_id_list || []).length || (res?.not_existed_id_list || []).length) throw new Error('Lark refused this account');
    } catch (err) {
      log(`join ${chatId}: ${err.message}`);
      return { ok: false, name: group.name, error: `I couldn't add you to **${group.name}** (only its admins may add people, or Lark refused). Ask EJ to add you.` };
    }
    // The member list is cached for hours: update it so she doesn't offer the group again.
    await store.kvSet(`lark:chatMembers:${chatId}`, [...members, { member_id: userId }]).catch(() => {});
    log(`joined ${userId.slice(0, 8)}… to ${chatId}`);
  }
  return { ok: true, already, name: group.name, details: await groupDetails({ store, group }) };
}

// A Join button was tapped (Lark's card.action.trigger callback). Returns the toast Lark shows at
// once and the DM to send after, or null when the tap isn't a join (or was already handled).
export async function joinFromTap({ env, lark, store, body, log = () => {} }) {
  let value = body?.event?.action?.value || {};
  if (typeof value === 'string') { try { value = JSON.parse(value); } catch { value = {}; } }
  const userId = body?.event?.operator?.open_id;
  if (value.action !== 'join' || !value.chat_id || !userId) return null;
  const tapId = body.header?.event_id || body.event?.token;
  if (tapId && !(await store.firstTime(`tap:${tapId}`))) return null;
  const res = await joinGroup({ env, lark, store, userId, chatId: value.chat_id, log });
  const dm = res.ok ? (res.already ? `You're already in **${res.name}**.\n\n${res.details}` : res.details) : res.error;
  const toast = res.ok ? (res.already ? `You're already in ${res.name}` : `Added you to ${res.name}`) : "Couldn't add you: see my message";
  return { userId, dm, toast: { type: res.ok ? 'success' : 'error', content: toast } };
}
