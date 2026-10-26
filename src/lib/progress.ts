// 스케줄러 응답을 화면 표시용으로 가공하는 함수들.

import type { CharacterStateResponse, SchedulerBoss, SchedulerContent } from '../api/nexon';
import { bossKey, crystalPrice, DEFAULT_WEEKLY_CRYSTAL_LIMIT } from '../data/crystals';

/** 보스별 파티 인원. key는 bossKey(), 없으면 1인 */
export type PartySizes = Record<string, number>;

export function isContentDone(c: SchedulerContent): boolean {
  if (c.type === 'quest') return c.quest_state === '2';
  return c.max_count > 0 && c.now_count >= c.max_count;
}

export const isBossDone = (b: SchedulerBoss) => b.complete_flag === 'true';

export type BossCycle = 'daily' | 'weekly' | 'monthly';

export const CYCLE_LABELS: Record<BossCycle, string> = { daily: '일간', weekly: '주간', monthly: '월간' };

/** API의 cycle 문자열 형식이 문서화되어 있지 않아 한/영 표기를 모두 수용 */
export function normalizeCycle(cycle: string): BossCycle {
  const c = cycle.toLowerCase();
  if (c.includes('일') || c.includes('day') || c.includes('daily')) return 'daily';
  if (c.includes('월') || c.includes('month')) return 'monthly';
  return 'weekly';
}

export interface Visible {
  bosses: SchedulerBoss[];
  daily: SchedulerContent[];
  weekly: SchedulerContent[];
}

export function visibleItems(s: CharacterStateResponse, registeredOnly: boolean): Visible {
  const keep = <T extends { registration_flag: string }>(items: T[] | null) =>
    (items ?? []).filter((i) => !registeredOnly || i.registration_flag === 'true');
  // 남은 할일이 위로 오도록 미완료 항목을 먼저 (같은 상태끼리는 원래 순서 유지)
  const doneLast = <T,>(items: T[], done: (i: T) => boolean) =>
    [...items].sort((a, b) => Number(done(a)) - Number(done(b)));
  return {
    bosses: doneLast(
      keep(s.boss_contents).sort((a, b) => a.list_order_no - b.list_order_no),
      isBossDone,
    ),
    daily: doneLast(keep(s.daily_contents), isContentDone),
    weekly: doneLast(keep(s.weekly_contents), isContentDone),
  };
}

/** 파티 인원 반영한 1인 몫 결정석 가격 */
export function bossShare(b: SchedulerBoss, party: PartySizes | undefined): number | null {
  const price = crystalPrice(b.content_name, b.difficulty);
  if (price === null) return null;
  return Math.floor(price / (party?.[bossKey(b.content_name, b.difficulty)] ?? 1));
}

export interface Income {
  /** 이번 주 처치한 주간 보스 결정석 합 */
  earned: number;
  /** 남은 처치 횟수 안에서 더 벌 수 있는 결정석 (등록했지만 아직 안 잡은 보스 중 비싼 순) */
  remaining: number;
  /** earned + remaining */
  expected: number;
  /** 남은 처치 횟수 (주간 처치 제한 - 이번 주 처치 수) */
  slots: number;
  /** 등록했지만 남은 처치 횟수 밖이라 수익에 안 들어가는 보스 (bossKey) */
  overLimit: Set<string>;
  /** 가격표에 없는 보스 수 (합계에서 제외됨) */
  unknown: number;
}

/**
 * 주간 보스 결정석 수익.
 * 주간 보스는 캐릭터당 limit(12)번까지만 잡을/팔 수 있고, 이미 잡은 보스도 그 횟수를 차지한다.
 * 그래서 남은 수익 = 아직 안 잡은 등록 보스 중 비싼 순으로 (limit - 이번 주 처치 수)개.
 * 일간/월간 보스는 주간 제한과 별개라 제외.
 */
export function weeklyIncome(s: CharacterStateResponse, party: PartySizes | undefined): Income {
  const limit = s.weekly_boss_clear_limit_count || DEFAULT_WEEKLY_CRYSTAL_LIMIT;
  const weekly = (s.boss_contents ?? []).filter((b) => normalizeCycle(b.cycle) === 'weekly');
  let unknown = 0;
  const valued = weekly.flatMap((b) => {
    const v = bossShare(b, party);
    if (v === null) {
      if (b.registration_flag === 'true') unknown++;
      return [];
    }
    return [{ b, v }];
  });
  const byValue = (items: typeof valued) => [...items].sort((a, b) => b.v - a.v);
  const sum = (items: typeof valued) => items.reduce((n, i) => n + i.v, 0);

  const done = byValue(valued.filter((i) => isBossDone(i.b)));
  const earned = sum(done.slice(0, limit));
  const cleared = Math.max(s.weekly_boss_clear_count ?? 0, done.length);
  const slots = Math.max(0, limit - cleared);

  const left = byValue(valued.filter((i) => i.b.registration_flag === 'true' && !isBossDone(i.b)));
  const remaining = sum(left.slice(0, slots));
  return {
    earned,
    remaining,
    expected: earned + remaining,
    slots,
    overLimit: new Set(left.slice(slots).map((i) => bossKey(i.b.content_name, i.b.difficulty))),
    unknown,
  };
}

export interface Tally {
  done: number;
  total: number;
}

export function tally(v: Visible): Record<keyof Visible, Tally> {
  const count = <T,>(items: T[], done: (i: T) => boolean): Tally => ({
    done: items.filter(done).length,
    total: items.length,
  });
  return {
    bosses: count(v.bosses, isBossDone),
    daily: count(v.daily, isContentDone),
    weekly: count(v.weekly, isContentDone),
  };
}
