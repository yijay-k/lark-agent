// A small Lark Open API client for the bot (tenant token = acting as the bot).
// Every call returns `data`, or throws with Lark's code and message.

const TOKEN_MARGIN_S = 300;

export function createLark(env, fetchImpl = fetch) {
  const domain = env.LARK_DOMAIN || 'https://open.larksuite.com';
  let token = null; // { value, expiresAt } for this invocation

  async function tenantToken() {
    const now = Date.now() / 1000;
    if (token && token.expiresAt - TOKEN_MARGIN_S > now) return token.value;
    const res = await fetchImpl(`${domain}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ app_id: env.LARK_APP_ID, app_secret: env.LARK_APP_SECRET }),
    });
    const body = await res.json();
    if (body.code !== 0) throw new Error(`Lark token: ${body.code} ${body.msg}`);
    token = { value: body.tenant_access_token, expiresAt: now + Number(body.expire || 0) };
    return token.value;
  }

  async function call(method, path, { query, json } = {}) {
    const qs = query ? `?${new URLSearchParams(query)}` : '';
    const res = await fetchImpl(`${domain}/open-apis${path}${qs}`, {
      method,
      headers: { authorization: `Bearer ${await tenantToken()}`, ...(json ? { 'content-type': 'application/json' } : {}) },
      body: json ? JSON.stringify(json) : undefined,
    });
    const body = await res.json().catch(() => ({ code: res.status, msg: 'no JSON' }));
    if (body.code !== 0) throw new Error(`Lark ${method} ${path}: ${body.code} ${body.msg}`);
    // Most endpoints wrap the result in `data`; a few (e.g. /bot/v3/info) put it at the top level.
    return body.data || body;
  }

  return {
    botOpenId: async () => (await call('GET', '/bot/v3/info')).bot?.open_id,
    listChats: async () => (await call('GET', '/im/v1/chats', { query: { page_size: '100' } })).items || [],
    chatInfo: (chatId) => call('GET', `/im/v1/chats/${chatId}`),
    chatMembers: async (chatId) =>
      (await call('GET', `/im/v1/chats/${chatId}/members`, { query: { member_id_type: 'open_id', page_size: '100' } })).items || [],
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
    react: (messageId, emoji) =>
      call('POST', `/im/v1/messages/${messageId}/reactions`, { json: { reaction_type: { emoji_type: emoji } } }),
    primaryCalendarId: async () => (await call('POST', '/calendar/v4/calendars/primary')).calendars?.[0]?.calendar?.calendar_id,
    getEvent: async (calendarId, eventId) =>
      (await call('GET', `/calendar/v4/calendars/${encodeURIComponent(calendarId)}/events/${eventId}`)).event,
    eventAttendees: async (calendarId, eventId) =>
      (await call('GET', `/calendar/v4/calendars/${encodeURIComponent(calendarId)}/events/${eventId}/attendees`, {
        query: { user_id_type: 'open_id', page_size: '100' },
      })).items || [],
  };
}

// A Lark rich-text post rendered from markdown (the "md" element renders bold, lists and links).
export function postContent(title, markdown) {
  return JSON.stringify({ en_us: { title: title || '', content: [[{ tag: 'md', text: markdown }]] } });
}
