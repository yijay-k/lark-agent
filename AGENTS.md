# AGENTS.md: setting up and working on Eleyna

This file is for an AI coding agent (Claude Code, Codex, Cursor, etc.). A person who wants their own copy of this bot opens the repo in their agent and says something like **"set this bot up for my Lark"**. You, the agent, then follow the setup below.

What the bot is and how it works: `README.md`. Her jobs and roadmap: `docs/ROADMAP.md`.

## Your rules (read first)

1. **Never see, print, store or commit a secret.** Secrets are `LARK_APP_SECRET`, `LARK_ENCRYPT_KEY`, `LARK_VERIFICATION_TOKEN`, `GEMINI_API_KEY` and `DEBUG_KEY`.
   - Don't ask the person to paste them into the chat, and never write them into `wrangler.toml`, `.dev.vars` or any other file.
   - Instead, give them the command `npx wrangler secret put <NAME>` to run **in their own terminal**. Wrangler asks for the value there, so it goes straight to Cloudflare.
   - The one exception is `DEBUG_KEY`: you may generate it with `openssl rand -hex 16`, as long as it goes straight into `wrangler secret put` through a pipe and you save it only where the person tells you to. Don't put it in the repo.
2. **Things only the person can do, they do.** That means logging in to Cloudflare, Google and Lark, clicking in the Lark developer console, and publishing app versions. Say exactly where to click and what to copy, then wait for them to say "done".
3. **One step at a time.** Check each step worked before moving on (each has a "Check" line).
4. **Ask before deploying or changing their accounts.**
5. Everything here fits free plans. If anything asks for a card, stop and tell the person.

## What you'll collect

| Item | Where it comes from | Where it goes |
|---|---|---|
| Lark region | Ask: Lark (`open.larksuite.com`) or Feishu (`open.feishu.cn`)? | `LARK_DOMAIN` in `wrangler.toml` |
| App ID (`cli_…`, not secret) | Lark developer console → the app → Credentials | `LARK_APP_ID` in `wrangler.toml` |
| App Secret | Same page | `wrangler secret put LARK_APP_SECRET` (the person runs it) |
| Gemini API key | aistudio.google.com → Get API key | `wrangler secret put GEMINI_API_KEY` (the person runs it) |
| Encrypt Key, Verification Token | Lark console → Events & Callbacks → Encryption strategy | `wrangler secret put LARK_ENCRYPT_KEY` / `LARK_VERIFICATION_TOKEN` |
| D1 database id | `npx wrangler d1 create` output | `database_id` in `wrangler.toml` |
| Onboarding group's chat id (`oc_…`) | The logs (step 9) | `ONBOARDING_CHAT_ID` in `wrangler.toml` |
| Team groups' chat ids (optional) | The logs (step 9), like the onboarding group | `TEAM_CHATS` in `wrangler.toml` (comma-separated): who "the team" is in "invite the team". Unset: the `GROUP_WIKIS` groups, else `ONBOARDING_CHAT_ID` |
| Owner's DM chat id (`oc_…`) | The logs (step 9) | `ALERT_CHAT_ID` in `wrangler.toml` |
| Timezone | Ask (e.g. `Asia/Kuala_Lumpur`) | `TIMEZONE` in `wrangler.toml` |
| Bot name, organisation, what she should say about it, the welcome DM | Interview the person (step 2) | See step 2 |

## Setup

**0. Check the tools.** Node 18 or newer (`node -v`) and git. Run `npm install`.

**1. Cloudflare.** The person runs `npx wrangler login`, which opens the browser for them to log in. A free account is enough.
*Check:* `npx wrangler whoami` shows their account.

**2. Make the bot theirs.** The code ships as "Eleyna", the secretary of the AI Exploration club. Ask the person:
- the bot's name;
- the organisation and what it does;
- what members should read first;
- who to contact when the bot can't help;
- the welcome message, if they want one.

Then update these files:
- `src/handbook.js`:
  - `ABOUT`: what the bot knows about the organisation;
  - `ONBOARDING`: how she helps newcomers;
  - `WELCOME`: the welcome DM, word for word, with `{name}` for the person's name.
- `src/prompts.js`: the bot's name and organisation ("You are Eleyna…", and "YOUR JOB" near the top).
- `src/onboard.js`: the welcome's title, `'👋 Welcome to AI Exploration'`.
- `src/usage.js`: the usage report's title.
- `test/bot.test.js`: a test pins the welcome text, so update it to match. Then run `npm test`.

