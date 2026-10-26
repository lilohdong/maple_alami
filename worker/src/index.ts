// 메이플 할일 알리미 알림 Worker
// - HTTP /subscriptions: 앱에서 알림 구독 등록/조회/수정/삭제/테스트
// - HTTP /discord/interactions: 디스코드 봇 슬래시 명령 (/연결, /현황, /해제)
// - Cron: 리셋 전 남은 할일을 디스코드(봇 채널 멘션 또는 웹훅)로 전송

import { getCharacterList, getCharacterState, NexonApiError } from '../../src/api/nexon';
import type { PartySizes } from '../../src/lib/progress';
import { decryptJson, encryptJson, randomToken, safeEqual, sha256 } from './crypto';
import {
  editOriginalResponse,
  EPHEMERAL,
  InteractionType,
  interactionUserId,
  option,
  registerCommands,
  ResponseType,
  sendChannelMessage,
  verifyInteraction,
  type Interaction,
} from './discord';
import { buildEmbeds, DEFAULT_PREFS, dueKinds, type CharacterReport, type DiscordEmbed, type NotifyKind, type Prefs } from './notify';

interface Env {
  SUBS: KVNamespace;
  ENCRYPTION_KEY: string;
  INVITE_CODE?: string;
  ALLOWED_ORIGINS: string;
  DISCORD_APP_ID?: string;
  DISCORD_PUBLIC_KEY?: string;
  DISCORD_BOT_TOKEN?: string;
}

/** 봇으로 받을 때의 전송 대상 (/연결 명령을 실행한 채널과 사람) */
interface DiscordTarget {
  userId: string;
  channelId: string;
  guildId?: string;
}

/** KV에 암호화되어 저장되는 구독 정보. 전송 대상은 discord(봇) 또는 webhookUrl 중 하나 */
interface Subscription {
  tokenHash: string;
  apiKey: string;
  webhookUrl?: string;
  discord?: DiscordTarget;
  characters: string[];
  party: Record<string, PartySizes>;
  /** 캐릭터 외형 이미지 (예전 구독에는 없을 수 있음) */
  images?: Record<string, string>;
  prefs: Prefs;
  createdAt: string;
}

/** 요청 본문. webhookUrl이 없으면 봇 연결 코드를 발급 */
interface SubscriptionInput {
  inviteCode?: string;
  apiKey: string;
  webhookUrl?: string;
  characters: string[];
  party?: Record<string, PartySizes>;
  images?: Record<string, string>;
  prefs?: Partial<Prefs>;
}

const MAX_CHARACTERS = 8;
const REQUEST_GAP_MS = 250;
const LINK_CODE_TTL_SEC = 30 * 60;
const NEXON_IMAGE_PREFIX = 'https://open.api.nexon.com/static/maplestory/';
const WEBHOOK_RE = /^https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+$/;

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const kvKey = (id: string) => `sub:${id}`;
const codeKey = (code: string) => `code:${code}`;
const userKey = (userId: string) => `discord:${userId}`;

// ---------- 구독 저장소 ----------

async function loadSub(env: Env, id: string): Promise<Subscription | null> {
  const raw = await env.SUBS.get(kvKey(id));
  return raw ? decryptJson<Subscription>(env.ENCRYPTION_KEY, raw) : null;
}

async function saveSub(env: Env, id: string, sub: Subscription): Promise<void> {
  await env.SUBS.put(kvKey(id), await encryptJson(env.ENCRYPTION_KEY, sub));
}

async function deleteSub(env: Env, id: string, sub: Subscription | null): Promise<void> {
  await env.SUBS.delete(kvKey(id));
  if (sub?.discord && (await env.SUBS.get(userKey(sub.discord.userId))) === id) await env.SUBS.delete(userKey(sub.discord.userId));
}

async function authorize(env: Env, request: Request, id: string): Promise<Subscription> {
  const token = request.headers.get('Authorization')?.replace(/^Bearer\s+/i, '') ?? '';
  const sub = await loadSub(env, id);
  if (!sub || !token || !safeEqual(await sha256(token), sub.tokenHash)) throw new HttpError(404, '알림 등록 정보를 찾을 수 없습니다.');
  return sub;
}

/** 헷갈리는 글자(0/O, 1/I 등)를 뺀 6자리 연결 코드 */
async function issueLinkCode(env: Env, id: string): Promise<string> {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  const code = Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
  await env.SUBS.put(codeKey(code), id, { expirationTtl: LINK_CODE_TTL_SEC });
  return code;
}

