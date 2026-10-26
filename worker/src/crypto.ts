// 구독 정보(API 키, 웹훅 주소) 암호화. AES-GCM, 키는 ENCRYPTION_KEY 비밀값.

const enc = new TextEncoder();
const dec = new TextDecoder();

function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function fromBase64(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

let cachedKey: { raw: string; key: CryptoKey } | null = null;

async function importKey(raw: string): Promise<CryptoKey> {
  if (cachedKey?.raw === raw) return cachedKey.key;
  const key = await crypto.subtle.importKey('raw', fromBase64(raw), 'AES-GCM', false, ['encrypt', 'decrypt']);
  cachedKey = { raw, key };
  return key;
}

/** iv(12바이트) + 암호문을 base64로 */
export async function encryptJson(secret: string, value: unknown): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await importKey(secret), enc.encode(JSON.stringify(value)));
  const out = new Uint8Array(iv.length + data.byteLength);
  out.set(iv);
  out.set(new Uint8Array(data), iv.length);
  return toBase64(out);
}

export async function decryptJson<T>(secret: string, payload: string): Promise<T> {
  const bytes = fromBase64(payload);
  const data = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12) }, await importKey(secret), bytes.slice(12));
  return JSON.parse(dec.decode(data)) as T;
}

export function randomToken(bytes = 24): string {
  return toBase64(crypto.getRandomValues(new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function sha256(text: string): Promise<string> {
  return toBase64(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(text))));
}

/** 길이가 달라도 일정 시간에 비교 (토큰 비교용) */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
