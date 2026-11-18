// Lark webhook security: decrypt the body (AES-256-CBC) and check the signature.
// https://open.larksuite.com/document/server-docs/event-subscription-guide/event-subscription-configure-/encrypt-key-encryption-configuration-case

const enc = new TextEncoder();
const dec = new TextDecoder();

function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

function toHex(buffer) {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function sha256Hex(text) {
  return toHex(await crypto.subtle.digest('SHA-256', enc.encode(text)));
}

// Lark encrypts with key = SHA-256(encryptKey); the first 16 bytes of the payload are the IV.
export async function decryptLark(encrypted, encryptKey) {
  const raw = base64ToBytes(encrypted);
  const keyBytes = await crypto.subtle.digest('SHA-256', enc.encode(encryptKey));
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-CBC' }, false, ['decrypt']);
  const plain = await crypto.subtle.decrypt({ name: 'AES-CBC', iv: raw.slice(0, 16) }, key, raw.slice(16));
  return dec.decode(plain);
}

// X-Lark-Signature = sha256(timestamp + nonce + encryptKey + rawBody), hex.
export async function signatureOk(headers, rawBody, encryptKey) {
  const timestamp = headers.get('x-lark-request-timestamp');
  const nonce = headers.get('x-lark-request-nonce');
  const signature = headers.get('x-lark-signature');
  if (!timestamp || !nonce || !signature) return false;
  const expected = await sha256Hex(timestamp + nonce + encryptKey + rawBody);
  return sameText(expected, String(signature).toLowerCase());
}

// Compares in time that doesn't depend on where the texts first differ.
function sameText(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// For tests: encrypt the way Lark does.
export async function encryptLark(plainText, encryptKey) {
  const keyBytes = await crypto.subtle.digest('SHA-256', enc.encode(encryptKey));
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-CBC' }, false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(16));
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-CBC', iv }, key, enc.encode(plainText)));
  const all = new Uint8Array(16 + cipher.length);
  all.set(iv, 0);
  all.set(cipher, 16);
  return btoa(String.fromCharCode(...all));
}
