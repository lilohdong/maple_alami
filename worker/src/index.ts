// 메이플 할일 알리미 알림 Worker
// - HTTP: 앱에서 디스코드 알림 구독 등록/수정/삭제/테스트
// - Cron: 리셋 전 남은 할일을 디스코드 웹훅으로 전송

import { getCharacterList, getCharacterState, NexonApiError } from '../../src/api/nexon';
import type { PartySizes } from '../../src/lib/progress';
import { decryptJson, encryptJson, randomToken, safeEqual, sha256 } from './crypto';
import { buildEmbed, DEFAULT_PREFS, dueKinds, type CharacterReport, type DiscordEmbed, type NotifyKind, type Prefs } from './notify';

interface Env {
  SUBS: KVNamespace;
  ENCRYPTION_KEY: string;
  INVITE_CODE?: string;
  ALLOWED_ORIGINS: string;
}

/** KV에 암호화되어 저장되는 구독 정보 */
interface Subscription {
  tokenHash: string;
  apiKey: string;
  webhookUrl: string;
  characters: string[];
  party: Record<string, PartySizes>;
  prefs: Prefs;
  createdAt: string;
}

/** 요청 본문 */
interface SubscriptionInput {
  inviteCode?: string;
  apiKey: string;
  webhookUrl: string;
  characters: string[];
  party?: Record<string, PartySizes>;
  prefs?: Partial<Prefs>;
}

const MAX_CHARACTERS = 8;
const REQUEST_GAP_MS = 250;
const WEBHOOK_RE = /^https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+$/;

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const kvKey = (id: string) => `sub:${id}`;

// ---------- Discord ----------

async function sendDiscord(webhookUrl: string, payload: { content?: string; embeds?: DiscordEmbed[] }): Promise<Response> {
  return fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: '메이플 할일 알리미', allowed_mentions: { parse: [] }, ...payload }),
  });
}

// ---------- 구독 저장소 ----------

async function loadSub(env: Env, id: string): Promise<Subscription | null> {
  const raw = await env.SUBS.get(kvKey(id));
  return raw ? decryptJson<Subscription>(env.ENCRYPTION_KEY, raw) : null;
}

async function saveSub(env: Env, id: string, sub: Subscription): Promise<void> {
  await env.SUBS.put(kvKey(id), await encryptJson(env.ENCRYPTION_KEY, sub));
}

async function authorize(env: Env, request: Request, id: string): Promise<Subscription> {
  const token = request.headers.get('Authorization')?.replace(/^Bearer\s+/i, '') ?? '';
  const sub = await loadSub(env, id);
  if (!sub || !token || !safeEqual(await sha256(token), sub.tokenHash)) throw new HttpError(404, '알림 등록 정보를 찾을 수 없습니다.');
  return sub;
}

// ---------- 입력 검증 ----------

async function readInput(request: Request): Promise<SubscriptionInput> {
  const body = (await request.json().catch(() => null)) as SubscriptionInput | null;
  if (!body || typeof body.apiKey !== 'string' || typeof body.webhookUrl !== 'string' || !Array.isArray(body.characters)) {
    throw new HttpError(400, '요청 형식이 올바르지 않습니다.');
  }
  body.webhookUrl = body.webhookUrl.trim();
  if (!WEBHOOK_RE.test(body.webhookUrl)) throw new HttpError(400, '디스코드 웹훅 주소가 올바르지 않습니다.');
  if (body.characters.length === 0) throw new HttpError(400, '알림 받을 캐릭터를 선택해주세요.');
  if (body.characters.length > MAX_CHARACTERS) throw new HttpError(400, `캐릭터는 최대 ${MAX_CHARACTERS}개까지 등록할 수 있습니다.`);
  return body;
}

/** API 키가 유효하고, 캐릭터가 모두 그 키의 계정 소속인지 확인 */
async function verifyOwnership(apiKey: string, characters: string[]): Promise<void> {
  let owned: Set<string>;
  try {
    owned = new Set((await getCharacterList(apiKey)).map((c) => c.ocid));
  } catch (e) {
    throw new HttpError(400, e instanceof NexonApiError ? e.message : '넥슨 API 확인에 실패했습니다.');
  }
  if (!characters.every((ocid) => owned.has(ocid))) throw new HttpError(400, '본인 계정의 캐릭터만 등록할 수 있습니다.');
}

function sanitizeParty(party: SubscriptionInput['party'], characters: string[]): Record<string, PartySizes> {
  const out: Record<string, PartySizes> = {};
  for (const ocid of characters) {
    const sizes = party?.[ocid];
    if (!sizes || typeof sizes !== 'object') continue;
    out[ocid] = Object.fromEntries(
      Object.entries(sizes)
        .filter(([k, v]) => k.length <= 64 && Number.isInteger(v) && v >= 1 && v <= 6)
        .slice(0, 100),
    );
  }
  return out;
}

const sanitizePrefs = (p: Partial<Prefs> | undefined): Prefs => ({
  weeklyBoss: p?.weeklyBoss ?? DEFAULT_PREFS.weeklyBoss,
  weeklyContent: p?.weeklyContent ?? DEFAULT_PREFS.weeklyContent,
  daily: p?.daily ?? DEFAULT_PREFS.daily,
});

// ---------- 알림 실행 ----------

