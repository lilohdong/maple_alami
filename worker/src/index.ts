// 메이플 할일 알리미 알림 Worker
// - HTTP /subscriptions: 앱에서 알림 구독 등록/조회/수정/삭제/테스트
// - HTTP /discord/interactions: 디스코드 봇 슬래시 명령 (/등록, /현황, /설정, /해제, /연결)
// - Cron: 리셋 전 남은 할일을 디스코드(봇 채널 멘션 또는 웹훅)로 전송

import { getCharacterBasic, getCharacterList, getCharacterState, NexonApiError } from '../../src/api/nexon';
import type { PartySizes } from '../../src/lib/progress';
import { decryptJson, encryptJson, randomToken, safeEqual, sha256 } from './crypto';
import {
  editOriginalResponse,
  EPHEMERAL,
  InteractionType,
  interactionUserId,
  modalValue,
  option,
  registerCommands,
  ResponseType,
  selectRow,
  sendChannelMessage,
  textModal,
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

/** /등록 중간 단계: API 키 입력 후 캐릭터 고르기 전까지 임시 보관 */
interface PendingRegistration {
  apiKey: string;
  channelId: string;
  guildId?: string;
}

const PENDING_TTL_SEC = 15 * 60;
const pendingKey = (userId: string) => `pending:${userId}`;

const CUSTOM_ID = { registerModal: 'register', apiKeyInput: 'api_key', pickCharacters: 'pick_characters', prefs: 'prefs' } as const;

const PREF_OPTIONS: { key: keyof Prefs; label: string; description: string }[] = [
  { key: 'weeklyBoss', label: '주간 보스', description: '수요일 18:00 · 목요일 리셋 6시간 전' },
  { key: 'weeklyContent', label: '주간 콘텐츠', description: '수요일 18:00 · 주간 보스 알림과 함께' },
  { key: 'daily', label: '일일 콘텐츠', description: '매일 22:00 · 자정 리셋 2시간 전' },
];

const reply = (content: string, ephemeral = true, components?: unknown[]) =>
  json({
    type: ResponseType.MESSAGE,
    data: { content, flags: ephemeral ? EPHEMERAL : 0, allowed_mentions: { parse: [] }, ...(components ? { components } : {}) },
  });

/** 선택 메뉴로 띄운 메시지를 결과 문구로 교체 */
const updateMessage = (content: string) => json({ type: ResponseType.UPDATE_MESSAGE, data: { content, components: [] } });

async function findUserSub(env: Env, userId: string): Promise<{ id: string; sub: Subscription } | null> {
  const id = await env.SUBS.get(userKey(userId));
  const sub = id ? await loadSub(env, id) : null;
  return id && sub ? { id, sub } : null;
}

/** 사람당 구독 하나: 새 구독을 이 사람에게 연결하고 예전 것은 해지 */
async function bindUser(env: Env, userId: string, id: string): Promise<void> {
  const previous = await env.SUBS.get(userKey(userId));
  if (previous && previous !== id) await deleteSub(env, previous, await loadSub(env, previous));
  await env.SUBS.put(userKey(userId), id);
}

/** 디스코드 썸네일용 캐릭터 이미지를 받아 저장 (응답 후 백그라운드) */
async function fillImages(env: Env, id: string): Promise<void> {
  const sub = await loadSub(env, id);
  if (!sub) return;
  const images: Record<string, string> = { ...sub.images };
  for (const [i, ocid] of sub.characters.entries()) {
    if (i > 0) await sleep(REQUEST_GAP_MS);
    try {
      images[ocid] = (await getCharacterBasic(sub.apiKey, ocid)).character_image;
    } catch {
      /* 이미지 없이 진행 */
    }
  }
  await saveSub(env, id, { ...sub, images: sanitizeImages(images, sub.characters) });
}

async function handleCommand(env: Env, ctx: ExecutionContext, i: Interaction, userId: string): Promise<Response> {
  const name = i.data?.name;

  if (name === '등록') {
    if (!i.channel_id || !i.guild_id) return reply('❌ 알림 받을 서버 채널에서 실행해주세요.');
    return json({
      type: ResponseType.MODAL,
      data: textModal(CUSTOM_ID.registerModal, '메이플 할일 알리미 등록', CUSTOM_ID.apiKeyInput, 'NEXON Open API 키', 'openapi.nexon.com에서 발급한 키를 붙여넣으세요'),
    });
  }

  if (name === '연결') {
    const code = String(option(i, '코드') ?? '').trim().toUpperCase();
    const id = code ? await env.SUBS.get(codeKey(code)) : null;
    if (!id) return reply('❌ 연결 코드가 올바르지 않거나 만료되었습니다. 앱의 🔔 알림 설정에서 새 코드를 받아주세요.');
    const sub = await loadSub(env, id);
    if (!sub) return reply('❌ 알림 등록 정보를 찾을 수 없습니다. 앱에서 알림을 다시 켜주세요.');
    if (!i.channel_id) return reply('❌ 서버 채널에서 실행해주세요.');

    await saveSub(env, id, { ...sub, webhookUrl: undefined, discord: { userId, channelId: i.channel_id, guildId: i.guild_id } });
    await bindUser(env, userId, id);
    await env.SUBS.delete(codeKey(code));
    return reply(`✅ 연결되었습니다! 이제 이 채널에서 <@${userId}>님을 멘션해 알림을 보내드려요.\n\`/현황\`으로 언제든 현재 숙제 현황을 볼 수 있습니다.`);
  }

  if (name === '현황') {
    const found = await findUserSub(env, userId);
    if (!found) return reply('아직 등록되지 않았습니다. `/등록`으로 먼저 API 키를 등록해주세요.');
    // 넥슨 API 조회가 3초를 넘길 수 있어 먼저 "생각 중" 응답 후 내용을 채움
    ctx.waitUntil(
      (async () => {
        const embeds = await buildFor(found.sub, ['status']);
        await editOriginalResponse(i.application_id, i.token, embeds ? { embeds } : { content: '조회 결과가 없습니다.' });
      })().catch((e) => console.error('status command failed', e)),
    );
    return json({ type: ResponseType.DEFERRED_MESSAGE });
  }

  if (name === '설정') {
    const found = await findUserSub(env, userId);
    if (!found) return reply('아직 등록되지 않았습니다. `/등록`으로 먼저 API 키를 등록해주세요.');
    const options = PREF_OPTIONS.map((p) => ({ label: p.label, value: p.key, description: p.description, default: found.sub.prefs[p.key] }));
    return reply('받을 알림을 골라주세요. (모두 해제하면 정기 알림이 오지 않습니다)', true, [
      selectRow(CUSTOM_ID.prefs, '받을 알림 선택', options, 0, options.length),
    ]);
  }

  if (name === '해제') {
    const found = await findUserSub(env, userId);
    if (!found) return reply('등록된 알림이 없습니다.');
    await deleteSub(env, found.id, found.sub);
    return reply('🔕 알림을 껐습니다. 저장된 API 키도 삭제되었습니다.');
  }

  return reply('알 수 없는 명령입니다.');
}

/** /등록 모달 제출: 키 확인 → 캐릭터 선택 메뉴 */
async function handleRegisterModal(env: Env, ctx: ExecutionContext, i: Interaction, userId: string): Promise<Response> {
  const apiKey = modalValue(i, CUSTOM_ID.apiKeyInput).trim();
  if (!i.channel_id) return reply('❌ 서버 채널에서 실행해주세요.');
  const channelId = i.channel_id;

  ctx.waitUntil(
    (async () => {
      let characters;
      try {
        characters = await getCharacterList(apiKey);
      } catch (e) {
        await editOriginalResponse(i.application_id, i.token, {
          content: `❌ ${e instanceof NexonApiError ? e.message : '넥슨 API 확인에 실패했습니다.'} 키를 확인하고 \`/등록\`을 다시 실행해주세요.`,
        });
        return;
      }
      if (characters.length === 0) {
        await editOriginalResponse(i.application_id, i.token, { content: '❌ 이 계정에 캐릭터가 없습니다.' });
        return;
      }
      const pending: PendingRegistration = { apiKey, channelId, guildId: i.guild_id };
      await env.SUBS.put(pendingKey(userId), await encryptJson(env.ENCRYPTION_KEY, pending), { expirationTtl: PENDING_TTL_SEC });

      characters.sort((a, b) => b.character_level - a.character_level);
      const options = characters.map((c) => ({
        label: c.character_name,
        value: c.ocid,
        description: `Lv.${c.character_level} ${c.character_class} · ${c.world_name}`,
      }));
      const note = characters.length > 25 ? '\n(레벨 높은 순 25개만 표시됩니다)' : '';
      await editOriginalResponse(i.application_id, i.token, {
        content: `✅ API 키 확인 완료! 알림 받을 캐릭터를 최대 ${MAX_CHARACTERS}개 골라주세요.${note}`,
        components: [selectRow(CUSTOM_ID.pickCharacters, '캐릭터 선택', options, 1, MAX_CHARACTERS)],
      });
    })().catch((e) => console.error('register modal failed', e)),
  );
  // 본인에게만 보이는 "생각 중" 응답
  return json({ type: ResponseType.DEFERRED_MESSAGE, data: { flags: EPHEMERAL } });
}

/** 캐릭터 선택 완료: 구독 생성 */
async function handlePickCharacters(env: Env, ctx: ExecutionContext, i: Interaction, userId: string): Promise<Response> {
  const raw = await env.SUBS.get(pendingKey(userId));
  if (!raw) return updateMessage('❌ 시간이 지나 등록이 취소되었습니다. `/등록`을 다시 실행해주세요.');
  const pending = await decryptJson<PendingRegistration>(env.ENCRYPTION_KEY, raw);
  const characters = (i.data?.values ?? []).slice(0, MAX_CHARACTERS);
  if (characters.length === 0) return updateMessage('❌ 캐릭터를 하나 이상 골라주세요. `/등록`을 다시 실행해주세요.');

  const id = randomToken(12);
  await saveSub(env, id, {
    // 웹앱 관리용 토큰은 발급하지 않음 (디스코드 명령으로 관리)
    tokenHash: await sha256(randomToken()),
    apiKey: pending.apiKey,
    discord: { userId, channelId: pending.channelId, guildId: pending.guildId },
    characters,
    party: {},
    images: {},
    prefs: { ...DEFAULT_PREFS },
    createdAt: new Date().toISOString(),
  });
  await bindUser(env, userId, id);
  await env.SUBS.delete(pendingKey(userId));
  ctx.waitUntil(fillImages(env, id).catch((e) => console.error('fill images failed', e)));

  return updateMessage(
    [
      `✅ 등록 완료! 캐릭터 ${characters.length}개의 알림을 이 채널(<#${pending.channelId}>)에서 멘션으로 보내드려요.`,
      '',
      '• 수요일 18:00 — 주간 보스·주간 콘텐츠',
      '• 매일 22:00 — 일일 콘텐츠',
      '',
      '`/현황` 지금 현황 보기 · `/설정` 알림 종류 고르기 · `/해제` 알림 끄기',
    ].join('\n'),
  );
}

async function handlePrefs(env: Env, i: Interaction, userId: string): Promise<Response> {
  const found = await findUserSub(env, userId);
  if (!found) return updateMessage('등록된 알림이 없습니다.');
  const chosen = new Set(i.data?.values ?? []);
  const prefs: Prefs = { weeklyBoss: chosen.has('weeklyBoss'), weeklyContent: chosen.has('weeklyContent'), daily: chosen.has('daily') };
  await saveSub(env, found.id, { ...found.sub, prefs });
  const on = PREF_OPTIONS.filter((p) => prefs[p.key]).map((p) => p.label);
  return updateMessage(on.length > 0 ? `✅ 저장했습니다: ${on.join(', ')}` : '✅ 저장했습니다. 정기 알림을 모두 껐습니다. (`/현황`은 계속 쓸 수 있어요)');
}

async function handleInteraction(env: Env, ctx: ExecutionContext, i: Interaction): Promise<Response> {
  const userId = interactionUserId(i);
  if (!userId) return reply('알 수 없는 사용자입니다.');
  if (!env.DISCORD_BOT_TOKEN) return reply('봇 설정이 아직 끝나지 않았습니다. 관리자에게 문의해주세요.');

  if (i.type === InteractionType.APPLICATION_COMMAND) return handleCommand(env, ctx, i, userId);
  if (i.type === InteractionType.MODAL_SUBMIT && i.data?.custom_id === CUSTOM_ID.registerModal) return handleRegisterModal(env, ctx, i, userId);
  if (i.type === InteractionType.MESSAGE_COMPONENT && i.data?.custom_id === CUSTOM_ID.pickCharacters) return handlePickCharacters(env, ctx, i, userId);
  if (i.type === InteractionType.MESSAGE_COMPONENT && i.data?.custom_id === CUSTOM_ID.prefs) return handlePrefs(env, i, userId);
  return reply('지원하지 않는 요청입니다.');
}

async function routeDiscord(request: Request, env: Env, ctx: ExecutionContext, parts: string[]): Promise<Response> {
  // 서명 검증(PING 응답 포함)은 공개키만 있으면 가능. 명령 등록과 메시지 전송에는 봇 토큰 필요
  if (!env.DISCORD_PUBLIC_KEY || !env.DISCORD_APP_ID) throw new HttpError(404, 'Discord bot is not configured');

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
    return handleInteraction(env, ctx, interaction);
  }

  // 슬래시 명령 등록. 항상 같은 명령 목록으로 덮어쓰므로 여러 번 호출해도 무해 (남용 방지로 초대 코드 요구)
  if (parts[1] === 'setup' && request.method === 'POST') {
    const code = new URL(request.url).searchParams.get('code') ?? '';
    if (env.INVITE_CODE && !safeEqual(code, env.INVITE_CODE)) throw new HttpError(403, 'Forbidden');
    if (!env.DISCORD_BOT_TOKEN) throw new HttpError(400, 'DISCORD_BOT_TOKEN is not set');
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
