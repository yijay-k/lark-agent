# Lark event-group bot (Cloudflare Worker)

An always-on helper inside each Lark event group. It runs on Cloudflare's free plan, so your Mac can be off.

- **Remembers** every message in the group (text and links) in Cloudflare D1.
- **Answers when @mentioned** ("@Eleyna where do we park?"). It uses only that group's pinned card, its calendar events, the official pages they link to, and the chat. Groups never see each other.
- **Posts a "💡 Good to know" note** once per group (parking, entrance, food nearby, what to bring, catches), and a **"🔔 Tomorrow" reminder** the day before.
- **Private messages**: DM Eleyna (no @ needed). In a DM it knows the events of every event group you're in.
- **Research mode**: questions like "who are the panelists, should I go?" make it open more pages of the official site (speakers, agenda), try a web search, and give a short verdict.
- **Only event groups**: in any group without an `event:` tag it stays silent and stores nothing.
- **Onboarding**: anyone added to the club group (`ONBOARDING_CHAT_ID`) gets a welcome DM written from `src/handbook.js`. Needs the Lark event "User added to group" (`im.chat.member.user.added_v1`).
- **Handbook** (`src/handbook.js`): what Eleyna says about the club and to new members. Owner-only.
- **Adds people who accept any of the group's events** (the group's description lists them as `event:<id>`), every 6 hours. It never removes anyone.

**Brain:** `GEMINI_MODELS` in order (Gemini 3.5 Flash-Lite with thinking off, then 3.8 Flash), then Cloudflare Workers AI (`BACKUP_MODEL`, Llama 3.3 70B fast), all inside one 25 s budget, because Cloudflare's free plan gives a Lark message 30 s of background time. Typical answer: 4–10 s. Google Search is tried only for research questions; the free tier currently refuses it (429), which costs ~0.3 s. Providers retire models often: if answers stop, check `npx wrangler tail` and change the model names in `wrangler.toml`. Nothing is billed: neither service has a card on file, and free plans stop rather than charge.

## Files
| File | What it does |
|---|---|
| `src/index.js` | Webhook `POST /lark/events` (decrypts, checks the signature) and the 6-hour cron |
| `src/handlers.js` | Saves each group message; answers @mentions |
| `src/cron.js` | Auto-join and the briefings |
| `src/context.js` | Builds one group's context: pins, events, official pages (cached 24 h), chat |
| `src/brain.js` | Gemini, then Gemini without search, then Workers AI |
| `src/prompts.js` | What the bot is told |
| `src/lark.js`, `src/crypto.js`, `src/text.js`, `src/store.js` | Lark API, webhook crypto, text helpers, D1 memory |
| `schema.sql` | D1 tables |

Tests (offline, free): `npm test`.

## Set up (once)
1. `npx wrangler login` (opens the browser; log in to Cloudflare).
2. `npx wrangler d1 create lark-event-bot` → put the `database_id` in `wrangler.toml`; then `npx wrangler d1 execute lark-event-bot --remote --file schema.sql`.
3. `npx wrangler deploy` → note the URL, `https://lark-event-bot.<you>.workers.dev`.
4. Secrets: `npx wrangler secret put LARK_APP_SECRET`, `GEMINI_API_KEY` (from aistudio.google.com → Get API key), `LARK_ENCRYPT_KEY`, `LARK_VERIFICATION_TOKEN` (both from step 5).
5. Lark developer console → the app → **Events & Callbacks**:
   - Encryption strategy: copy the **Encrypt Key** and **Verification Token** into the secrets;
   - Request URL: `https://lark-event-bot.<you>.workers.dev/lark/events`;
   - add the event **Message received** (`im.message.receive_v1`);
   - then publish a new app version.
6. In an event group, write `@Eleyna what should we know?`.

Logs: `npx wrangler tail`.

## Gotchas (learnt 2026-11-16)
- `/bot/v3/info` returns `bot` at the top level, not under `data`; reading it wrong makes every @mention look unaddressed.
- Event mentions carry `id` as `{open_id}`; the message API returns it as a string.
- Lark's URL check is encrypted; a wrong `LARK_ENCRYPT_KEY` shows as "Decryption failed" in the logs.
- Test door (locked): `POST /debug/ask` and `/debug/models` with header `x-debug-key` (secret `DEBUG_KEY`).
