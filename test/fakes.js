// Shared test fakes: an in-memory store with the same methods as src/store.js.

export function fakeStore() {
  const messages = [];
  const briefings = new Set();
  const seen = new Set();
  const kv = new Map();
  const index = [];
  const memoryRows = [];
  return {
    messages,
    briefings,
    firstTime: async (id) => (seen.has(id) ? false : (seen.add(id), true)),
    // `seq` is the row number, in the order messages were saved (like SQLite's rowid).
    saveMessage: async (m) => { if (!messages.some((x) => x.messageId === m.messageId)) messages.push({ ...m, seq: messages.length ? Math.max(...messages.map((x) => x.seq)) + 1 : 1, message_id: m.messageId, chat_id: m.chatId, sender_id: m.senderId, sender_name: m.senderName, created_at: m.createdAt }); },
    recentMessages: async (chatId) => messages.filter((m) => m.chatId === chatId).sort((a, b) => a.seq - b.seq),
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
    indexSearch: async (match, limit, { chats = [], kinds = null } = {}) => {
      const terms = [...match.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
      const score = (r) => terms.reduce((n, t) => n + (r.title.toLowerCase().includes(t) ? 5 : 0) + (r.body.toLowerCase().includes(t) ? 1 : 0), 0);
      const visible = (r) => (['event', 'doc', 'group'].includes(r.kind) || chats.includes(r.chat_id)) && (!kinds || kinds.includes(r.kind));
      return index.filter((r) => visible(r) && score(r) > 0).sort((a, b) => score(b) - score(a)).slice(0, limit);
    },
    indexList: async (kind) => index.filter((r) => r.kind === kind).sort((a, b) => a.at - b.at),
    backfillChat: async () => {},
    indexKeepOnly: async (kind, refs) => {
      const gone = [...new Set(index.filter((r) => r.kind === kind && !refs.includes(r.ref)).map((r) => r.ref))];
      for (let i = index.length - 1; i >= 0; i -= 1) if (index[i].kind === kind && !refs.includes(index[i].ref)) index.splice(i, 1);
      return gone;
    },
    // Memory.
    memoryRows,
    messagesSince: async (chatId, seq, limit) => messages.filter((m) => m.chatId === chatId && m.seq > seq).sort((a, b) => a.seq - b.seq).slice(0, limit),
    countSince: async (chatId, seq) => messages.filter((m) => m.chatId === chatId && m.seq > seq && m.senderId !== 'bot').length,
    lastSeq: async () => (messages.length ? Math.max(...messages.map((m) => m.seq)) : 0),
    activeChats: async (since) => [...new Set(messages.filter((m) => m.created_at > since).map((m) => m.chatId))].map((c) => {
      const mine = messages.filter((m) => m.chatId === c);
      return { chat_id: c, last: Math.max(...mine.map((m) => m.created_at)), seq: Math.max(...mine.map((m) => m.seq)) };
    }),
    oldestMemoryIds: async (chatId, n) => memoryRows.filter((m) => m.chat_id === chatId).sort((a, b) => a.updated_at - b.updated_at || a.id - b.id).slice(0, n).map((m) => m.id),
    applyMemory: async (chatId, plan, kvPairs, at) => {
      for (const a of plan.add) { memoryRows.push({ id: a.id, chat_id: chatId, text: a.text, sources: JSON.stringify(a.sources || []), created_at: at, updated_at: at }); index.push(row('memory', String(a.id), { chatId, body: a.text, at })); }
      for (const u of plan.update) {
        const m = memoryRows.find((x) => x.id === u.id && x.chat_id === chatId);
        if (m) Object.assign(m, { text: u.text, updated_at: at });
        const ri = index.findIndex((x) => x.kind === 'memory' && x.ref === String(u.id));
        if (ri >= 0) index.splice(ri, 1);
        index.push(row('memory', String(u.id), { chatId, body: u.text, at }));
      }
      for (const id of plan.remove) {
        const i = memoryRows.findIndex((x) => x.id === id && x.chat_id === chatId);
        if (i >= 0) memoryRows.splice(i, 1);
        const ri = index.findIndex((x) => x.kind === 'memory' && x.ref === String(id));
        if (ri >= 0) index.splice(ri, 1);
      }
      for (const [k, v] of kvPairs) kv.set(k, v);
    },
    prune: async () => {},
    memories: async (chatId, limit) => memoryRows.filter((m) => m.chat_id === chatId).sort((a, b) => b.updated_at - a.updated_at || b.id - a.id).slice(0, limit),
    memoriesByIds: async (ids) => memoryRows.filter((m) => ids.includes(m.id)),
    memoryCount: async (chatId) => memoryRows.filter((m) => m.chat_id === chatId).length,
    addMemory: async ({ chatId, text, sources, at }) => { const id = memoryRows.length ? Math.max(...memoryRows.map((m) => m.id)) + 1 : 1; memoryRows.push({ id, chat_id: chatId, text, sources: JSON.stringify(sources), created_at: at, updated_at: at }); return id; },
    updateMemory: async (id, text, at) => { const m = memoryRows.find((x) => x.id === id); if (m) Object.assign(m, { text, updated_at: at }); },
    deleteMemory: async (id) => { const i = memoryRows.findIndex((x) => x.id === id); if (i >= 0) memoryRows.splice(i, 1); },
    deleteMemoriesOf: async (chatId) => {
      const ids = memoryRows.filter((m) => m.chat_id === chatId).map((m) => m.id);
      for (const id of ids) memoryRows.splice(memoryRows.findIndex((x) => x.id === id), 1);
      for (let i = index.length - 1; i >= 0; i -= 1) if (index[i].kind === 'memory' && index[i].chat_id === chatId) index.splice(i, 1);
      return ids;
    },
  };
}

function row(kind, ref, r) {
  return { kind, ref, chat_id: r.chatId || '', title: r.title || '', body: r.body || '', url: r.url || '', at: Number(r.at || 0) };
}