Show the person the new `WELCOME` before moving on.
*Check:* `npm test` passes.

**3. Lark app.** The person goes to the Lark developer console (open.larksuite.com/app, or open.feishu.cn/app for Feishu) → **Create custom app**. Then:
- **Features → Bot**: turn it on.
- **Permissions & Scopes**: search for and add these. Labels can differ slightly between regions, so match the meaning:
  - Receive messages: `im:message.group_at_msg:readonly`, `im:message.p2p_msg:readonly`, and `im:message.group_msg` (read all group messages, so she remembers the chat).
  - Messages: `im:message:readonly`, `im:message:send_as_bot`, `im:message.reactions:write_only`, `im:message.pins:read`.
  - Groups: `im:chat:readonly`, `im:chat.members:read`, and `im:chat.members:write_only` (to add people who accept events).
  - Calendar: `calendar:calendar:readonly`, `calendar:calendar.event:read`, and `calendar:calendar.event:update` (the owner's "invite the team to the AiSED events": sends calendar invites).
  - Event groups: `im:chat:create` (the owner's "make a group for AiSED on 2 Dec") and `im:message.pins:write_only` (pins the event details in it).
  - Knowledge: `wiki:wiki:readonly`, `docx:document:readonly`.
  - People: `contact:contact.base:readonly`.
- **Calendar events the bot works with**: the bot reads (and invites people to) events it's a guest of, on its own calendar. For each event the owner wants it to send invites for, they invite the bot as a guest and, in the event's guest permissions, turn on **Guests can invite others**. Without that Lark refuses the invite and the bot says so. (Events on a shared calendar work the same way: what matters is that the bot is a guest and guests may invite others.)
- **Credentials**: copy the **App ID** to the person; they keep the **App Secret** for step 5.

**4. Database and config.**
- Run `npx wrangler d1 create lark-event-bot` and put the printed `database_id` in `wrangler.toml`.
- Run `npx wrangler d1 execute lark-event-bot --remote --file schema.sql`.
- Create the meaning-search index and its two filters, **before** the first deploy (Vectorize only filters vectors added after a filter exists):
  ```
  npx wrangler vectorize create eleyna-memory --dimensions=1024 --metric=cosine
  npx wrangler vectorize create-metadata-index eleyna-memory --propertyName=chat_id --type=string
  npx wrangler vectorize create-metadata-index eleyna-memory --propertyName=kind --type=string
  ```
  1024 matches `EMBED_MODEL` (`@cf/baai/bge-m3`); a different model needs an index of its own size.
- In `wrangler.toml`, set `LARK_DOMAIN`, `LARK_APP_ID`, `TIMEZONE` and `LARK_WEB` (the workspace's web address, for wiki links).
- Leave `ONBOARDING_CHAT_ID` and `ALERT_CHAT_ID` as they are until step 9. The values in the file belong to the original club, so they do nothing in another workspace.

*Check:* `npx wrangler d1 execute lark-event-bot --remote --command "select name from sqlite_master"` lists `messages`, `pages`, `counters`, `search`, `memories` and the rest, and `npx wrangler vectorize list-metadata-index eleyna-memory` lists `chat_id` and `kind`.

**5. Secrets.** The person runs these in their terminal, pasting each value when asked:
```
npx wrangler secret put LARK_APP_SECRET
npx wrangler secret put GEMINI_API_KEY
```
You can set `DEBUG_KEY` yourself with `openssl rand -hex 16 | npx wrangler secret put DEBUG_KEY`. First ask where they want to keep a copy, because the test routes need it.

**6. Deploy.** Run `npx wrangler deploy` and note the URL, `https://lark-event-bot.<subdomain>.workers.dev`.
*Check:* opening that URL in a browser answers (a 404 or a short text is fine; a Cloudflare error page is not).

**7. Connect Lark to the Worker.** In the Lark console → **Events & Callbacks**:
1. **Encryption strategy:** the person copies the **Encrypt Key** and **Verification Token**, then runs:
   ```
   npx wrangler secret put LARK_ENCRYPT_KEY
   npx wrangler secret put LARK_VERIFICATION_TOKEN
   ```
   If the Encrypt Key is empty or a placeholder (e.g. `SECRET_KEY`), have them reset it first.
2. **Event configuration → request URL:** `<worker URL>/lark/events`. Lark checks it immediately and should say it's verified.
3. **Add events:** *Message received* (`im.message.receive_v1`), *User added to group* (`im.chat.member.user.added_v1`), *User enters chat with bot* (`im.chat.access_event.bot_p2p_chat_entered_v1`).
4. **Callback configuration** (the Join button): send callbacks to the same `<worker URL>/lark/events` and add *card.action.trigger*. Then set `JOIN_BUTTON = "on"` in `wrangler.toml` and redeploy. Until then people join by replying "yes".

*Check:* run `npx wrangler tail` while they save the URL. A "Decryption failed" line means the Encrypt Key secret doesn't match Lark's.

**8. Publish.** In **Version Management & Release** → **Create a version**:
- set **Availability** to **All members**. If they choose specific people instead, Lark refuses to message anyone else with error `230013`.
- Save and publish, and approve it in the Admin Console if asked.

Publishing doesn't change who can use the app: only the Availability inside the version does.

**9. Find the two chat ids.** Run `npx wrangler tail --format pretty`. Then:
- The person adds the bot to the group whose new members should get the welcome, and sends any message there. The log prints `saved in oc_…`: that's `ONBOARDING_CHAT_ID`.
- The person DMs the bot. The log prints `answered DM oc_… via …`: that's `ALERT_CHAT_ID`, where quota warnings go.

Put both in `wrangler.toml` and run `npx wrangler deploy` again.

**10. Test.**
- In a group, the person writes `@<bot name> what can you do?` and should get an answer within about 10 s.
- Make the person the owner (only they can add other people to groups): their open_id (`ou_…`) shows in the log line `answered DM oc_… from ou_…` when they DM the bot (`npx wrangler tail`). Ask them to paste it themselves: `npx wrangler secret put OWNER_OPEN_IDS` (several: comma-separated).
- Fill the search index: `curl -s -X POST <worker URL>/debug/reindex -H "x-debug-key: <DEBUG_KEY>"`. Repeat while `wiki.left` is above 0 (8 pages per run, Cloudflare's free plan allows 50 outside calls per run).
- `curl -s -X POST <worker URL>/debug/usage -H "x-debug-key: <DEBUG_KEY>"` returns usage numbers.
- Update one chat's memory now and see it: `curl -s -X POST <worker URL>/debug/memory -H "x-debug-key: <DEBUG_KEY>" -H 'content-type: application/json' -d '{"chatId":"oc_…"}'`. Normally it's automatic (every 15 messages, and the cron).
- A welcome preview, which sends nothing: `curl -s -X POST <worker URL>/debug/onboard -H "x-debug-key: <DEBUG_KEY>" -H 'content-type: application/json' -d '{"name":"Test"}'`.

Done. Tell the person what works and anything left over.

## If something's wrong

| Symptom | Cause and fix |
|---|---|
| Silent; the log shows "Decryption failed" | `LARK_ENCRYPT_KEY` doesn't match Lark's. Run `wrangler secret put` again with the key from the console. |
| Silent; nothing in the log | The request URL or events aren't saved, or the version isn't published. |
| Saves messages but never answers mentions | The mention must pick the bot from the @ list; typing the name doesn't count. Also check the receive-message scopes. |
| `230013 Bot has NO availability to this user` | Availability in the published version doesn't include that person (step 8). |
| `41050 no user authority` when looking someone up | Same cause: outside the app's availability. |
| "I couldn't send the calendar invites" | The bot isn't a guest of the event, or guests can't invite others (step 3, calendar events); or `calendar:calendar.event:update` is missing. |
| `99991672` or another permission error | A scope from step 3 is missing; add it, then publish a new version. |
| Answers stop and models return 404 | Google retired a model. List the current ones with `POST /debug/models` (same header) and update `GEMINI_MODELS` in `wrangler.toml`. |
| Answers cut off or none after ~30 s | Cloudflare's free limit. Keep the fast model first in `GEMINI_MODELS`. |

## Working on the code

- `npm test` runs the offline tests (no network, no keys). Run it before every deploy; add a test with each fix.
- `npx wrangler deploy` ships the code; `npx wrangler tail` shows the live logs.
- Keep it within free tiers. Lark allows about 10,000 API calls a month for the whole workspace: cache reads in D1 (`kvGet`/`kvSet` in `src/store.js`) and don't add frequent cron jobs.
- In the original club's deployment, only the owner edits `src/handbook.js`. In your own copy, the handbook is yours.
