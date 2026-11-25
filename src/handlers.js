// Group messages: remember every one; answer when the bot is @mentioned.

import { messageText, findLinks, isBotMentioned, isResearch, isUsageQuestion } from './text.js';
import { recordAnswer, usageNumbers, usageReport } from './usage.js';
import { nextEnding, endingRule } from './roast.js';
import { welcomeOnce } from './onboard.js';

const JUST_A_GREETING = /^(hi+|hey+|hello+|yo+|sup|hai|hallo|good (morning|afternoon|evening)|hiya|howdy)[!. ]*$/i;
import { groupContext, personContext, contextText } from './context.js';
import { answerSystem, answerPrompt, researchAddon, dmSystem, foundClubItems } from './prompts.js';
import { isClubMatch } from './search.js';
import { maybeFold, forgetChat, memoryReport } from './memory.js';
import { isOwner, startAdd, answerAdd, asksToAddSomeone, NOT_OWNER } from './admin.js';
import { startEvent, answerEvent, asksForEventSetup } from './events.js';
import { isYes, wantsToJoin, pendingOffer, saveOffer, dropOffer, offerHint, answerCard, joinGroup } from './join.js';
import { think } from './brain.js';

function today(tz) {
  return new Date().toLocaleDateString('en-GB', { timeZone: tz, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}

export async function onMessage({ env, lark, store, event, log = console.log, fetchImpl = fetch }) {
  const startedAt = Date.now();
  const msg = event.message || {};
  const sender = event.sender || {};
  if (sender.sender_type !== 'user') return 'ignored';
  const text = messageText(msg.message_type, msg.content);
  if (!text) return 'ignored';
  const tz = env.TIMEZONE || 'Asia/Kuala_Lumpur';
  // Memory takes in new messages once enough wait, in the time left after any answer.
  const remember = (isPrivate) => maybeFold({ env, lark, store, chatId: msg.chat_id, isPrivate, today: today(tz), startedAt, log, fetchImpl });
  if (msg.chat_type === 'p2p') {
    const result = await onDirectMessage({ env, lark, store, msg, sender, text, log, fetchImpl, startedAt });
    if (result === 'answered' || result === 'joined') await remember(true);
    return result;
  }
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

  // Searchable later, but only by this group's members (see search.js).
  await store.indexAdd('chat', msg.message_id, { chatId: msg.chat_id, body: text, at: Number(msg.create_time || Date.now()) }).catch((err) => log(`index chat: ${err.message}`));
  // The owner's answer to "add Kai to this group?" counts without an @mention.
  const owner = isOwner(env, senderId);
  if (owner) {
    const reply = (await answerEvent({ env, lark, store, chatId: msg.chat_id, text, isYes, log })) || (await answerAdd({ lark, store, chatId: msg.chat_id, text, isYes, log }));
    if (reply) return replyAndRemember({ lark, store, msg, text: reply, result: 'admin' });
  }
  const botId = env.BOT_OPEN_ID || (await lark.botOpenId());
  if (!isBotMentioned(msg.mentions, botId)) {
    log(`saved in ${msg.chat_id} (not addressed to the bot)`);
    await remember(false);
    return 'saved';
  }
  if (text.trim().toLowerCase() === '/memory') {
    await lark.replyPost(msg.message_id, '', await memoryReport(store, msg.chat_id));
    return 'memory';
  }
  if (isUsageQuestion(text)) {
    await lark.replyPost(msg.message_id, '', usageReport(await usageNumbers(store)));
    return 'usage';
  }
  // "add kai here", "make a group for AiSED on 2 Dec": handled in code (owner only), never by the AI.
  const adding = owner
    ? (await startEvent({ env, lark, store, chatId: msg.chat_id, isGroup: true, text, ownerId: senderId })) || (await startAdd({ lark, store, chatId: msg.chat_id, isGroup: true, text }))
    : asksForEventSetup(text) || (await asksToAddSomeone(lark, text)) ? NOT_OWNER : null;
  if (adding) return replyAndRemember({ lark, store, msg, text: adding, result: 'admin' });
  // Lark has no "typing…" for bots: an emoji on the question shows it's being worked on.
  await lark.react(msg.message_id, 'OnIt').catch((err) => log(`react failed: ${err.message}`));
  const members = await lark.chatMembers(msg.chat_id).catch(() => []);
  const senderName = members.find((m) => m.member_id === senderId)?.name || 'a member';
  const answer = await answerQuestion({ env, lark, store, chatId: msg.chat_id, question: text, asker: senderName, log, fetchImpl, startedAt });
  await rememberReply(store, msg.chat_id, await lark.replyPost(msg.message_id, '', answer.text), answer.text);
  await recordAnswer(store, answer);
  log(`answered in ${msg.chat_id} via ${answer.via}, ${answer.tokens} tokens`);
  await remember(false);
  return 'answered';
}

// The answer itself, without posting it (also used by the private test door).
export async function answerQuestion({ env, lark, store, chatId, question, asker, log = console.log, fetchImpl = fetch, startedAt = Date.now() }) {
  const tz = env.TIMEZONE || 'Asia/Kuala_Lumpur';
  const t0 = Date.now();
  const research = isResearch(question);
  const ctx = await groupContext({ env, lark, store, chatId, fetchImpl, log, deep: research, question });
  const ending = await nextEnding(store, chatId);
  const system = answerSystem(ctx.name, ctx.description, ctx.events.length > 0, today(tz)) + (research ? researchAddon() : '') + endingRule(ending);
  const answer = await think(env, system, answerPrompt(contextText(ctx), question, asker), log, fetchImpl, { search: research, startedAt });
  log(`answer via ${answer.via}: ${Date.now() - t0} ms total`);
  return answer;
}

async function replyAndRemember({ lark, store, msg, text, result }) {
  await rememberReply(store, msg.chat_id, await lark.replyPost(msg.message_id, '', text), text);
  return result;
}

// Her own replies are kept too, so a follow-up ("that's not it") makes sense. Never searchable.
async function rememberReply(store, chatId, res, text) {
  const messageId = res?.message_id || `bot-${chatId}-${Date.now()}`;
  await store.saveMessage({ messageId, chatId, senderId: 'bot', senderName: 'Eleyna', text, links: [], createdAt: Date.now() }).catch(() => {});
}

// Adds them to the offered groups and replies with each group's details.
async function joinAndReply({ env, lark, store, msg, userId, offers, log }) {
  const results = [];
  for (const o of offers) results.push(await joinGroup({ env, lark, store, userId, chatId: o.chat_id, log }));
  await dropOffer(store, msg.chat_id);
  const text = results.map((r) => (r.ok ? (r.already ? `You're already in **${r.name}**.\n\n${r.details}` : r.details) : r.error)).join('\n\n---\n\n');
  await rememberReply(store, msg.chat_id, await lark.replyPost(msg.message_id, '', text), text);
  return 'joined';
}

// A private chat with the bot: no @mention needed. It knows every event and the wiki, and the
// chats of the groups this person is in; it offers to add them to the others.
async function onDirectMessage({ env, lark, store, msg, sender, text, log, fetchImpl, startedAt }) {
  const userId = sender.sender_id?.open_id;
  const command = text.trim().toLowerCase();
  if (command === '/clear') {
    await store.clearChat(msg.chat_id);
    await forgetChat({ env, store, chatId: msg.chat_id, log });
    await dropOffer(store, msg.chat_id);
    await lark.replyPost(msg.message_id, '', 'Cleared: our chat and what I remembered from it are forgotten. Ask me anything fresh.');
    return 'cleared';
  }
  if (command === '/memory') {
    await lark.replyPost(msg.message_id, '', await memoryReport(store, msg.chat_id));
    return 'memory';
  }
  await store.saveMessage({ messageId: msg.message_id, chatId: msg.chat_id, senderId: userId, senderName: 'them', text, links: findLinks(text), createdAt: Number(msg.create_time || Date.now()) });
  // Eleyna speaks first: someone she hasn't welcomed yet gets the welcome before anything else.
  // A plain "hi" needs nothing more; a real question still gets its answer after the welcome.
  const welcomedNow = await welcomeOnce({ lark, store, openId: userId, log }).catch((err) => (log(`welcome failed: ${err.message}`), false));
  if (welcomedNow && JUST_A_GREETING.test(text.trim())) return 'welcomed';
  // The owner adding other people: an answer to "add them?" first, then a new request.
  if (isOwner(env, userId)) {
    const reply = (await answerEvent({ env, lark, store, chatId: msg.chat_id, text, isYes, log }))
      || (await answerAdd({ lark, store, chatId: msg.chat_id, text, isYes, log }))
      || (await startEvent({ env, lark, store, chatId: msg.chat_id, isGroup: false, text, ownerId: userId }))
      || (await startAdd({ lark, store, chatId: msg.chat_id, isGroup: false, text }));
    if (reply) return replyAndRemember({ lark, store, msg, text: reply, result: 'admin' });
  } else if (asksForEventSetup(text) || (await asksToAddSomeone(lark, text))) {
    return replyAndRemember({ lark, store, msg, text: NOT_OWNER, result: 'admin' });
  }
  // "yes" to the group she just offered.
  const pending = await pendingOffer(store, msg.chat_id);
  if (pending.length && isYes(text)) return joinAndReply({ env, lark, store, msg, userId, offers: pending, log });
  if (isUsageQuestion(text)) {
    await lark.replyPost(msg.message_id, '', usageReport(await usageNumbers(store)));
    return 'usage';
  }
  await lark.react(msg.message_id, 'OnIt').catch((err) => log(`react failed: ${err.message}`));
  const answer = await answerDirect({ env, lark, store, chatId: msg.chat_id, userId, question: text, log, fetchImpl, startedAt });
  // "add me to the AiSED group": one clear match, so no need to ask first.
  if (answer.offers.length === 1 && wantsToJoin(text)) return joinAndReply({ env, lark, store, msg, userId, offers: answer.offers, log });
  await dropOffer(store, msg.chat_id);
  let reply = answer.text;
  let res;
  if (answer.offers.length) {
    const button = env.JOIN_BUTTON === 'on';
    reply = `${answer.text}\n\n${offerHint(answer.offers, button)}`;
    await saveOffer(store, msg.chat_id, answer.offers);
    res = button ? await lark.replyCard(msg.message_id, answerCard(reply, answer.offers)) : await lark.replyPost(msg.message_id, '', reply);
  } else {
    res = await lark.replyPost(msg.message_id, '', reply);
  }
  await rememberReply(store, msg.chat_id, res, reply);
  await recordAnswer(store, answer);
  log(`answered DM ${msg.chat_id} from ${userId} via ${answer.via}, ${answer.tokens} tokens, ${answer.found} found, ${answer.offers.length} offers`);
  return 'answered';
}

// The private-chat answer without posting (also used by the test door): { text, via, tokens, offers, found }.
export async function answerDirect({ env, lark, store, chatId, userId, question, log = console.log, fetchImpl = fetch, startedAt = Date.now() }) {
  const tz = env.TIMEZONE || 'Asia/Kuala_Lumpur';
  const ctx = await personContext({ env, lark, store, chatId, userId, question, log, fetchImpl });
  const clubHit = ctx.found.some(isClubMatch);
  const system = dmSystem(today(tz)) + foundClubItems(clubHit) + endingRule(await nextEnding(store, chatId));
  const answer = await think(env, system, answerPrompt(contextText(ctx), question, 'them'), log, fetchImpl, { startedAt });
  return { ...answer, offers: ctx.offers, found: ctx.found.length };
}

export { today };
