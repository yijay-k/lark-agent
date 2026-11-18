// Pure helpers: Lark message content → plain text, links, event tags, web page → text.

const URL_RE = /https?:\/\/[^\s"'<>)\]]+/g;
const EVENT_TAG_RE = /event:([A-Za-z0-9_-]+)/g;
const MAX_PAGE_CHARS = 4000;

function postLines(post) {
  const body = post?.content ? post : Object.values(post || {}).find((v) => v?.content);
  if (!body) return [];
  const title = body.title ? [body.title] : [];
  const lines = (body.content || []).map((row) =>
    (row || []).map((el) => (el.tag === 'a' ? `${el.text} (${el.href})` : el.text || '')).join('')
  );
  return [...title, ...lines];
}

// Lark sends content as a JSON string; text and post are the two kinds people type.
export function messageText(messageType, content) {
  let parsed;
  try {
    parsed = typeof content === 'string' ? JSON.parse(content) : content;
  } catch {
    return '';
  }
  if (messageType === 'text') return String(parsed?.text || '').replace(/@_user_\d+/g, '').trim();
  if (messageType === 'post') return postLines(parsed).join('\n').trim();
  return '';
}

export function formatTime(ts, tz) {
  return new Date(Number(ts) * 1000).toLocaleString('en-GB', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

export function findLinks(text) {
  return [...new Set(String(text || '').match(URL_RE) || [])];
}

export function eventIdsFromDescription(description) {
  return [...String(description || '').matchAll(EVENT_TAG_RE)].map((m) => m[1]);
}

export function htmlToText(html) {
  return String(html || '')
    .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|li|h\d|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#39;|&rsquo;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim()
    .slice(0, MAX_PAGE_CHARS);
}

export function isBotMentioned(mentions, botOpenId) {
  // Events send id as { open_id, ... }; the message API sends it as a plain string.
  return Boolean(botOpenId) && (mentions || []).some((m) => (typeof m?.id === 'string' ? m.id : m?.id?.open_id) === botOpenId);
}

const RESEARCH_RE = /\b(research|look ?up|find out|who (is|are)|panel(ist)?s?|speakers?|background|worth (it|going)|should i (go|attend)|is it worth|tell me about|more about|dig)\b/i;

// "Research" questions get more pages, a web search and a longer answer.
export function isResearch(question) {
  return RESEARCH_RE.test(String(question || ''));
}

const USEFUL_PAGE_RE = /(speaker|panel|programme|program|agenda|schedule|about|venue|faq|ticket|register)/i;

// Links on the same site whose address looks useful (speakers, agenda, venue...).
export function usefulSameSiteLinks(html, pageUrl, max = 4) {
  let base;
  try { base = new URL(pageUrl); } catch { return []; }
  const out = new Set();
  for (const m of String(html || '').matchAll(/href=["']([^"'#]+)["']/gi)) {
    try {
      const u = new URL(m[1], base);
      if (u.hostname === base.hostname && /^https?:$/.test(u.protocol) && USEFUL_PAGE_RE.test(u.pathname) && u.href !== base.href) out.add(u.href.split('?')[0]);
    } catch { /* not a URL */ }
  }
  return [...out].slice(0, max);
}

const STOPWORDS = new Set('the and for are you what when where who how can should does with this that from about have will there their they them your our its into been just also any all get got let tell give please much many some'.split(' '));

export function keywords(text) {
  return [...new Set((String(text || '').toLowerCase().match(/[a-z0-9]{3,}/g) || []).filter((w) => !STOPWORDS.has(w)))];
}

// Keep only the lines of a page that share a word with the question (plus the line after each),
// up to maxChars. The pinned card already holds the essentials, so pages only add the specifics.
export function relevantLines(text, question, maxChars) {
  const words = keywords(question);
  const lines = String(text || '').split('\n').map((l) => l.trim()).filter(Boolean);
  if (words.length === 0) return lines.join('\n').slice(0, maxChars);
  const keep = new Set();
  lines.forEach((line, i) => {
    const lower = line.toLowerCase();
    if (words.some((w) => lower.includes(w))) { keep.add(i); keep.add(i + 1); }
  });
  return [...keep].filter((i) => i < lines.length).sort((a, b) => a - b).map((i) => lines[i]).join('\n').slice(0, maxChars);
}

const USAGE_RE = /\b(usage|quota|credits?|tokens?|api calls?|how much (have you|did you|do you) (use|used|have)|how much (is )?left|limits?)\b/i;

// "@Eleyna usage", "what's your credit?": answered from counters, without the AI.
export function isUsageQuestion(text) {
  return USAGE_RE.test(String(text || '')) && String(text || '').length < 120;
}