// ---------- 입력 검증 ----------

async function readInput(request: Request): Promise<SubscriptionInput> {
  const body = (await request.json().catch(() => null)) as SubscriptionInput | null;
  if (!body || typeof body.apiKey !== 'string' || !Array.isArray(body.characters)) {
    throw new HttpError(400, '요청 형식이 올바르지 않습니다.');
  }
  if (body.webhookUrl !== undefined) {
    if (typeof body.webhookUrl !== 'string') throw new HttpError(400, '요청 형식이 올바르지 않습니다.');
    body.webhookUrl = body.webhookUrl.trim() || undefined;
    if (body.webhookUrl && !WEBHOOK_RE.test(body.webhookUrl)) throw new HttpError(400, '디스코드 웹훅 주소가 올바르지 않습니다.');
  }
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

/** 디스코드 썸네일용 캐릭터 이미지. 넥슨 이미지 주소만 허용 */
function sanitizeImages(images: SubscriptionInput['images'], characters: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const ocid of characters) {
    const url = images?.[ocid];
    if (typeof url === 'string' && url.length <= 512 && url.startsWith(NEXON_IMAGE_PREFIX)) out[ocid] = url;
  }
  return out;
}

const sanitizePrefs = (p: Partial<Prefs> | undefined): Prefs => ({
  weeklyBoss: p?.weeklyBoss ?? DEFAULT_PREFS.weeklyBoss,
  weeklyContent: p?.weeklyContent ?? DEFAULT_PREFS.weeklyContent,
  daily: p?.daily ?? DEFAULT_PREFS.daily,
});

// ---------- 전송 ----------

function sendWebhook(webhookUrl: string, payload: { content?: string; embeds?: DiscordEmbed[] }): Promise<Response> {
  return fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: '메이플 할일 알리미', allowed_mentions: { parse: [] }, ...payload }),
  });
}

type DeliveryResult = 'sent' | 'skipped' | 'gone' | 'unlinked' | 'failed';

/** 구독의 전송 대상으로 보냄. 대상(웹훅/채널)이 삭제되었으면 'gone' */
async function deliver(env: Env, sub: Subscription, embeds: DiscordEmbed[]): Promise<DeliveryResult> {
  let res: Response;
  if (sub.discord && env.DISCORD_BOT_TOKEN) {
    res = await sendChannelMessage(env.DISCORD_BOT_TOKEN, sub.discord.channelId, sub.discord.userId, embeds);
  } else if (sub.webhookUrl) {
    res = await sendWebhook(sub.webhookUrl, { embeds });
  } else {
    return 'unlinked';
  }
  if (res.ok) return 'sent';
  // 404: 웹훅/채널 삭제. 401: 웹훅 토큰 무효. 403(봇 권한 없음)은 복구 가능하니 유지
  if (res.status === 404 || (res.status === 401 && !sub.discord)) return 'gone';
  console.error('deliver failed', res.status, await res.text().catch(() => ''));
  return 'failed';
}

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

async function buildFor(sub: Subscription, kinds: NotifyKind[]): Promise<DiscordEmbed[] | null> {
  return buildEmbeds(kinds, await collectReports(sub), sub.party, sub.images ?? {});
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
        if (!sub || (!sub.discord && !sub.webhookUrl)) continue;
        const enabled = kinds.filter((k) => sub.prefs[k]);
        if (enabled.length === 0) continue;
        const embeds = await buildFor(sub, enabled);
        if (embeds && (await deliver(env, sub, embeds)) === 'gone') await deleteSub(env, id, sub);
      } catch (e) {
        console.error('notify failed', id, e);
      }
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
}

// ---------- 앱용 API ----------

function corsHeaders(env: Env, request: Request): Record<string, string> {
  const origin = request.headers.get('Origin') ?? '';
  const allowed = env.ALLOWED_ORIGINS.split(',').map((s) => s.trim());
  return allowed.includes(origin)
    ? {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Max-Age': '86400',
        Vary: 'Origin',
      }
    : {};
}

const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers } });

const destination = (sub: Subscription) => (sub.discord ? 'discord' : sub.webhookUrl ? 'webhook' : null);

