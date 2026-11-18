// Cloudflare Worker entry: Lark webhook and card callbacks (POST /lark/events) and the 6-hourly cron.

import { decryptLark, signatureOk } from './crypto.js';
import { createLark } from './lark.js';
import { createStore } from './store.js';
import { onMessage, answerQuestion, answerDirect, today } from './handlers.js';
import { foldChat, memoryReport } from './memory.js';
import { runCron } from './cron.js';
import { onMembersAdded, onChatEntered, welcomeText, welcomeOnce } from './onboard.js';
import { refreshIndex } from './search.js';
import { joinFromTap } from './join.js';

// A Join button was tapped. Lark waits at most 3 s for the toast, so only the join happens now;
// the details follow as a DM.
async function onJoinTapped({ env, body, ctx }) {
  const store = createStore(env.DB);
  const lark = createLark(env, fetch, store);
  const out = await joinFromTap({ env, lark, store, body, log: console.log });
  if (!out) return json({});
  ctx.waitUntil(lark.sendPostToUser(out.userId, '', out.dm).catch((err) => console.log(`join details failed: ${err.message}`)));
  return json({ toast: out.toast });
}

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export async function readLarkBody(request, env) {
  // Fail closed: nothing is accepted until Lark's token is stored, and once an
  // encrypt key is set, only encrypted bodies are.
  if (!env.LARK_VERIFICATION_TOKEN) throw new Error('LARK_VERIFICATION_TOKEN is not set yet');
  const raw = await request.text();
  let body = JSON.parse(raw);
  if (env.LARK_ENCRYPT_KEY && !body.encrypt) throw new Error('expected an encrypted body');
  if (body.encrypt) {
    if (!env.LARK_ENCRYPT_KEY) throw new Error('encrypted body but no LARK_ENCRYPT_KEY');
    // URL verification is unsigned; every real event must carry a valid signature.
    const plain = JSON.parse(await decryptLark(body.encrypt, env.LARK_ENCRYPT_KEY));
    if (plain.type !== 'url_verification' && !(await signatureOk(request.headers, raw, env.LARK_ENCRYPT_KEY))) {
      throw new Error('bad signature');
    }
    body = plain;
  }
  const token = body.token || body.header?.token;
  if (token !== env.LARK_VERIFICATION_TOKEN) throw new Error('bad verification token');
  return body;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    // Private test door: ask a group's bot a question and see the answer without posting it.
    // Locked by DEBUG_KEY (a long random secret); without it the path doesn't exist.
    if (request.method === 'POST' && url.pathname === '/debug/ask') {
      if (!env.DEBUG_KEY || request.headers.get('x-debug-key') !== env.DEBUG_KEY) return new Response('Not found', { status: 404 });
      const { chatId, question, dmUserId } = await request.json();
      const logs = [];
      try {
        const store = createStore(env.DB);
        const deps = { env, lark: createLark(env, fetch, store), store, chatId, question, log: (l) => logs.push(l) };
        const answer = dmUserId ? await answerDirect({ ...deps, userId: dmUserId }) : await answerQuestion({ ...deps, asker: 'Claude (test)' });
        return json({ ...answer, logs });
      } catch (err) {
        return json({ error: err.message, logs }, 500);
      }
    }
    if (request.method === 'POST' && url.pathname === '/debug/onboard') {
      if (!env.DEBUG_KEY || request.headers.get('x-debug-key') !== env.DEBUG_KEY) return new Response('Not found', { status: 404 });
      const { name, openId, send } = await request.json();
      const logs = [];
      const text = welcomeText({ name });
      if (!(send && openId)) return json({ text, sent: false, logs });
      const store = createStore(env.DB);
      try {
        const sent = await welcomeOnce({ lark: createLark(env, fetch, store), store, openId, name, log: (l) => logs.push(l) });
        return json({ text, sent, alreadyWelcomed: !sent, logs });
      } catch (err) {
        return json({ text, sent: false, error: err.message, logs }, 502);
      }
    }
    // Fills the search index now (the cron does it every 6 hours). Run again while wiki pages are left.
    if (request.method === 'POST' && url.pathname === '/debug/reindex') {
      if (!env.DEBUG_KEY || request.headers.get('x-debug-key') !== env.DEBUG_KEY) return new Response('Not found', { status: 404 });
      const logs = [];
      const store = createStore(env.DB);
      const stats = await refreshIndex({ env, lark: createLark(env, fetch, store), store, log: (l) => logs.push(l) });
      return json({ stats, logs });
    }
    // Updates one chat's memory now and shows it (the owner's check; normally automatic).
    if (request.method === 'POST' && url.pathname === '/debug/memory') {
      if (!env.DEBUG_KEY || request.headers.get('x-debug-key') !== env.DEBUG_KEY) return new Response('Not found', { status: 404 });
      const { chatId } = await request.json();
      const logs = [];
      const store = createStore(env.DB);
      const lark = createLark(env, fetch, store);
      const isPrivate = !(await lark.listChats()).some((g) => g.chat_id === chatId);
      const result = await foldChat({ env, lark, store, chatId, isPrivate, today: today(env.TIMEZONE || 'Asia/Kuala_Lumpur'), log: (l) => logs.push(l) }).catch((err) => ({ error: err.message }));
      return json({ result, report: await memoryReport(store, chatId), logs });
    }
    if (request.method === 'POST' && url.pathname === '/debug/usage') {
      if (!env.DEBUG_KEY || request.headers.get('x-debug-key') !== env.DEBUG_KEY) return new Response('Not found', { status: 404 });
      const { usageNumbers, usageReport } = await import('./usage.js');
      const u = await usageNumbers(createStore(env.DB));
      return json({ ...u, report: usageReport(u) });
    }
    if (request.method === 'POST' && url.pathname === '/debug/models') {
      if (!env.DEBUG_KEY || request.headers.get('x-debug-key') !== env.DEBUG_KEY) return new Response('Not found', { status: 404 });
      const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200', { headers: { 'x-goog-api-key': env.GEMINI_API_KEY } });
      const body = await r.json();
      return json((body.models || []).filter((m) => (m.supportedGenerationMethods || []).includes('generateContent')).map((m) => m.name));
    }
    if (request.method !== 'POST' || url.pathname !== '/lark/events') return new Response('Not found', { status: 404 });
    let body;
    try {
      body = await readLarkBody(request, env);
    } catch (err) {
      console.log(`rejected: ${err.message}`);
      return json({ error: 'rejected' }, 401);
    }
    if (body.type === 'url_verification') return json({ challenge: body.challenge });

    const eventType = body.header?.event_type;
    const eventId = body.header?.event_id;
    if (eventType === 'card.action.trigger') return onJoinTapped({ env, body, ctx });
    if (eventType === 'im.chat.access_event.bot_p2p_chat_entered_v1' && eventId) {
      const store = createStore(env.DB);
      const lark = createLark(env, fetch, store);
      ctx.waitUntil(
        (async () => {
          if (!(await store.firstTime(eventId))) return;
          await onChatEntered({ lark, store, event: body.event });
        })().catch((err) => console.log(`welcome on chat open failed: ${err.message}`))
      );
    }
    if (eventType === 'im.chat.member.user.added_v1' && eventId) {
      const store = createStore(env.DB);
      const lark = createLark(env, fetch, store);
      ctx.waitUntil(
        (async () => {
          if (!(await store.firstTime(eventId))) return;
          await onMembersAdded({ env, lark, store, event: body.event });
        })().catch((err) => console.log(`onboarding failed: ${err.message}`))
      );
    }
    if (eventType === 'im.message.receive_v1' && eventId) {
      const store = createStore(env.DB);
      const lark = createLark(env, fetch, store);
      // Answer Lark at once (it retries after 3 s); do the work in the background.
      ctx.waitUntil(
        (async () => {
          if (!(await store.firstTime(eventId))) return;
          await onMessage({ env, lark, store, event: body.event });
        })().catch((err) => console.log(`message handling failed: ${err.message}`))
      );
    }
    return json({ ok: true });
  },

  async scheduled(_controller, env, ctx) {
    const store = createStore(env.DB);
    ctx.waitUntil(runCron({ env, lark: createLark(env, fetch, store), store }).catch((err) => console.log(`cron failed: ${err.message}`)));
  },
};
