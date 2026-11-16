# Eleyna — Role & roadmap

_Last updated 2026-11-16._

Eleyna is AI Exploration's **secretary, HR and onboarding guide**: she knows the club, keeps people organised, welcomes new members and tells you what you'd miss. How the whole Lark setup works (including the ChatGPT connector on the Mac): the Obsidian note *Lark — How it works*. This file lives in the repo, next to the code: it's the source of truth for Eleyna.

## Her jobs
| Job | Status |
|---|---|
| **Events**: event groups, pinned cards, reminders, auto-join on Accept | ✅ live |
| **Group assistant**: every group, its own context only; summaries, shared links, announcements; cocky refusals for anything off-topic | ✅ live |
| **Knowledge**: the club wiki in DMs, plus the Handbook's "AI Exploration in one minute" | ✅ live |
| **Onboarding**: anyone added to *AI Exploration — Team* gets a clean welcome DM (start-here reading list: Introduction & Our Mission, Core Philosophy, Hub, Project 001; good-to-know: calendar invites, @Eleyna, say hi to EJ; example questions) and can keep asking her | ✅ built; Eleyna speaks first (added to the team group, opens her DM, or first DM). Needs the Lark events "User added to group" and "User enters chat with bot", and the app's availability set to all members |
| **Advisor**: "What should AI Exploration do next?" grounded in the wiki and recent chats | next |
| **Club folder**: one Lark Drive folder shared with Eleyna, so she knows official docs beyond the wiki | next |
| **Organiser**: weekly DM to Yi Jay: upcoming events, missing RSVPs, unanswered questions, stale docs | later |
| **HR actions**: add people to groups, send announcements; admin-only, always confirmed first | later |
| **Project progress**: each project gets a tracker (use **Lark Base**, not Google Sheets: Eleyna can read Base directly; the Hub already has *AI Exploration Operations*). Members fill in their row; Eleyna can say "you're at step 2 of Project 001; next, fill in X" | later |
| **"Ping EJ for me"**: when a member is stuck or wants a tool assignment, Eleyna offers to message EJ for them, shows the message first, and sends it only on "yes" | later |

## Rules
1. Anyone can ask; only admins can make her *do* things (once she can act).
2. She confirms before acting; she suggests cleanup but never deletes.
3. She only reads what's shared with her; personal "My Space" docs stay private.
4. Lark's free plan allows about 10,000 API calls a month (shared with the ChatGPT connector). Ask her **"@Eleyna usage"**; she warns Yi Jay's DM at 75% and 90%.

## Who controls her
- **Her rules and tone, and what she tells new members:** `src/handbook.js` in the repo. **Only Yi Jay edits it** (it controls what Eleyna says to everyone).
- **What she knows:** the AI Exploration wiki; edit a page and she knows it within a day.
- **Code:** the repo; deploy with `npx wrangler deploy`.

> **Side note (later):** when the club has more members, move the Handbook into a locked Lark doc and assign one trusted "Eleyna manager" who knows how to prompt. Until then, Yi Jay controls all access; no knowledge-base editors yet.

## Lark settings Eleyna depends on
- **Events & Callbacks** → request URL the Worker URL + `/lark/events` (`https://lark-event-bot.<subdomain>.workers.dev/lark/events`); events: Message received, User added to group, User enters chat with bot.
- **Availability**: must include everyone she should talk to. Otherwise Lark refuses with `230013 Bot has NO availability to this user` (a failed welcome is retried later).
- The Encrypt Key and Verification Token are Cloudflare secrets (`LARK_ENCRYPT_KEY`, `LARK_VERIFICATION_TOKEN`).
