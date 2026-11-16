// Group messages: remember every one; answer when the bot is @mentioned.

import { messageText, findLinks, isBotMentioned, isResearch } from './text.js';
import { groupContext, personContext, contextText } from './context.js';
import { answerSystem, answerPrompt, researchAddon, dmSystem } from './prompts.js';
import { think } from './brain.js';

function today(tz) {
  return new Date().toLocaleDateString('en-GB', { timeZone: tz, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}

export async function onMessage({ env, lark, store, event, log = console.log, fetchImpl = fetch }) {
  const msg = event.message || {};
  const sender = event.sender || {};
  if (sender.sender_type !== 'user') return 'ignored';
  const text = messageText(msg.message_type, msg.content);
  if (!text) return 'ignored';
  if (msg.chat_type === 'p2p') return onDirectMessage({ env, lark, store, msg, sender, text, log, fetchImpl });
  if (msg.chat_type !== 'group') return 'ignored';

  // Every group the bot is in. Each group's memory is kept apart by chat_id; nothing crosses groups.

  // A plain message costs no Lark API call: names are looked up only when answering.
  const senderId = sender.sender_id?.open_id;
  await store.saveMessage({
    messageId: msg.message_id,
    chatId: msg.chat_id,
    senderId,
    senderName: '',
    text,
    links: findLinks(text),
    createdAt: Number(msg.create_time || Date.now()),
  });

  const botId = env.BOT_OPEN_ID || (await lark.botOpenId());
  if (!isBotMentioned(msg.mentions, botId)) {
    log(`saved in ${msg.chat_id} (not addressed to the bot)`);
    return 'saved';
  }
  // Lark has no "typing…" for bots: an emoji on the question shows it's being worked on.
  await lark.react(msg.message_id, 'OnIt').catch((err) => log(`react failed: ${err.message}`));
  const members = await lark.chatMembers(msg.chat_id).catch(() => []);
  const senderName = members.find((m) => m.member_id === senderId)?.name || 'a member';
  const answer = await answerQuestion({ env, lark, store, chatId: msg.chat_id, question: text, asker: senderName, log, fetchImpl });
  await lark.replyPost(msg.message_id, '', answer.text);
  log(`answered in ${msg.chat_id} via ${answer.via}`);
  return 'answered';
}

// The answer itself, without posting it (also used by the private test door).
export async function answerQuestion({ env, lark, store, chatId, question, asker, log = console.log, fetchImpl = fetch }) {
  const tz = env.TIMEZONE || 'Asia/Kuala_Lumpur';
  const t0 = Date.now();
  const research = isResearch(question);
  const ctx = await groupContext({ env, lark, store, chatId, fetchImpl, log, deep: research, question });
  const system = answerSystem(ctx.name, ctx.description, ctx.events.length > 0, today(tz)) + (research ? researchAddon() : '');
  const answer = await think(env, system, answerPrompt(contextText(ctx), question, asker), log, fetchImpl, { search: research });
  log(`answer via ${answer.via}: ${Date.now() - t0} ms total`);
  return answer;
}

// A private chat with the bot: no @mention needed; it knows the person's event groups.
async function onDirectMessage({ env, lark, store, msg, sender, text, log, fetchImpl }) {
  const userId = sender.sender_id?.open_id;
  await store.saveMessage({ messageId: msg.message_id, chatId: msg.chat_id, senderId: userId, senderName: 'you', text, links: findLinks(text), createdAt: Number(msg.create_time || Date.now()) });
  await lark.react(msg.message_id, 'OnIt').catch((err) => log(`react failed: ${err.message}`));
  const tz = env.TIMEZONE || 'Asia/Kuala_Lumpur';
  const ctx = await personContext({ lark, store, chatId: msg.chat_id, userId, question: text, log, fetchImpl });
  const answer = await think(env, dmSystem(today(tz)), answerPrompt(contextText(ctx), text, 'them'), log, fetchImpl);
  await lark.replyPost(msg.message_id, '', answer.text);
  log(`answered DM via ${answer.via}`);
  return 'answered';
}

// The private-chat answer without posting (used by the test door).
export async function answerDirect({ env, lark, store, chatId, userId, question, log = console.log, fetchImpl = fetch }) {
  const tz = env.TIMEZONE || 'Asia/Kuala_Lumpur';
  const ctx = await personContext({ lark, store, chatId, userId, question, log, fetchImpl });
  return think(env, dmSystem(today(tz)), answerPrompt(contextText(ctx), question, 'them'), log, fetchImpl);
}

export { today };
