// A small Lark Open API client for the bot (tenant token = acting as the bot).
// Every call returns `data`, or throws with Lark's code and message.
// With a store, it caches the token and slow-changing reads, and counts every call:
// Lark's free plan allows about 10,000 API calls a month for the whole organisation.

const TOKEN_MARGIN_S = 300;
// A slow Lark call must never use up a message's ~30 s; and member lists are read in pages.
const CALL_TIMEOUT_MS = 8000;
const MEMBER_PAGES = 5;
const MIN = 60_000;
const TTL = Object.freeze({ chats: 10 * MIN, chat: 30 * MIN, members: 6 * 60 * MIN, pins: 30 * MIN, message: 30 * MIN, calendar: 24 * 60 * MIN, event: 30 * MIN });

export function usageKey(date = new Date()) {
  return `lark-calls:${date.toISOString().slice(0, 7)}`;
}

export function createLark(env, fetchImpl = fetch, store = null) {
  // Calls made in this run: Cloudflare's free plan allows 50 outside calls per run.
  let made = 0;
  const count = () => { made += 1; return store ? store.bump(usageKey()).catch(() => {}) : null; };
  const domain = env.LARK_DOMAIN || 'https://open.larksuite.com';
  let token = null; // { value, expiresAt } for this invocation

  async function tenantToken() {
    const now = Date.now() / 1000;
    if (!token && store) token = (await store.kvGet('lark:token', 2 * 60 * MIN).catch(() => undefined)) || null;
    if (token && token.expiresAt - TOKEN_MARGIN_S > now) return token.value;
    await count();
    const res = await fetchImpl(`${domain}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ app_id: env.LARK_APP_ID, app_secret: env.LARK_APP_SECRET }),
    });
    const body = await res.json();
    if (body.code !== 0) throw new Error(`Lark token: ${body.code} ${body.msg}`);
    token = { value: body.tenant_access_token, expiresAt: now + Number(body.expire || 0) };
    if (store) await store.kvSet('lark:token', token).catch(() => {});
    return token.value;
  }

  async function call(method, path, { query, json } = {}) {
    await count();
    const qs = query ? `?${new URLSearchParams(query)}` : '';
    const res = await fetchImpl(`${domain}/open-apis${path}${qs}`, {
      method,
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      headers: { authorization: `Bearer ${await tenantToken()}`, ...(json ? { 'content-type': 'application/json' } : {}) },
      body: json ? JSON.stringify(json) : undefined,
    });
    const body = await res.json().catch(() => ({ code: res.status, msg: 'no JSON' }));
    if (body.code !== 0) throw new Error(`Lark ${method} ${path}: ${body.code} ${body.msg}`);
    // Most endpoints wrap the result in `data`; a few (e.g. /bot/v3/info) put it at the top level.
    return body.data || body;
  }

  const api = {
    callsMade: () => made,
    botOpenId: async () => (await call('GET', '/bot/v3/info')).bot?.open_id,
    listChats: async () => (await call('GET', '/im/v1/chats', { query: { page_size: '100' } })).items || [],
    chatInfo: (chatId) => call('GET', `/im/v1/chats/${chatId}`),
    chatMembers: async (chatId) => {
      const all = [];
      let pageToken = '';
      for (let page = 0; page < MEMBER_PAGES; page += 1) {
        const data = await call('GET', `/im/v1/chats/${chatId}/members`, { query: { member_id_type: 'open_id', page_size: '100', ...(pageToken ? { page_token: pageToken } : {}) } });
        all.push(...(data.items || []));
        if (!data.has_more || !data.page_token) break;
        pageToken = data.page_token;
      }
      return all;
    },
    addMembers: (chatId, openIds) =>
      call('POST', `/im/v1/chats/${chatId}/members`, { query: { member_id_type: 'open_id' }, json: { id_list: openIds } }),
    pinnedMessageIds: async (chatId) =>
      ((await call('GET', '/im/v1/pins', { query: { chat_id: chatId, page_size: '20' } })).items || []).map((p) => p.message_id),
    getMessage: async (messageId) => (await call('GET', `/im/v1/messages/${messageId}`)).items?.[0],
    replyPost: (messageId, title, markdown) =>
      call('POST', `/im/v1/messages/${messageId}/reply`, { json: { msg_type: 'post', content: postContent(title, markdown) } }),
    sendPost: (chatId, title, markdown) =>
      call('POST', '/im/v1/messages', { query: { receive_id_type: 'chat_id' }, json: { receive_id: chatId, msg_type: 'post', content: postContent(title, markdown) } }),
    wikiSpaces: async () => (await call('GET', '/wiki/v2/spaces', { query: { page_size: '50' } })).items || [],
    wikiNodes: async (spaceId, parentToken) =>
      (await call('GET', `/wiki/v2/spaces/${spaceId}/nodes`, { query: { page_size: '50', ...(parentToken ? { parent_node_token: parentToken } : {}) } })).items || [],
    docText: async (documentId) => (await call('GET', `/docx/v1/documents/${documentId}/raw_content`)).content || '',
    sendPostToUser: (openId, title, markdown) =>
      call('POST', '/im/v1/messages', { query: { receive_id_type: 'open_id' }, json: { receive_id: openId, msg_type: 'post', content: postContent(title, markdown) } }),
    react: (messageId, emoji) =>
      call('POST', `/im/v1/messages/${messageId}/reactions`, { json: { reaction_type: { emoji_type: emoji } } }),
    primaryCalendarId: async () => (await call('POST', '/calendar/v4/calendars/primary')).calendars?.[0]?.calendar?.calendar_id,
    getEvent: async (calendarId, eventId) =>
      (await call('GET', `/calendar/v4/calendars/${encodeURIComponent(calendarId)}/events/${eventId}`)).event,
    // Every event on the bot's calendar between two times (seconds).
    listEvents: async (calendarId, startS, endS) =>
      (await call('GET', `/calendar/v4/calendars/${encodeURIComponent(calendarId)}/events`, {
        query: { start_time: String(startS), end_time: String(endS), page_size: '100' },
      })).items || [],
    // A card (JSON 2.0) as a reply, e.g. an answer with a Join button.
    replyCard: (messageId, card) =>
      call('POST', `/im/v1/messages/${messageId}/reply`, { json: { msg_type: 'interactive', content: JSON.stringify(card) } }),
    eventAttendees: async (calendarId, eventId) =>
      (await call('GET', `/calendar/v4/calendars/${encodeURIComponent(calendarId)}/events/${eventId}/attendees`, {
        query: { user_id_type: 'open_id', page_size: '100' },
      })).items || [],
    // A new group (scope im:chat:create): `ownerId` becomes its owner, the bot stays an admin. The
    // same `uuid` within 10 hours never makes a second group.
    createChat: ({ name, description, ownerId, userIds = [], uuid }) =>
      call('POST', '/im/v1/chats', {
        query: { user_id_type: 'open_id', set_bot_manager: 'true', ...(uuid ? { uuid } : {}) },
        json: { name, description, owner_id: ownerId, user_id_list: userIds, chat_mode: 'group', chat_type: 'private' },
      }),
    pinMessage: (messageId) => call('POST', '/im/v1/pins', { json: { message_id: messageId } }),
    // Guests of an event, who get Accept / Decline in Lark (scope calendar:calendar.event:update).
    addAttendees: (calendarId, eventId, openIds) =>
      call('POST', `/calendar/v4/calendars/${encodeURIComponent(calendarId)}/events/${eventId}/attendees`, {
        query: { user_id_type: 'open_id' },
        json: { attendees: openIds.map((id) => ({ type: 'user', user_id: id })), need_notification: true },
      }),
  };
  if (!store) return api;

  // Cached reads: same answer for a while, no API call.
  const cached = (name, ttl, keyOf) => async (...args) => {
    const key = `lark:${name}:${keyOf(...args)}`;
    const hit = await store.kvGet(key, ttl).catch(() => undefined);
    if (hit !== undefined) return hit;
    const value = await api[name](...args);
    await store.kvSet(key, value).catch(() => {});
    return value;
  };
  return {
    ...api,
    chatMembersFresh: api.chatMembers,
    botOpenId: cached('botOpenId', TTL.calendar, () => 'me'),
    listChats: cached('listChats', TTL.chats, () => 'all'),
    chatInfo: cached('chatInfo', TTL.chat, (c) => c),
    chatMembers: cached('chatMembers', TTL.members, (c) => c),
    pinnedMessageIds: cached('pinnedMessageIds', TTL.pins, (c) => c),
    getMessage: cached('getMessage', TTL.message, (m) => m),
    primaryCalendarId: cached('primaryCalendarId', TTL.calendar, () => 'me'),
    getEvent: cached('getEvent', TTL.event, (c, e) => e),
  };
}

// A Lark rich-text post rendered from markdown (the "md" element renders bold, lists and links).
// Lark drops blank lines inside one md element, so each paragraph becomes its own element with
// an empty line between them; otherwise sections run together.
export function postContent(title, markdown) {
  const paragraphs = String(markdown || '').split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const content = paragraphs.flatMap((p, i) => (i === 0 ? [] : [[{ tag: 'text', text: '' }]]).concat([[{ tag: 'md', text: p }]]));
  return JSON.stringify({ en_us: { title: title || '', content: content.length ? content : [[{ tag: 'md', text: '' }]] } });
}
