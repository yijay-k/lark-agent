// Meaning search: texts become embeddings (lists of numbers from a small neural network, close
// together when the meaning is close), stored and searched in Cloudflare Vectorize.
// Both are free-plan Cloudflare services reached through bindings (env.AI, env.VECTORS).

const DEFAULT_EMBED_MODEL = '@cf/baai/bge-m3';
const BATCH = 20;
const EMBED_CHARS = 2000;
const MAX_ID_BYTES = 64; // Vectorize's limit on a vector id
const META_BODY_CHARS = 1500;

export const vectorsOn = (env) => Boolean(env.AI && env.VECTORS);

// One embedding per text, in order.
export async function embed(env, texts) {
  const out = [];
  for (let i = 0; i < texts.length; i += BATCH) {
    const batch = texts.slice(i, i + BATCH).map((t) => String(t || ' ').slice(0, EMBED_CHARS));
    const res = await env.AI.run(env.EMBED_MODEL || DEFAULT_EMBED_MODEL, { text: batch });
    if (!Array.isArray(res?.data) || res.data.length !== batch.length) throw new Error('embedding: unexpected reply');
    out.push(...res.data);
  }
  return out;
}

// FNV-1a: a short, stable fingerprint of a text (not for security).
export function fingerprint(text) {
  let h = 0x811c9dc5;
  for (const ch of String(text)) { h ^= ch.codePointAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16);
}

export function vectorId(kind, ref, i = 0) {
  const id = `${kind}:${ref}:${i}`;
  return new TextEncoder().encode(id).length <= MAX_ID_BYTES ? id : `${kind}:${fingerprint(ref)}:${i}`;
}

// What a match carries back, so no database read is needed to show it.
export function vectorMeta(kind, ref, row) {
  return { kind, ref: String(ref), chat_id: row.chatId || '', title: row.title || '', body: String(row.body || '').slice(0, META_BODY_CHARS), url: row.url || '', at: Number(row.at || 0) };
}

export async function upsertVectors(env, items) {
  if (!items.length) return;
  const values = await embed(env, items.map((it) => `${it.meta.title}\n${it.meta.body}`.trim()));
  await env.VECTORS.upsert(items.map((it, i) => ({ id: it.id, values: values[i], metadata: it.meta })));
}

export async function deleteVectors(env, ids) {
  if (ids.length) await env.VECTORS.deleteByIds(ids);
}

// Nearest items to a question; `filter` narrows by metadata (chat_id, kind).
export async function nearest(env, vector, { topK = 20, filter } = {}) {
  const res = await env.VECTORS.query(vector, { topK, returnMetadata: 'all', ...(filter ? { filter } : {}) });
  return (res?.matches || []).map((m) => ({ ...m.metadata, score: m.score }));
}
