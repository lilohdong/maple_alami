// 디스코드 봇: 상호작용(슬래시 명령) 서명 검증과 REST API 호출.
// 게이트웨이 연결 없이 HTTP 상호작용 엔드포인트 방식으로 동작한다.

import type { DiscordEmbed } from './notify';

const API = 'https://discord.com/api/v10';

/** 봇 초대 시 필요한 권한: 채널 보기(1024) + 메시지 보내기(2048) + 링크 첨부(16384) */
export const BOT_PERMISSIONS = 1024 + 2048 + 16384;

export const InteractionType = { PING: 1, APPLICATION_COMMAND: 2 } as const;
export const ResponseType = { PONG: 1, MESSAGE: 4, DEFERRED_MESSAGE: 5 } as const;
export const EPHEMERAL = 64;

export interface Interaction {
  type: number;
  id: string;
  token: string;
  application_id: string;
  guild_id?: string;
  channel_id?: string;
  member?: { user: { id: string } };
  user?: { id: string };
  data?: { name: string; options?: { name: string; value: string | number | boolean }[] };
}

export const interactionUserId = (i: Interaction) => i.member?.user.id ?? i.user?.id ?? '';

export const option = (i: Interaction, name: string) => i.data?.options?.find((o) => o.name === name)?.value;

/** 등록할 슬래시 명령 */
export const COMMANDS = [
  {
    name: '연결',
    description: '메이플 할일 알리미 알림을 이 채널로 받습니다',
    options: [{ type: 3, name: '코드', description: '앱의 🔔 알림 설정에 표시된 연결 코드', required: true }],
  },
  { name: '현황', description: '내 캐릭터들의 현재 숙제 현황을 보여줍니다' },
  { name: '해제', description: '디스코드 알림을 끕니다' },
];

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
export function editOriginalResponse(appId: string, interactionToken: string, payload: { content?: string; embeds?: DiscordEmbed[] }): Promise<Response> {
  return fetch(`${API}/webhooks/${appId}/${interactionToken}/messages/@original`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ allowed_mentions: { parse: [] }, ...payload }),
  });
}

export function registerCommands(token: string, appId: string): Promise<Response> {
  return fetch(`${API}/applications/${appId}/commands`, { method: 'PUT', headers: botHeaders(token), body: JSON.stringify(COMMANDS) });
}