async function collectReports(sub: Subscription): Promise<CharacterReport[]> {
  const reports: CharacterReport[] = [];
  for (const [i, ocid] of sub.characters.entries()) {
    if (i > 0) await sleep(REQUEST_GAP_MS);
    try {
      reports.push({ ocid, state: await getCharacterState(sub.apiKey, ocid) });
    } catch (e) {
      reports.push({ ocid, state: null, error: e instanceof NexonApiError ? e.message : '조회 실패' });
    }
  }
  return reports;
}

/** 보낼 내용이 있으면 전송. 웹훅이 삭제된 경우 'gone' */
async function notify(sub: Subscription, kinds: NotifyKind[]): Promise<'sent' | 'skipped' | 'gone'> {
  const reports = await collectReports(sub);
  const embeds = kinds.map((k) => buildEmbed(k, reports, sub.party)).filter((e): e is DiscordEmbed => e !== null);
  if (embeds.length === 0) return 'skipped';
  const res = await sendDiscord(sub.webhookUrl, { embeds });
  if (res.status === 404 || res.status === 401) return 'gone';
  return 'sent';
}

async function runScheduled(env: Env, scheduledTime: number): Promise<void> {
  const kinds = dueKinds(scheduledTime);
  if (kinds.length === 0) return;

  let cursor: string | undefined;
  do {
    const page = await env.SUBS.list({ prefix: 'sub:', cursor });
    for (const { name } of page.keys) {
      const id = name.slice(4);
      try {
        const sub = await loadSub(env, id);
        if (!sub) continue;
        const enabled = kinds.filter((k) => k !== 'status' && sub.prefs[k]);
        if (enabled.length === 0) continue;
        if ((await notify(sub, enabled)) === 'gone') await env.SUBS.delete(name);
      } catch (e) {
        console.error('notify failed', id, e);
      }
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
}

// ---------- HTTP ----------

function corsHeaders(env: Env, request: Request): Record<string, string> {
  const origin = request.headers.get('Origin') ?? '';
  const allowed = env.ALLOWED_ORIGINS.split(',').map((s) => s.trim());
  return allowed.includes(origin)
    ? {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Methods': 'POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Max-Age': '86400',
        Vary: 'Origin',
      }
    : {};
}

const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers } });

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const parts = url.pathname.split('/').filter(Boolean); // ['subscriptions', id?, 'test'?]
  if (parts[0] !== 'subscriptions') throw new HttpError(404, 'Not Found');
  const id = parts[1];

  // 등록
  if (!id && request.method === 'POST') {
    const input = await readInput(request);
    if (env.INVITE_CODE && !safeEqual(input.inviteCode ?? '', env.INVITE_CODE)) throw new HttpError(403, '초대 코드가 올바르지 않습니다.');
    await verifyOwnership(input.apiKey, input.characters);

    const welcome = await sendDiscord(input.webhookUrl, { content: '✅ 메이플 할일 알리미 알림이 연결되었습니다.' });
    if (!welcome.ok) throw new HttpError(400, '디스코드 웹훅으로 메시지를 보내지 못했습니다. 주소를 확인해주세요.');

    const newId = randomToken(12);
    const token = randomToken();
    await saveSub(env, newId, {
      tokenHash: await sha256(token),
      apiKey: input.apiKey,
      webhookUrl: input.webhookUrl,
      characters: input.characters,
      party: sanitizeParty(input.party, input.characters),
      prefs: sanitizePrefs(input.prefs),
      createdAt: new Date().toISOString(),
    });
    return json({ id: newId, token }, 201);
  }

  if (!id) throw new HttpError(405, 'Method Not Allowed');
  const sub = await authorize(env, request, id);

  // 수정 (캐릭터/파티/알림 종류/키 변경)
  if (parts.length === 2 && request.method === 'PUT') {
    const input = await readInput(request);
    if (input.apiKey !== sub.apiKey || input.characters.some((c) => !sub.characters.includes(c))) {
      await verifyOwnership(input.apiKey, input.characters);
    }
    await saveSub(env, id, {
      ...sub,
      apiKey: input.apiKey,
      webhookUrl: input.webhookUrl,
      characters: input.characters,
      party: sanitizeParty(input.party, input.characters),
      prefs: sanitizePrefs(input.prefs),
    });
    return json({ ok: true });
  }

  // 해지
  if (parts.length === 2 && request.method === 'DELETE') {
    await env.SUBS.delete(kvKey(id));
    return json({ ok: true });
  }

  // 지금 현황 보내기
  if (parts.length === 3 && parts[2] === 'test' && request.method === 'POST') {
    const result = await notify(sub, ['status']);
    if (result === 'gone') throw new HttpError(400, '디스코드 웹훅이 삭제되었거나 유효하지 않습니다.');
    return json({ ok: true });
  }

  throw new HttpError(405, 'Method Not Allowed');
}

export default {
  async fetch(request, env): Promise<Response> {
    const cors = corsHeaders(env, request);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    try {
      const res = await route(request, env);
      for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
      return res;
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status, cors);
      console.error(e);
      return json({ error: '서버 오류가 발생했습니다.' }, 500, cors);
    }
  },

  async scheduled(controller, env, ctx): Promise<void> {
    ctx.waitUntil(runScheduled(env, controller.scheduledTime));
  },
} satisfies ExportedHandler<Env>;