async function routeSubscriptions(request: Request, env: Env, parts: string[]): Promise<Response> {
  const id = parts[1];

  // 등록
  if (!id && request.method === 'POST') {
    const input = await readInput(request);
    if (env.INVITE_CODE && !safeEqual(input.inviteCode ?? '', env.INVITE_CODE)) throw new HttpError(403, '초대 코드가 올바르지 않습니다.');
    if (!input.webhookUrl && !env.DISCORD_BOT_TOKEN) throw new HttpError(400, '디스코드 웹훅 주소를 입력해주세요.');
    await verifyOwnership(input.apiKey, input.characters);

    if (input.webhookUrl) {
      const welcome = await sendWebhook(input.webhookUrl, { content: '✅ 메이플 할일 알리미 알림이 연결되었습니다.' });
      if (!welcome.ok) throw new HttpError(400, '디스코드 웹훅으로 메시지를 보내지 못했습니다. 주소를 확인해주세요.');
    }

    const newId = randomToken(12);
    const token = randomToken();
    await saveSub(env, newId, {
      tokenHash: await sha256(token),
      apiKey: input.apiKey,
      webhookUrl: input.webhookUrl,
      characters: input.characters,
      party: sanitizeParty(input.party, input.characters),
      images: sanitizeImages(input.images, input.characters),
      prefs: sanitizePrefs(input.prefs),
      createdAt: new Date().toISOString(),
    });
    const linkCode = input.webhookUrl ? undefined : await issueLinkCode(env, newId);
    return json({ id: newId, token, linkCode }, 201);
  }

  if (!id) throw new HttpError(405, 'Method Not Allowed');
  const sub = await authorize(env, request, id);
  const action = parts[2];

  // 연결 상태
  if (!action && request.method === 'GET') {
    return json({ destination: destination(sub), prefs: sub.prefs });
  }

  // 수정 (캐릭터/파티/알림 종류/키, 웹훅 주소를 보내면 웹훅으로 전환)
  if (!action && request.method === 'PUT') {
    const input = await readInput(request);
    if (input.apiKey !== sub.apiKey || input.characters.some((c) => !sub.characters.includes(c))) {
      await verifyOwnership(input.apiKey, input.characters);
    }
    await saveSub(env, id, {
      ...sub,
      apiKey: input.apiKey,
      webhookUrl: input.webhookUrl ?? sub.webhookUrl,
      characters: input.characters,
      party: sanitizeParty(input.party, input.characters),
      images: sanitizeImages(input.images, input.characters),
      prefs: sanitizePrefs(input.prefs),
    });
    return json({ ok: true });
  }

  // 해지
  if (!action && request.method === 'DELETE') {
    await deleteSub(env, id, sub);
    return json({ ok: true });
  }

  // 봇 연결 코드 재발급
  if (action === 'link-code' && request.method === 'POST') {
    if (!env.DISCORD_BOT_TOKEN) throw new HttpError(400, '디스코드 봇이 설정되지 않았습니다.');
    return json({ linkCode: await issueLinkCode(env, id) });
  }

  // 지금 현황 보내기
  if (action === 'test' && request.method === 'POST') {
    const embeds = await buildFor(sub, ['status']);
    const result = embeds ? await deliver(env, sub, embeds) : 'skipped';
    if (result === 'unlinked') throw new HttpError(400, '아직 디스코드와 연결되지 않았습니다. 디스코드에서 /연결 명령을 먼저 실행해주세요.');
    if (result === 'gone') throw new HttpError(400, '디스코드 웹훅이나 채널이 삭제되었습니다.');
    if (result === 'failed') throw new HttpError(502, '디스코드로 보내지 못했습니다. 봇이 채널에 메시지를 보낼 권한이 있는지 확인해주세요.');
    return json({ ok: true });
  }

  throw new HttpError(405, 'Method Not Allowed');
}

// ---------- 디스코드 봇 ----------

const reply = (content: string, ephemeral = true) =>
  json({ type: ResponseType.MESSAGE, data: { content, flags: ephemeral ? EPHEMERAL : 0, allowed_mentions: { parse: [] } } });

