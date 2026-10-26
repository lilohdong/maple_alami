// 스케줄러 상태로 디스코드 알림 메시지를 만든다.

import type { CharacterStateResponse } from '../../src/api/nexon';
import { formatMeso, normalizeDifficulty } from '../../src/data/crystals';
import { isBossDone, isContentDone, normalizeCycle, weeklyIncome, type PartySizes } from '../../src/lib/progress';

export type NotifyKind = 'weeklyBoss' | 'weeklyContent' | 'daily' | 'status';

export interface Prefs {
  weeklyBoss: boolean;
  weeklyContent: boolean;
  daily: boolean;
}

export const DEFAULT_PREFS: Prefs = { weeklyBoss: true, weeklyContent: true, daily: true };

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** 크론 실행 시각(KST)에 보낼 알림 종류 */
export function dueKinds(scheduledTime: number): NotifyKind[] {
  const kst = new Date(scheduledTime + KST_OFFSET_MS);
  const hour = kst.getUTCHours();
  const day = kst.getUTCDay();
  const kinds: NotifyKind[] = [];
  if (hour === 18 && day === 3) kinds.push('weeklyBoss'); // 수 18시 → 목 00시 리셋 6시간 전
  if (hour === 18 && day === 0) kinds.push('weeklyContent'); // 일 18시 → 월 00시 리셋 6시간 전
  if (hour === 22) kinds.push('daily'); // 매일 22시 → 자정 리셋 2시간 전
  return kinds;
}

export interface CharacterReport {
  ocid: string;
  state: CharacterStateResponse | null;
  error?: string;
}

interface EmbedField {
  name: string;
  value: string;
  inline?: boolean;
}

export interface DiscordEmbed {
  title: string;
  description?: string;
  color: number;
  fields: EmbedField[];
  footer?: { text: string };
  timestamp?: string;
}

const COLOR_ORANGE = 0xf28c28;
const COLOR_GREEN = 0x3ccf8e;

const TITLES: Record<NotifyKind, string> = {
  weeklyBoss: '⚔️ 주간 보스 리셋 6시간 전',
  weeklyContent: '📅 주간 콘텐츠 리셋 6시간 전',
  daily: '🌙 일일 리셋 2시간 전',
  status: '📋 현재 진행 현황',
};

const registered = <T extends { registration_flag: string }>(items: T[] | null | undefined) =>
  (items ?? []).filter((i) => i.registration_flag === 'true');

function hasData(s: CharacterStateResponse): boolean {
  return (s.boss_contents?.length ?? 0) + (s.daily_contents?.length ?? 0) + (s.weekly_contents?.length ?? 0) > 0;
}

function bossLines(s: CharacterStateResponse, party: PartySizes | undefined): string[] {
  if (s.weekly_boss_clear_count >= s.weekly_boss_clear_limit_count && s.weekly_boss_clear_limit_count > 0) return [];
  const left = registered(s.boss_contents).filter((b) => normalizeCycle(b.cycle) === 'weekly' && !isBossDone(b));
  if (left.length === 0) return [];
  const income = weeklyIncome(s, party);
  return [
    `**보스** ${s.weekly_boss_clear_count}/${s.weekly_boss_clear_limit_count} · 남은 결정석 ${formatMeso(income.expected - income.earned)}`,
    left.map((b) => `${normalizeDifficulty(b.difficulty)} ${b.content_name}`).join(', '),
  ];
}

function contentLines(label: string, items: CharacterStateResponse['daily_contents']): string[] {
  const left = registered(items).filter((c) => !isContentDone(c));
  if (left.length === 0) return [];
  return [`**${label}** ${left.length}개 남음`, left.map((c) => c.content_name).join(', ')];
}

function linesFor(kind: NotifyKind, s: CharacterStateResponse, party: PartySizes | undefined): string[] {
  switch (kind) {
    case 'weeklyBoss':
      return bossLines(s, party);
    case 'weeklyContent':
      return contentLines('주간', s.weekly_contents);
    case 'daily':
      return hasData(s) ? contentLines('일일', s.daily_contents) : ['오늘 접속 기록 없음'];
    case 'status':
      return [...bossLines(s, party), ...contentLines('일일', s.daily_contents), ...contentLines('주간', s.weekly_contents)];
  }
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** 남은 할일이 없으면 null (status는 항상 메시지 생성) */
export function buildEmbed(
  kind: NotifyKind,
  reports: CharacterReport[],
  party: Record<string, PartySizes>,
  now = Date.now(),
): DiscordEmbed | null {
  const fields: EmbedField[] = [];
  for (const r of reports) {
    if (!r.state) {
      if (r.error) fields.push({ name: '⚠️ 조회 실패', value: clip(r.error, 1024) });
      continue;
    }
    const lines = linesFor(kind, r.state, party[r.ocid]);
    if (lines.length === 0) continue;
    fields.push({
      name: clip(`${r.state.character_name} · Lv.${r.state.character_level}`, 256),
      value: clip(lines.join('\n'), 1024),
    });
  }

  if (fields.length === 0) {
    if (kind !== 'status') return null;
    return { title: TITLES.status, description: '🎉 남은 할일이 없습니다!', color: COLOR_GREEN, fields: [], footer: { text: '메이플 할일 알리미' }, timestamp: new Date(now).toISOString() };
  }
  return {
    title: TITLES[kind],
    color: COLOR_ORANGE,
    fields: fields.slice(0, 25),
    footer: { text: '메이플 할일 알리미' },
    timestamp: new Date(now).toISOString(),
  };
}
