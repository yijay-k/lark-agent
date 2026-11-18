-- The bot's memory (Cloudflare D1). Apply with: npx wrangler d1 execute lark-event-bot --remote --file schema.sql
CREATE TABLE IF NOT EXISTS messages (
  message_id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  sender_id TEXT,
  sender_name TEXT,
  text TEXT,
  links TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_by_chat ON messages (chat_id, created_at);

CREATE TABLE IF NOT EXISTS seen_events (event_id TEXT PRIMARY KEY, seen_at INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS pages (url TEXT PRIMARY KEY, text TEXT, fetched_at INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS briefings (chat_id TEXT NOT NULL, kind TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (chat_id, kind));

-- Usage counters, e.g. Lark API calls per month (Lark's free plan allows ~10,000 a month).
CREATE TABLE IF NOT EXISTS counters (key TEXT PRIMARY KEY, n INTEGER NOT NULL);

-- What Eleyna can search (SQLite full-text search, BM25 ranking): calendar events, wiki sections,
-- groups, pinned messages, group chat messages and memory facts. A DM's messages are never indexed;
-- its memory facts are, and are shown only in that DM. Refilled by the cron.
CREATE VIRTUAL TABLE IF NOT EXISTS search USING fts5(
  kind UNINDEXED, ref UNINDEXED, chat_id UNINDEXED, title, body, url UNINDEXED, at UNINDEXED,
  tokenize = 'porter unicode61'
);

-- Long-term memory (the Mem0 method, see README): many small facts per chat, each with where it
-- came from. Added, updated and removed by memory.js; also in `search` (kind 'memory') and Vectorize.
CREATE TABLE IF NOT EXISTS memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL,
  text TEXT NOT NULL,
  sources TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS memories_by_chat ON memories (chat_id, updated_at);
