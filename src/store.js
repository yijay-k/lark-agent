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
        .prepare('SELECT sender_id, sender_name, text, links, created_at FROM messages WHERE chat_id = ? ORDER BY created_at DESC LIMIT ?')
        .bind(chatId, RECENT_LIMIT)
        .all();
      return (results || []).reverse();
    },
    // A private chat's history, forgotten on "/clear".
    clearChat: (chatId) => db.prepare('DELETE FROM messages WHERE chat_id = ?').bind(chatId).run(),
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
    },
    async indexSearch(match, limit = 20) {
      const { results } = await db.prepare(`SELECT ${SEARCH_COLS} FROM search WHERE search MATCH ? ORDER BY ${SEARCH_RANK} LIMIT ?`).bind(match, limit).all();
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
