// Onboarding: when someone is added to the club's main group (ONBOARDING_CHAT_ID),
// Eleyna DMs them the approved welcome from the Handbook. Once per person.

import { WELCOME } from './handbook.js';

// The welcome is a fixed, approved text (handbook WELCOME): no AI, no tokens, always the same.
export function welcomeText({ name }) {
  return WELCOME.replaceAll('{name}', String(name || 'there').trim() || 'there');
}

export async function onMembersAdded({ env, lark, store, event, log = console.log, fetchImpl = fetch }) {
  if (!env.ONBOARDING_CHAT_ID || event?.chat_id !== env.ONBOARDING_CHAT_ID) return 0;
  let sent = 0;
  for (const user of event.users || []) {
    const openId = user.user_id?.open_id;
    if (!openId || (await store.briefed('onboard', openId))) continue;
    const text = welcomeText({ name: user.name });
    await lark.sendPostToUser(openId, '👋 Welcome to AI Exploration', text);
    await store.markBriefed('onboard', openId);
    sent += 1;
    log(`onboarded ${openId.slice(0, 8)}…`);
  }
  return sent;
}
