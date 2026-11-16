// The bot's brain: Gemini (free tier) first, with Google Search when allowed;
// Cloudflare Workers AI as the free backup when Gemini fails or is out of quota.

const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models';
// Model names are settings (wrangler.toml [vars]); providers retire models often.
const DEFAULT_BACKUP_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
const DEFAULT_GEMINI_MODELS = 'gemini-3.5-flash-lite,gemini-3.8-flash';
const MAX_TOKENS = 900;

// Lark's message is handled in Cloudflare's 30 s background window (free plan), and reading
// the group takes ~2 s. Everything here shares one budget so an answer always gets posted.
const BUDGET_MS = 25_000;
const BACKUP_RESERVE_MS = 11_000;
const MIN_TRY_MS = 3_000;

async function gemini(env, model, system, prompt, withSearch, fetchImpl, timeoutMs) {
  const res = await fetchImpl(`${GEMINI_URL}/${model}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
    signal: AbortSignal.timeout(timeoutMs),
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      ...(withSearch ? { tools: [{ google_search: {} }] } : {}),
      // Short thinking: these are logistics questions, and speed matters more than depth.
      generationConfig: { maxOutputTokens: MAX_TOKENS, temperature: 0.4, thinkingConfig: { thinkingLevel: model.includes('lite') ? 'minimal' : 'low' } },
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${body.error?.message || 'error'}`);
  const text = (body.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('').trim();
  if (!text) throw new Error('Gemini returned no text');
  return text;
}

async function workersAi(env, system, prompt, timeoutMs) {
  const run = env.AI.run(env.BACKUP_MODEL || DEFAULT_BACKUP_MODEL, {
    messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }],
    max_tokens: MAX_TOKENS,
  });
  const out = await Promise.race([run, new Promise((_, reject) => setTimeout(() => reject(new Error('backup timed out')), timeoutMs))]);
  // Older Workers AI models answer { response }, newer ones the OpenAI shape { choices }.
  const text = String(out?.response ?? out?.choices?.[0]?.message?.content ?? '').trim();
  if (!text) throw new Error('Workers AI returned no text');
  return text;
}

// Returns { text, via } so the log shows which brain answered.
// Order: each Gemini model in GEMINI_MODELS (fast Lite first), then Workers AI.
export async function think(env, system, prompt, log = () => {}, fetchImpl = fetch, { search = false } = {}) {
  const started = Date.now();
  const left = () => BUDGET_MS - (Date.now() - started);
  if (env.GEMINI_API_KEY) {
    const models = String(env.GEMINI_MODELS || DEFAULT_GEMINI_MODELS).split(',').map((m) => m.trim()).filter(Boolean);
    // Web search is off unless GEMINI_SEARCH = "on": Google's free tier refused it (429).
    // Research questions try Google Search once on the first (Lite) model; free quota may refuse it.
    const searchRoutes = env.GEMINI_SEARCH === 'on' ? [true, false] : [false];
    for (const [index, model] of models.entries()) {
      for (const withSearch of search && index === 0 ? [true, false] : searchRoutes) {
        const timeoutMs = left() - (env.AI ? BACKUP_RESERVE_MS : 0);
        if (timeoutMs < MIN_TRY_MS) break;
        const t0 = Date.now();
        try {
          const text = await gemini(env, model, system, prompt, withSearch, fetchImpl, timeoutMs);
          log(`${model}${withSearch ? '+search' : ''}: ${Date.now() - t0} ms`);
          return { text, via: model + (withSearch ? '+search' : '') };
        } catch (err) {
          log(`brain: ${model}${withSearch ? '+search' : ''} failed after ${Date.now() - t0} ms: ${err.name === 'TimeoutError' ? 'timed out' : err.message.slice(0, 120)}`);
        }
      }
    }
  }
  if (env.AI) {
    const t0 = Date.now();
    const text = await workersAi(env, system, prompt, Math.max(left(), MIN_TRY_MS));
    log(`workers-ai: ${Date.now() - t0} ms`);
    return { text, via: 'workers-ai' };
  }
  throw new Error('No AI available (set GEMINI_API_KEY or bind Workers AI).');
}
