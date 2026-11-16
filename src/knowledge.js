// The club's knowledge: Lark wiki spaces the bot is a member of. For a question, the
// best-matching pages are read (cached 24 h) and given to the brain. Used in DMs.

const MAX_NODES = 60;
const MAX_DOCS = 4;
const DOC_CHARS = 3500;
const INDEX_KEY = 'lark:wiki-index';

function words(text) {
  return String(text || '').toLowerCase().match(/[a-z0-9]{3,}/g) || [];
}

// Every wiki page title (two levels deep), cached as one index.
async function wikiIndex(lark, store, log) {
  const cached = await store.cachedPage(INDEX_KEY);
  if (cached) {
    try { return JSON.parse(cached); } catch { /* rebuild */ }
  }
  const index = [];
  for (const space of await lark.wikiSpaces().catch(() => [])) {
    const top = await lark.wikiNodes(space.space_id).catch(() => []);
    const children = await Promise.all(top.filter((n) => n.has_child).map((n) => lark.wikiNodes(space.space_id, n.node_token).catch(() => [])));
    for (const n of [...top, ...children.flat()].slice(0, MAX_NODES)) {
      if (n.obj_type === 'docx') index.push({ space: space.name, title: n.title, token: n.obj_token, description: space.description || '' });
    }
  }
  log(`wiki index: ${index.length} pages`);
  await store.savePage(INDEX_KEY, JSON.stringify(index));
  return index;
}

export function rankPages(index, question) {
  const q = new Set(words(question));
  const scored = index.map((p, i) => ({ ...p, score: words(p.title).filter((w) => q.has(w)).length * 3 + (i < 5 ? 1 : 0) }));
  return scored.sort((a, b) => b.score - a.score).slice(0, MAX_DOCS);
}

export async function knowledgeFor({ lark, store, question, log = () => {} }) {
  const index = await wikiIndex(lark, store, log);
  if (index.length === 0) return [];
  const picked = rankPages(index, question);
  const texts = await Promise.all(picked.map(async (p) => {
    const key = `lark:doc:${p.token}`;
    const cached = await store.cachedPage(key);
    if (cached !== null) return cached;
    const text = (await lark.docText(p.token).catch(() => '')).slice(0, DOC_CHARS);
    await store.savePage(key, text);
    return text;
  }));
  const spaces = [...new Set(index.map((p) => `${p.space}: ${p.description}`))];
  return [
    { title: 'Wiki spaces', text: spaces.join('\n') },
    ...picked.map((p, i) => ({ title: `${p.space} › ${p.title}`, text: texts[i] })).filter((d) => d.text),
  ];
}
