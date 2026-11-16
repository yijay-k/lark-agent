// What the bot remembers, in Cloudflare D1 (SQLite). Schema: schema.sql.

const RECENT_LIMIT = 80;
const PAGE_TTL_MS = 24 * 3600 * 1000;

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
    bump: (key) => db.prepare('INSERT INTO counters (key, n) VALUES (?, 1) ON CONFLICT(key) DO UPDATE SET n = n + 1').bind(key).run(),
    async counter(key) {
      return (await db.prepare('SELECT n FROM counters WHERE key = ?').bind(key).first())?.n || 0;
    },
    async briefed(chatId, kind) {
      return Boolean(await db.prepare('SELECT 1 FROM briefings WHERE chat_id = ? AND kind = ?').bind(chatId, kind).first());
    },
    markBriefed: (chatId, kind) =>
      db.prepare('INSERT OR IGNORE INTO briefings (chat_id, kind, at) VALUES (?, ?, ?)').bind(chatId, kind, Date.now()).run(),
  };
}
