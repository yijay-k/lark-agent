// Onboarding: when someone is added to the club's main group (ONBOARDING_CHAT_ID),
// Eleyna DMs them the approved welcome from the Handbook. Once per person.

import { WELCOME } from './handbook.js';

// The welcome is a fixed, approved text (handbook WELCOME): no AI, no tokens, always the same.
export function welcomeText({ name }) {
  return WELCOME.replaceAll('{name}', String(name || 'there').trim() || 'there');
}

// Sends the welcome to one person unless they already got it. Returns true if it was sent now.
export async function welcomeOnce({ lark, store, openId, name, log = console.log }) {
  if (!openId || (await store.briefed('onboard', openId))) return false;
  await store.markBriefed('onboard', openId);
  await lark.sendPostToUser(openId, '👋 Welcome to AI Exploration', welcomeText({ name }));
  log(`welcomed ${openId.slice(0, 8)}…`);
  return true;
}

// They opened a chat with Eleyna for the first time (before typing anything).
export async function onChatEntered({ lark, store, event, log = console.log }) {
  const openId = event?.operator_id?.open_id;
  if (!openId) return false;
  const members = await lark.chatMembers(event.chat_id).catch(() => []);
  const name = members.find((m) => m.member_id === openId)?.name;
  return welcomeOnce({ lark, store, openId, name, log });
}

export async function onMembersAdded({ env, lark, store, event, log = console.log, fetchImpl = fetch }) {
  if (!env.ONBOARDING_CHAT_ID || event?.chat_id !== env.ONBOARDING_CHAT_ID) return 0;
  let sent = 0;
  for (const user of event.users || []) {
    if (await welcomeOnce({ lark, store, openId: user.user_id?.open_id, name: user.name, log })) sent += 1;
  }
  return sent;
}
