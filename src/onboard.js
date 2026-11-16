// Onboarding: when someone is added to the club's main group (ONBOARDING_CHAT_ID),
// Eleyna DMs them a welcome written from the Handbook. Once per person.

import { ABOUT, ONBOARDING } from './handbook.js';
import { think } from './brain.js';

function fallbackWelcome(name) {
  return [
    `Hey ${name || 'there'} 👋 I'm **Eleyna**, AI Exploration's AI secretary. Ask me anything about the club, any time, right here.`,
    '',
    "**AI Exploration** is AI Builders Club's lab for new AI: we **explore, experiment, apply and share**. We give the challenge; you figure out how, with any tool you like.",
    '',
    '**Read first** (or just ask me): *Introduction*, *Core Philosophy*, *AI Exploration Hub*, *Project 001* — Lark → Wiki → AI Exploration.',
    '',
    'Try asking me: "What\'s Project 001 about?" · "How does the weekly cycle work?" · "What should I do in my first week?"',
  ].join('\n');
}

export async function welcomeText({ env, name, log = () => {}, fetchImpl = fetch }) {
  const system = `You are Eleyna, the AI secretary of AI Exploration, writing a welcome DM to a new member.\n${ABOUT}\n${ONBOARDING}\nWrite ONLY the message, in Lark markdown, following "The welcome DM" exactly. No subject line.`;
  try {
    const out = await think(env, system, `The new member's name: ${name || 'there'}. Write their welcome DM now.`, log, fetchImpl);
    return out.text;
  } catch (err) {
    log(`welcome: AI failed (${err.message}); sending the fallback`);
    return fallbackWelcome(name);
  }
}

export async function onMembersAdded({ env, lark, store, event, log = console.log, fetchImpl = fetch }) {
  if (!env.ONBOARDING_CHAT_ID || event?.chat_id !== env.ONBOARDING_CHAT_ID) return 0;
  let sent = 0;
  for (const user of event.users || []) {
    const openId = user.user_id?.open_id;
    if (!openId || (await store.briefed('onboard', openId))) continue;
    const text = await welcomeText({ env, name: user.name, log, fetchImpl });
    await lark.sendPostToUser(openId, '👋 Welcome to AI Exploration', text);
    await store.markBriefed('onboard', openId);
    sent += 1;
    log(`onboarded ${openId.slice(0, 8)}…`);
  }
  return sent;
}
