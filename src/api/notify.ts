// 디스코드 알림 Worker 클라이언트 (worker/src/index.ts)

import type { PartySizes } from '../lib/progress';

export const NOTIFY_API = import.meta.env.VITE_NOTIFY_API as string | undefined;
/** 설정되어 있으면 디스코드 봇으로 연결 (없으면 웹훅 방식) */
export const DISCORD_APP_ID = import.meta.env.VITE_DISCORD_APP_ID as string | undefined;

/** 봇 초대 링크: 채널 보기 + 메시지 보내기 + 링크 첨부 권한 */
export const BOT_INVITE_URL = DISCORD_APP_ID
  ? `https://discord.com/oauth2/authorize?client_id=${DISCORD_APP_ID}&scope=bot+applications.commands&permissions=19456`
  : undefined;

export interface NotifyPrefs {
  weeklyBoss: boolean;
  weeklyContent: boolean;
  daily: boolean;
}

export const DEFAULT_NOTIFY_PREFS: NotifyPrefs = { weeklyBoss: true, weeklyContent: true, daily: true };

export interface SubscriptionPayload {
  inviteCode?: string;
  apiKey: string;
  /** 없으면 봇 연결 코드 발급 */
  webhookUrl?: string;
  characters: string[];
  party: Record<string, PartySizes>;
  /** 디스코드 메시지 썸네일용 캐릭터 외형 이미지 */
  images: Record<string, string>;
  prefs: NotifyPrefs;
}

export interface Subscription {
  id: string;
  token: string;
}

export type Destination = 'discord' | 'webhook' | null;

async function call<T>(method: string, path: string, body?: unknown, token?: string): Promise<T> {
  if (!NOTIFY_API) throw new Error('알림 서버가 설정되지 않았습니다.');
  let res: Response;
  try {
    res = await fetch(`${NOTIFY_API}${path}`, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error('알림 서버에 연결할 수 없습니다.');
  }
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new NotifyApiError(data.error ?? `요청 실패 (${res.status})`, res.status);
  return data;
}

export class NotifyApiError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
  }
}

export const subscribe = (payload: SubscriptionPayload) =>
  call<Subscription & { linkCode?: string }>('POST', '/subscriptions', payload);

export const getSubscription = (sub: Subscription) =>
  call<{ destination: Destination; prefs: NotifyPrefs }>('GET', `/subscriptions/${sub.id}`, undefined, sub.token);

export const updateSubscription = (sub: Subscription, payload: SubscriptionPayload) =>
  call<{ ok: true }>('PUT', `/subscriptions/${sub.id}`, payload, sub.token);

export const unsubscribe = (sub: Subscription) => call<{ ok: true }>('DELETE', `/subscriptions/${sub.id}`, undefined, sub.token);

export const newLinkCode = (sub: Subscription) => call<{ linkCode: string }>('POST', `/subscriptions/${sub.id}/link-code`, undefined, sub.token);

export const sendTest = (sub: Subscription) => call<{ ok: true }>('POST', `/subscriptions/${sub.id}/test`, undefined, sub.token);
