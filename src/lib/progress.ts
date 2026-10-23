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
  /** 스케줄러에 등록한 주간 보스를 모두 잡았을 때 */
  expected: number;
  /** 가격표에 없는 보스 수 (합계에서 제외됨) */
  unknown: number;
}

/**
 * 주간 보스 결정석 수익. 캐릭터당 판매 제한(limit)이 있어 가치가 높은 순으로 limit 개까지만 합산.
 * 일간/월간 보스는 주간 판매 제한과 별개라 제외.
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
  const topSum = (items: typeof valued) =>
    items
      .map((i) => i.v)
      .sort((a, b) => b - a)
      .slice(0, limit)
      .reduce((a, b) => a + b, 0);
  return {
    earned: topSum(valued.filter((i) => isBossDone(i.b))),
    // 등록 안 했어도 이미 잡은 보스는 수익에 포함
    expected: topSum(valued.filter((i) => i.b.registration_flag === 'true' || isBossDone(i.b))),
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
