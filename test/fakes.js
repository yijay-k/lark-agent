// Shared test fakes: an in-memory store with the same methods as src/store.js.

export function fakeStore() {
  const messages = [];
  const briefings = new Set();
  const seen = new Set();
  const kv = new Map();
  const index = [];
  return {
    messages,
    briefings,
    firstTime: async (id) => (seen.has(id) ? false : (seen.add(id), true)),
    saveMessage: async (m) => { messages.push({ ...m, chat_id: m.chatId, sender_id: m.senderId, sender_name: m.senderName, created_at: m.createdAt }); },
    recentMessages: async (chatId) => messages.filter((m) => m.chatId === chatId),
    cachedPage: async () => null,
    savePage: async () => {},
    briefed: async (c, k) => briefings.has(`${c}|${k}`),
    markBriefed: async (c, k) => { briefings.add(`${c}|${k}`); },
    unmarkBriefed: async (c, k) => { briefings.delete(`${c}|${k}`); },
    kvGet: async (k) => kv.get(k),
    kvSet: async (k, v) => { kv.set(k, v); },
    bump: async () => {},
    clearChat: async (chatId) => { for (let i = messages.length - 1; i >= 0; i -= 1) if (messages[i].chatId === chatId) messages.splice(i, 1); },
    // Search: a word match in the title counts 5x one in the body, like the real BM25 weights.
    index,
    indexReplace: async (kind, ref, rows) => {
      for (let i = index.length - 1; i >= 0; i -= 1) if (index[i].kind === kind && index[i].ref === ref) index.splice(i, 1);
      rows.forEach((r) => index.push(row(kind, ref, r)));
    },
    indexAdd: async (kind, ref, r) => { index.push(row(kind, ref, r)); },
    indexKeepOnly: async (kind, refs) => { for (let i = index.length - 1; i >= 0; i -= 1) if (index[i].kind === kind && !refs.includes(index[i].ref)) index.splice(i, 1); },
    indexSearch: async (match, limit) => {
      const terms = [...match.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
      const score = (r) => terms.reduce((n, t) => n + (r.title.toLowerCase().includes(t) ? 5 : 0) + (r.body.toLowerCase().includes(t) ? 1 : 0), 0);
      return index.filter((r) => score(r) > 0).sort((a, b) => score(b) - score(a)).slice(0, limit);
    },
    indexList: async (kind) => index.filter((r) => r.kind === kind).sort((a, b) => a.at - b.at),
    backfillChat: async () => {},
  };
}

function row(kind, ref, r) {
  return { kind, ref, chat_id: r.chatId || '', title: r.title || '', body: r.body || '', url: r.url || '', at: Number(r.at || 0) };
}
