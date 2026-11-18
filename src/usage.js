// Eleyna's own usage: Lark API calls (the free plan allows ~10,000 a month for the whole
// organisation), AI answers and tokens. Reported without the AI, so it costs no tokens.

import { usageKey } from './lark.js';

const LARK_MONTHLY_LIMIT = 10_000;
const ALERT_LEVELS = [75, 90];

const month = (d = new Date()) => d.toISOString().slice(0, 7);

export async function recordAnswer(store, answer) {
  const m = month();
  const backup = answer.via === 'workers-ai';
  await Promise.all([
    store.bump(`ai-answers:${m}`),
    store.bump(`ai-tokens:${m}`, Math.max(0, Math.round(answer.tokens || 0))),
    backup ? store.bump(`ai-backup:${m}`) : null,
  ]).catch(() => {});
}

export async function usageNumbers(store, now = new Date()) {
  const m = month(now);
  const [lark, answers, tokens, backup] = await Promise.all([
    store.counter(usageKey(now)), store.counter(`ai-answers:${m}`), store.counter(`ai-tokens:${m}`), store.counter(`ai-backup:${m}`),
  ]);
  const day = now.getUTCDate();
  const daysInMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
  return { month: m, lark, percent: Math.round((lark / LARK_MONTHLY_LIMIT) * 100), pace: Math.round((lark / Math.max(day, 1)) * daysInMonth), answers, tokens, backup };
}

export function usageReport(u) {
  return [
    `📊 **Eleyna's usage · ${u.month}**`,
    `- **Lark API calls:** ${u.lark.toLocaleString('en')} / ${LARK_MONTHLY_LIMIT.toLocaleString('en')} this month (${u.percent}%), on pace for ~${u.pace.toLocaleString('en')}`,
    `- **Answers:** ${u.answers} (${u.answers - u.backup} by Gemini, ${u.backup} by the backup) · **AI tokens:** ~${Math.round(u.tokens / 1000)}k`,
    `- Gemini's free quota isn't published, so I can't show what's left; if it runs out I switch to the backup.`,
    `- The Lark count is only my calls; the ChatGPT connector uses the same 10,000.`,
  ].join('\n');
}

// Called by the cron: one message per level per month to ALERT_CHAT_ID.
export async function checkAlerts({ env, lark, store, log = console.log }) {
  if (!env.ALERT_CHAT_ID) return;
  const u = await usageNumbers(store);
  for (const level of ALERT_LEVELS) {
    const kind = `alert:${u.month}:${level}`;
    if (u.percent >= level && !(await store.briefed('admin', kind))) {
      await lark.sendPost(env.ALERT_CHAT_ID, `⚠️ Lark API at ${u.percent}%`, usageReport(u) + `\n\nAt 100% Lark stops answering the bot and the ChatGPT connector until next month.`);
      await store.markBriefed('admin', kind);
      log(`usage alert ${level}% sent`);
    }
  }
}
