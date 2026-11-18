// What the bot remembers, in Cloudflare D1 (SQLite). Schema: schema.sql.

const RECENT_LIMIT = 80;
const PAGE_TTL_MS = 24 * 3600 * 1000;
// Search columns, in table order; bm25 weights: a match in the title counts 5x one in the body.
const SEARCH_COLS = 'kind, ref, chat_id, title, body, url, at';
const SEARCH_RANK = 'bm25(search, 0, 0, 0, 5.0, 1.0, 0, 0)';
const insertRow = (db, kind, ref, r) =>
  db.prepare(`INSERT INTO search (${SEARCH_COLS}) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .bind(kind, ref, r.chatId || '', r.title || '', r.body || '', r.url || '', Number(r.at || 0));

export function createStore(db) {
  return {
    // Lark retries a webhook it thinks failed; each event is handled once.
    async firstTime(eventId) {
      const r = await db.prepare('INSERT OR IGNORE INTO seen_events (event_id, seen_at) VALUES (?, ?)').bind(eventId, Date.now()).run();
      return (r.meta?.changes || 0) > 0;
    },
    saveMessage: (m) =>
      db
        .prepare('INSERT OR IGNORE INTO messages (message_id, chat_id, sender_id, sender_name, text, links, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .bind(m.messageId, m.chatId, m.senderId, m.senderName, m.text, JSON.stringify(m.links || []), m.createdAt)
        .run(),
    async recentMessages(chatId) {
      const { results } = await db
        .prepare('SELECT rowid AS seq, sender_id, sender_name, text, links, created_at FROM messages WHERE chat_id = ? ORDER BY rowid DESC LIMIT ?')
        .bind(chatId, RECENT_LIMIT)
        .all();
      return (results || []).reverse();
    },
    // A private chat's history, forgotten on "/clear".
    clearChat: (chatId) => db.prepare('DELETE FROM messages WHERE chat_id = ?').bind(chatId).run(),
    // Memory reads messages by row number (`seq`, the order they were saved), not by time: two
    // messages saved at once can't skip each other, and Lark's clock vs ours doesn't matter.
    async messagesSince(chatId, seq, limit) {
      const { results } = await db.prepare('SELECT rowid AS seq, message_id, sender_id, sender_name, text, created_at FROM messages WHERE chat_id = ? AND rowid > ? ORDER BY rowid LIMIT ?').bind(chatId, seq, limit).all();
      return results || [];
    },
    // People's messages only: her own replies don't count towards the next memory update.
    async countSince(chatId, seq) {
      return (await db.prepare("SELECT COUNT(*) AS n FROM messages WHERE chat_id = ? AND rowid > ? AND sender_id != 'bot'").bind(chatId, seq).first())?.n || 0;
    },
    async lastSeq() {
      return (await db.prepare('SELECT MAX(rowid) AS n FROM messages').first())?.n || 0;
    },
    // Chats with a message since a time (the cron catches up on their memory).
    async activeChats(since) {
      const { results } = await db.prepare('SELECT chat_id, MAX(created_at) AS last, MAX(rowid) AS seq FROM messages WHERE created_at > ? GROUP BY chat_id').bind(since).all();
      return results || [];
    },
    // Memory items.
    async memories(chatId, limit) {
      const { results } = await db.prepare('SELECT id, chat_id, text, sources, created_at, updated_at FROM memories WHERE chat_id = ? ORDER BY updated_at DESC, id DESC LIMIT ?').bind(chatId, limit).all();
      return results || [];
    },
    async memoriesByIds(ids) {
      if (!ids.length) return [];
      const { results } = await db.prepare(`SELECT id, chat_id, text, sources, created_at, updated_at FROM memories WHERE id IN (${ids.map(() => '?').join(',')})`).bind(...ids).all();
      return results || [];
    },
    async memoryCount(chatId) {
      return (await db.prepare('SELECT COUNT(*) AS n FROM memories WHERE chat_id = ?').bind(chatId).first())?.n || 0;
    },
    async oldestMemoryIds(chatId, n) {
      const { results } = await db.prepare('SELECT id FROM memories WHERE chat_id = ? ORDER BY updated_at, id LIMIT ?').bind(chatId, n).all();
      return (results || []).map((r) => r.id);
    },
    // One memory update, all or nothing: facts, their keyword rows, the card and the cursor in one batch.
    // `plan`: { add: [{ id, text, sources }], update: [{ id, text }], remove: [id] }; `kv`: [[key, value]].
    async applyMemory(chatId, plan, kv, at) {
      const searchRow = (id, text) => insertRow(db, 'memory', String(id), { chatId, body: text, at });
      const dropRow = (id) => db.prepare("DELETE FROM search WHERE kind = 'memory' AND ref = ?").bind(String(id));
      await db.batch([
        ...plan.add.flatMap((a) => [
          db.prepare('INSERT INTO memories (id, chat_id, text, sources, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').bind(a.id, chatId, a.text, JSON.stringify(a.sources || []), at, at),
          searchRow(a.id, a.text),
        ]),
        ...plan.update.flatMap((u) => [
          db.prepare('UPDATE memories SET text = ?, updated_at = ? WHERE id = ? AND chat_id = ?').bind(u.text, at, u.id, chatId),
          dropRow(u.id),
          searchRow(u.id, u.text),
        ]),
        ...plan.remove.flatMap((id) => [db.prepare('DELETE FROM memories WHERE id = ? AND chat_id = ?').bind(id, chatId), dropRow(id)]),
        ...kv.map(([k, v]) => db.prepare('INSERT OR REPLACE INTO pages (url, text, fetched_at) VALUES (?, ?, ?)').bind(k, JSON.stringify(v), at)),
      ]);
    },
    // Everything remembered about one chat goes (the "/clear" in a DM). Returns the ids removed.
    async deleteMemoriesOf(chatId) {
      const { results } = await db.prepare('SELECT id FROM memories WHERE chat_id = ?').bind(chatId).all();
      await db.batch([
        db.prepare('DELETE FROM memories WHERE chat_id = ?').bind(chatId),
        db.prepare("DELETE FROM search WHERE kind = 'memory' AND chat_id = ?").bind(chatId),
      ]);
      return (results || []).map((r) => r.id);
    },
    // Housekeeping (the cron): old duplicate-event marks and cached web pages go; so do the chat
    // rows of groups the bot has left. Memory and settings in `pages` are never touched.
    async prune(now, groupIds) {
      const DAY = 24 * 3600 * 1000;
      await db.batch([
        db.prepare('DELETE FROM seen_events WHERE seen_at < ?').bind(now - 14 * DAY),
        db.prepare("DELETE FROM pages WHERE url LIKE 'http%' AND fetched_at < ?").bind(now - 30 * DAY),
        db.prepare(`DELETE FROM search WHERE kind IN ('chat', 'pin') AND chat_id NOT IN (${groupIds.map(() => '?').join(',') || "''"})`).bind(...groupIds),
      ]);
    },
    // Search index: one item (an event, a wiki page, a group...) is replaced as a whole.
    async indexReplace(kind, ref, rows) {
      await db.batch([db.prepare('DELETE FROM search WHERE kind = ? AND ref = ?').bind(kind, ref), ...rows.map((r) => insertRow(db, kind, ref, r))]);
    },
    indexAdd: (kind, ref, row) => insertRow(db, kind, ref, row).run(),
    // Drops items of a kind that no longer exist (a deleted event, a group the bot left).
    async indexKeepOnly(kind, refs) {
      const { results } = await db.prepare('SELECT DISTINCT ref FROM search WHERE kind = ?').bind(kind).all();
      const gone = (results || []).map((r) => r.ref).filter((ref) => !refs.includes(ref));
      if (gone.length) await db.batch(gone.map((ref) => db.prepare('DELETE FROM search WHERE kind = ? AND ref = ?').bind(kind, ref)));
      return gone;
    },
    // Only rows this person may see are ranked: open kinds, or rows of the chats in `chats`.
    async indexSearch(match, limit = 20, { chats = [], kinds = null } = {}) {
      const open = `kind IN ('event', 'doc', 'group')`;
      const mine = chats.length ? ` OR chat_id IN (${chats.map(() => '?').join(',')})` : '';
      const only = kinds ? ` AND kind IN (${kinds.map(() => '?').join(',')})` : '';
      const { results } = await db.prepare(`SELECT ${SEARCH_COLS} FROM search WHERE search MATCH ? AND (${open}${mine})${only} ORDER BY ${SEARCH_RANK} LIMIT ?`).bind(match, ...chats, ...(kinds || []), limit).all();
      return results || [];
    },
    async indexList(kind) {
      const { results } = await db.prepare(`SELECT ${SEARCH_COLS} FROM search WHERE kind = ? ORDER BY at`).bind(kind).all();
      return results || [];
    },
    // One-time copy of group messages saved before the index existed (DMs are never copied).
    backfillChat: (chatIds) =>
      chatIds.length
        ? db.prepare(`INSERT INTO search (${SEARCH_COLS}) SELECT 'chat', message_id, chat_id, '', text, '', created_at FROM messages WHERE sender_id != 'bot' AND chat_id IN (${chatIds.map(() => '?').join(',')})`).bind(...chatIds).run()
        : null,
    async cachedPage(url) {
      const row = await db.prepare('SELECT text, fetched_at FROM pages WHERE url = ?').bind(url).first();
      return row && Date.now() - row.fetched_at < PAGE_TTL_MS ? row.text : null;
    },
    savePage: (url, text) =>
      db.prepare('INSERT OR REPLACE INTO pages (url, text, fetched_at) VALUES (?, ?, ?)').bind(url, text, Date.now()).run(),
    // Small JSON cache (shares the pages table): value, or undefined when missing or older than ttlMs.
    async kvGet(key, ttlMs) {
      const row = await db.prepare('SELECT text, fetched_at FROM pages WHERE url = ?').bind(key).first();
      if (!row || Date.now() - row.fetched_at >= ttlMs) return undefined;
      try { return JSON.parse(row.text); } catch { return undefined; }
    },
    kvSet: (key, value) =>
      db.prepare('INSERT OR REPLACE INTO pages (url, text, fetched_at) VALUES (?, ?, ?)').bind(key, JSON.stringify(value), Date.now()).run(),
    bump: (key, by = 1) => db.prepare('INSERT INTO counters (key, n) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET n = n + excluded.n').bind(key, by).run(),
    async counter(key) {
      return (await db.prepare('SELECT n FROM counters WHERE key = ?').bind(key).first())?.n || 0;
    },
    async briefed(chatId, kind) {
      return Boolean(await db.prepare('SELECT 1 FROM briefings WHERE chat_id = ? AND kind = ?').bind(chatId, kind).first());
    },
    unmarkBriefed: (chatId, kind) => db.prepare('DELETE FROM briefings WHERE chat_id = ? AND kind = ?').bind(chatId, kind).run(),
    markBriefed: (chatId, kind) =>
      db.prepare('INSERT OR IGNORE INTO briefings (chat_id, kind, at) VALUES (?, ?, ?)').bind(chatId, kind, Date.now()).run(),
  };
}
