// A Lark Base (e.g. the PR Tracker) inside a wiki space, read as plain text so it can be searched
// like a wiki page: one line per record, "[Table] Field: value · Field: value".
// Read only. Costs 1 call for the tables plus 1 per table, so the cron re-reads a Base at most
// every BASE_RECHECK_MS (see search.js), and a Base is searched with the same per-chat limits as
// the wiki page it sits on.

const MAX_TABLES = 6;
// Rows kept per table: the newest (Lark lists oldest first), since those are what people ask about.
const MAX_ROWS = 300;
const VALUE_CHARS = 300;
// Numbers this large are Base dates (milliseconds since 1970).
const DATE_MS = 1e12;

function dateText(ms, tz) {
  return new Date(ms).toLocaleString('en-GB', { timeZone: tz, day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
}

// One cell as text: people and options by name, links by their text, dates readable.
export function cellText(value, tz = 'Asia/Kuala_Lumpur') {
  if (value === null || value === undefined || value === '') return '';
  if (typeof value === 'number') return value >= DATE_MS ? dateText(value, tz) : String(value);
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map((v) => cellText(v, tz)).filter(Boolean).join(', ');
  if (typeof value === 'object') {
    if (Array.isArray(value.text_arr)) return value.text_arr.join(', '); // a linked record
    if (Array.isArray(value.link_record_ids)) return ''; // only ids: nothing readable
    if ('value' in value) return cellText(value.value, tz); // formula and lookup fields
    return String(value.name || value.text || value.en_name || value.link || value.full_address || '');
  }
  return '';
}

// Emails and phone numbers never reach the index or a prompt.
const EMAIL = /[\w.+-]+@[\w-]+(\.[\w-]+)+/g;
// 9+ digits with optional spaces or dashes ("012-345 6789"); dates like 2026-11-24 have only 8.
const PHONE = /(?<![\d-])\+?\d(?:[\s-]?\d){8,}(?![\d-])/g;
const redact = (text) => text.replace(EMAIL, '[email]').replace(PHONE, '[phone]');

export function recordLine(table, fields, tz) {
  const parts = Object.entries(fields || {})
    .map(([name, v]) => [name, redact(cellText(v, tz).replace(/\s+/g, ' ').trim()).slice(0, VALUE_CHARS)])
    .filter(([, text]) => text)
    .map(([name, text]) => `${name}: ${text}`);
  return parts.length ? `[${table}] ${parts.join(' · ')}` : '';
}

export async function baseText(lark, appToken, tz = 'Asia/Kuala_Lumpur') {
  const tables = (await lark.baseTables(appToken)).slice(0, MAX_TABLES);
  const blocks = [];
  for (const t of tables) {
    const records = (await lark.baseRecords(appToken, t.table_id)).slice(-MAX_ROWS);
    const lines = records.map((r) => recordLine(t.name, r.fields, tz)).filter(Boolean);
    blocks.push(`## ${t.name}\n${lines.length ? lines.join('\n') : '(no rows yet)'}`);
  }
  return blocks.join('\n\n');
}
