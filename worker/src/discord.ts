// 디스코드 봇: 상호작용(슬래시 명령) 서명 검증과 REST API 호출.
// 게이트웨이 연결 없이 HTTP 상호작용 엔드포인트 방식으로 동작한다.

import type { DiscordEmbed } from './notify';

const API = 'https://discord.com/api/v10';

/** 봇 초대 시 필요한 권한: 채널 보기(1024) + 메시지 보내기(2048) + 링크 첨부(16384) */
export const BOT_PERMISSIONS = 1024 + 2048 + 16384;

export const InteractionType = { PING: 1, APPLICATION_COMMAND: 2, MESSAGE_COMPONENT: 3, MODAL_SUBMIT: 5 } as const;
export const ResponseType = { PONG: 1, MESSAGE: 4, DEFERRED_MESSAGE: 5, DEFERRED_UPDATE: 6, UPDATE_MESSAGE: 7, MODAL: 9 } as const;
export const EPHEMERAL = 64;

interface ComponentData {
  type: number;
  custom_id?: string;
  value?: string;
  components?: ComponentData[];
}

export interface Interaction {
  type: number;
  id: string;
  token: string;
  application_id: string;
  guild_id?: string;
  channel_id?: string;
  member?: { user: { id: string } };
  user?: { id: string };
  data?: {
    /** 슬래시 명령 */
    name?: string;
    options?: { name: string; value: string | number | boolean }[];
    /** 버튼/선택 메뉴/모달 */
    custom_id?: string;
    values?: string[];
    components?: ComponentData[];
  };
}

export const interactionUserId = (i: Interaction) => i.member?.user.id ?? i.user?.id ?? '';

export const option = (i: Interaction, name: string) => i.data?.options?.find((o) => o.name === name)?.value;

/** 모달 제출 값 */
export function modalValue(i: Interaction, customId: string): string {
  for (const row of i.data?.components ?? []) {
    for (const c of row.components ?? []) if (c.custom_id === customId) return c.value ?? '';
  }
  return '';
}

/** 등록할 슬래시 명령 */
export const COMMANDS = [
  { name: '등록', description: 'API 키로 메이플 할일 알림을 등록합니다 (이 채널로 알림)' },
  { name: '현황', description: '내 캐릭터들의 현재 숙제 현황을 보여줍니다' },
  { name: '설정', description: '받을 알림 종류를 고릅니다' },
  { name: '파티', description: '보스별 파티 인원을 설정합니다 (결정석을 인원수로 나눠 계산)' },
  { name: '해제', description: '디스코드 알림을 끄고 저장된 API 키를 삭제합니다' },
  {
    name: '연결',
    description: '웹앱에서 받은 연결 코드로 알림을 이 채널에 연결합니다',
    options: [{ type: 3, name: '코드', description: '앱의 🔔 알림 설정에 표시된 연결 코드', required: true }],
  },
];

// ---------- 메시지 구성 요소 ----------

export interface SelectOption {
  label: string;
  value: string;
  description?: string;
  default?: boolean;
}

/** 선택 메뉴 한 줄 (디스코드 제한: 옵션 25개, 라벨/설명 100자) */
export function selectRow(customId: string, placeholder: string, options: SelectOption[], min: number, max: number) {
  const clip = (s: string) => (s.length > 100 ? `${s.slice(0, 99)}…` : s);
  const opts = options.slice(0, 25).map((o) => ({ ...o, label: clip(o.label), description: o.description && clip(o.description) }));
  return {
    type: 1,
    components: [{ type: 3, custom_id: customId, placeholder, min_values: min, max_values: Math.min(max, opts.length), options: opts }],
  };
}

/** 회색 버튼 한 줄 */
export function buttonRow(buttons: { customId: string; label: string }[]) {
  return { type: 1, components: buttons.map((b) => ({ type: 2, style: 2, custom_id: b.customId, label: b.label })) };
}

/** 텍스트 한 칸짜리 모달 */
export function textModal(customId: string, title: string, inputId: string, label: string, placeholder: string) {
  return {
    custom_id: customId,
    title,
    components: [{ type: 1, components: [{ type: 4, custom_id: inputId, label, placeholder, style: 1, required: true, min_length: 10, max_length: 200 }] }],
  };
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

let cachedKey: { hex: string; key: CryptoKey } | null = null;

/** 디스코드가 보낸 요청인지 Ed25519 서명으로 확인 */
export async function verifyInteraction(publicKeyHex: string, signature: string, timestamp: string, body: string): Promise<boolean> {
  if (!signature || !timestamp || !/^[0-9a-f]+$/i.test(signature)) return false;
  if (cachedKey?.hex !== publicKeyHex) {
    cachedKey = {
      hex: publicKeyHex,
      key: await crypto.subtle.importKey('raw', hexToBytes(publicKeyHex), { name: 'Ed25519' }, false, ['verify']),
    };
  }
  return crypto.subtle.verify('Ed25519', cachedKey.key, hexToBytes(signature), new TextEncoder().encode(timestamp + body));
}

function botHeaders(token: string): Record<string, string> {
  return { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' };
}

/** 채널에 사용자 멘션과 함께 전송 (멘션해야 폰 푸시 알림이 울림) */
export function sendChannelMessage(token: string, channelId: string, userId: string, embeds: DiscordEmbed[]): Promise<Response> {
  return fetch(`${API}/channels/${channelId}/messages`, {
    method: 'POST',
    headers: botHeaders(token),
    body: JSON.stringify({ content: `<@${userId}>`, embeds, allowed_mentions: { users: [userId] } }),
  });
}

/** 지연 응답(DEFERRED_MESSAGE) 이후 실제 내용 채우기 */
export function editOriginalResponse(
  appId: string,
  interactionToken: string,
  payload: { content?: string; embeds?: DiscordEmbed[]; components?: unknown[] },
): Promise<Response> {
  return fetch(`${API}/webhooks/${appId}/${interactionToken}/messages/@original`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ allowed_mentions: { parse: [] }, ...payload }),
  });
}

export function listCommands(token: string, appId: string, guildId?: string): Promise<Response> {
  const path = guildId ? `/applications/${appId}/guilds/${guildId}/commands` : `/applications/${appId}/commands`;
  return fetch(`${API}${path}`, { headers: botHeaders(token) });
}

export function registerCommands(token: string, appId: string): Promise<Response> {
  return fetch(`${API}/applications/${appId}/commands`, { method: 'PUT', headers: botHeaders(token), body: JSON.stringify(COMMANDS) });
}