async function handleCommand(env: Env, ctx: ExecutionContext, i: Interaction): Promise<Response> {
  const userId = interactionUserId(i);
  const name = i.data?.name;

  if (name === '연결') {
    const code = String(option(i, '코드') ?? '').trim().toUpperCase();
    const id = code ? await env.SUBS.get(codeKey(code)) : null;
    if (!id) return reply('❌ 연결 코드가 올바르지 않거나 만료되었습니다. 앱의 🔔 알림 설정에서 새 코드를 받아주세요.');
    const sub = await loadSub(env, id);
    if (!sub) return reply('❌ 알림 등록 정보를 찾을 수 없습니다. 앱에서 알림을 다시 켜주세요.');
    if (!i.channel_id) return reply('❌ 서버 채널에서 실행해주세요.');

    // 같은 사람이 예전에 연결한 구독은 해지 (사람당 하나)
    const previous = await env.SUBS.get(userKey(userId));
    if (previous && previous !== id) await deleteSub(env, previous, await loadSub(env, previous));

    await saveSub(env, id, { ...sub, webhookUrl: undefined, discord: { userId, channelId: i.channel_id, guildId: i.guild_id } });
    await env.SUBS.put(userKey(userId), id);
    await env.SUBS.delete(codeKey(code));
    return reply(`✅ 연결되었습니다! 이제 이 채널에서 <@${userId}>님을 멘션해 알림을 보내드려요.\n\`/현황\`으로 언제든 현재 숙제 현황을 볼 수 있습니다.`);
  }

  if (name === '현황') {
    const id = await env.SUBS.get(userKey(userId));
    const sub = id ? await loadSub(env, id) : null;
    if (!sub) return reply('아직 연결되지 않았습니다. 앱의 🔔 알림 설정에서 받은 코드로 `/연결`을 먼저 실행해주세요.');
    // 넥슨 API 조회가 3초를 넘길 수 있어 먼저 "생각 중" 응답 후 내용을 채움
    ctx.waitUntil(
      (async () => {
        const embeds = await buildFor(sub, ['status']);
        await editOriginalResponse(i.application_id, i.token, embeds ? { embeds } : { content: '조회 결과가 없습니다.' });
      })().catch((e) => console.error('status command failed', e)),
    );
    return json({ type: ResponseType.DEFERRED_MESSAGE });
  }

  if (name === '해제') {
    const id = await env.SUBS.get(userKey(userId));
    if (!id) return reply('연결된 알림이 없습니다.');
    await deleteSub(env, id, await loadSub(env, id));
    return reply('🔕 알림을 껐습니다. 저장된 API 키도 삭제되었습니다.');
  }

  return reply('알 수 없는 명령입니다.');
}

async function routeDiscord(request: Request, env: Env, ctx: ExecutionContext, parts: string[]): Promise<Response> {
  if (!env.DISCORD_PUBLIC_KEY || !env.DISCORD_APP_ID || !env.DISCORD_BOT_TOKEN) throw new HttpError(404, 'Discord bot is not configured');

  if (parts[1] === 'interactions' && request.method === 'POST') {
    const body = await request.text();
    const ok = await verifyInteraction(
      env.DISCORD_PUBLIC_KEY,
      request.headers.get('X-Signature-Ed25519') ?? '',
      request.headers.get('X-Signature-Timestamp') ?? '',
      body,
    );
    if (!ok) return new Response('invalid request signature', { status: 401 });
    const interaction = JSON.parse(body) as Interaction;
    if (interaction.type === InteractionType.PING) return json({ type: ResponseType.PONG });
    if (interaction.type === InteractionType.APPLICATION_COMMAND) return handleCommand(env, ctx, interaction);
    return reply('지원하지 않는 요청입니다.');
  }

  // 슬래시 명령 등록. 항상 같은 명령 목록으로 덮어쓰므로 여러 번 호출해도 무해 (남용 방지로 초대 코드 요구)
  if (parts[1] === 'setup' && request.method === 'POST') {
    const code = new URL(request.url).searchParams.get('code') ?? '';
    if (env.INVITE_CODE && !safeEqual(code, env.INVITE_CODE)) throw new HttpError(403, 'Forbidden');
    const res = await registerCommands(env.DISCORD_BOT_TOKEN, env.DISCORD_APP_ID);
    return json({ ok: res.ok, status: res.status }, res.ok ? 200 : 502);
  }

  throw new HttpError(404, 'Not Found');
}

async function route(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const parts = new URL(request.url).pathname.split('/').filter(Boolean);
  if (parts[0] === 'subscriptions') return routeSubscriptions(request, env, parts);
  if (parts[0] === 'discord') return routeDiscord(request, env, ctx, parts);
  throw new HttpError(404, 'Not Found');
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const cors = corsHeaders(env, request);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    try {
      const res = await route(request, env, ctx);
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
