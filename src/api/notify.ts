// 디스코드 알림 Worker 클라이언트 (worker/src/index.ts)

import type { PartySizes } from '../lib/progress';

export const NOTIFY_API = import.meta.env.VITE_NOTIFY_API as string | undefined;

export interface NotifyPrefs {
  weeklyBoss: boolean;
  weeklyContent: boolean;
  daily: boolean;
}

export const DEFAULT_NOTIFY_PREFS: NotifyPrefs = { weeklyBoss: true, weeklyContent: true, daily: true };

export interface SubscriptionPayload {
  inviteCode?: string;
  apiKey: string;
  webhookUrl: string;
  characters: string[];
  party: Record<string, PartySizes>;
  prefs: NotifyPrefs;
}

export interface Subscription {
  id: string;
  token: string;
}

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
  if (!res.ok) throw new Error(data.error ?? `요청 실패 (${res.status})`);
  return data;
}

export const subscribe = (payload: SubscriptionPayload) => call<Subscription>('POST', '/subscriptions', payload);

export const updateSubscription = (sub: Subscription, payload: SubscriptionPayload) =>
  call<{ ok: true }>('PUT', `/subscriptions/${sub.id}`, payload, sub.token);

export const unsubscribe = (sub: Subscription) => call<{ ok: true }>('DELETE', `/subscriptions/${sub.id}`, undefined, sub.token);

export const sendTest = (sub: Subscription) => call<{ ok: true }>('POST', `/subscriptions/${sub.id}/test`, undefined, sub.token);
