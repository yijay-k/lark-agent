// The bot's brain: Gemini (free tier) first, with Google Search when allowed;
// Cloudflare Workers AI as the free backup when Gemini fails or is out of quota.

const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models';
// Model names are settings (wrangler.toml [vars]); providers retire models often.
const DEFAULT_BACKUP_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
const DEFAULT_GEMINI_MODELS = 'gemini-3.5-flash-lite,gemini-3.8-flash';
const MAX_TOKENS = 900;
const JSON_MAX_TOKENS = 4000; // a memory plan for 60 messages; cut-off JSON can't be parsed

// Lark's message is handled in Cloudflare's 30 s background window (free plan), and reading
// the group takes ~2 s. Everything here shares one budget so an answer always gets posted.
const BUDGET_MS = 25_000;
const BACKUP_RESERVE_MS = 11_000;
const MIN_TRY_MS = 3_000;

async function gemini(env, model, system, prompt, withSearch, fetchImpl, timeoutMs, { json = false } = {}) {
  const res = await fetchImpl(`${GEMINI_URL}/${model}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
    signal: AbortSignal.timeout(timeoutMs),
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      ...(withSearch ? { tools: [{ google_search: {} }] } : {}),
      // Short thinking: these are logistics questions, and speed matters more than depth.
      generationConfig: {
        maxOutputTokens: json ? JSON_MAX_TOKENS : MAX_TOKENS,
        temperature: json ? 0.1 : 0.4,
        thinkingConfig: { thinkingLevel: model.includes('lite') ? 'minimal' : 'low' },
        ...(json ? { responseMimeType: 'application/json' } : {}),
      },
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${body.error?.message || 'error'}`);
  const text = (body.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('').trim();
  if (!text) throw new Error('Gemini returned no text');
  return { text, tokens: Number(body.usageMetadata?.totalTokenCount || 0), promptTokens: Number(body.usageMetadata?.promptTokenCount || 0) };
}

async function workersAi(env, system, prompt, timeoutMs, maxTokens = MAX_TOKENS) {
  const run = env.AI.run(env.BACKUP_MODEL || DEFAULT_BACKUP_MODEL, {
    messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }],
    max_tokens: maxTokens,
  });
  const out = await Promise.race([run, new Promise((_, reject) => setTimeout(() => reject(new Error('backup timed out')), timeoutMs))]);
  // Older Workers AI models answer { response }, newer ones the OpenAI shape { choices }.
  const text = String(out?.response ?? out?.choices?.[0]?.message?.content ?? '').trim();
  if (!text) throw new Error('Workers AI returned no text');
  return { text, tokens: Number(out?.usage?.total_tokens || 0), promptTokens: Number(out?.usage?.prompt_tokens || 0) };
}

// Returns { text, via } so the log shows which brain answered.
// Order: each Gemini model in GEMINI_MODELS (fast Lite first), then Workers AI.
// `startedAt`: when the message arrived; the budget counts from then, so time spent reading the
// chat before thinking can't push the answer past Cloudflare's ~30 s.
export async function think(env, system, prompt, log = () => {}, fetchImpl = fetch, { search = false, startedAt = Date.now() } = {}) {
  const started = startedAt;
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
          const out = await gemini(env, model, system, prompt, withSearch, fetchImpl, timeoutMs);
          log(`${model}${withSearch ? '+search' : ''}: ${Date.now() - t0} ms, ${out.promptTokens} prompt tokens`);
          return { ...out, via: model + (withSearch ? '+search' : '') };
        } catch (err) {
          log(`brain: ${model}${withSearch ? '+search' : ''} failed after ${Date.now() - t0} ms: ${err.name === 'TimeoutError' ? 'timed out' : err.message.slice(0, 120)}`);
        }
      }
    }
  }
  if (env.AI) {
    const t0 = Date.now();
    const out = await workersAi(env, system, prompt, Math.max(left(), MIN_TRY_MS));
    log(`workers-ai: ${Date.now() - t0} ms`);
    return { ...out, via: 'workers-ai' };
  }
  throw new Error('No AI available (set GEMINI_API_KEY or bind Workers AI).');
}

// A JSON answer, parsed (models sometimes wrap it in ``` fences).
export function parseJson(text) {
  const raw = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim();
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('no JSON in the answer');
  return JSON.parse(raw.slice(start, end + 1));
}

// For background jobs that need structured output (writing memory): MEMORY_MODELS in order
// (stronger first), then the free backup. Returns { value, via, tokens }; throws if none answers.
export async function thinkJson(env, system, prompt, { log = () => {}, fetchImpl = fetch, timeoutMs = 15_000 } = {}) {
  const started = Date.now();
  const left = () => timeoutMs - (Date.now() - started);
  const models = String(env.MEMORY_MODELS || env.GEMINI_MODELS || DEFAULT_GEMINI_MODELS).split(',').map((m) => m.trim()).filter(Boolean);
  if (env.GEMINI_API_KEY) {
    for (const model of models) {
      if (left() < MIN_TRY_MS) break;
      try {
        const out = await gemini(env, model, system, prompt, false, fetchImpl, left(), { json: true });
        return { value: parseJson(out.text), via: model, tokens: out.tokens };
      } catch (err) {
        log(`json: ${model} failed: ${err.name === 'TimeoutError' ? 'timed out' : err.message.slice(0, 120)}`);
      }
    }
  }
  if (env.AI && left() >= MIN_TRY_MS) {
    const out = await workersAi(env, `${system}\nReply with the JSON object only.`, prompt, left(), JSON_MAX_TOKENS);
    return { value: parseJson(out.text), via: 'workers-ai', tokens: out.tokens };
  }
  throw new Error('no model answered');
}
