// 메이플스토리 리셋 시각 계산. 모든 리셋은 한국 시간(KST, UTC+9) 00:00 기준.

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export type ResetKind = 'daily' | 'weeklyBoss' | 'weeklyContent' | 'monthly';

export const RESET_LABELS: Record<ResetKind, string> = {
  daily: '일일 리셋',
  weeklyBoss: '주간 보스 (목)',
  weeklyContent: '주간 콘텐츠 (월)',
  monthly: '월간 보스',
};

/** KST 기준 다음 00:00 (now 이후, now 자체는 제외) */
function nextKstMidnight(now: number): number {
  const kst = now + KST_OFFSET_MS;
  return Math.floor(kst / DAY_MS) * DAY_MS + DAY_MS - KST_OFFSET_MS;
}

/** KST 기준 다음 특정 요일 00:00. weekday: 0=일 ... 4=목 */
function nextKstWeekday(now: number, weekday: number): number {
  let t = nextKstMidnight(now);
  while (new Date(t + KST_OFFSET_MS).getUTCDay() !== weekday) t += DAY_MS;
  return t;
}

/** KST 기준 다음 달 1일 00:00 */
function nextKstMonthStart(now: number): number {
  const kst = new Date(now + KST_OFFSET_MS);
  return Date.UTC(kst.getUTCFullYear(), kst.getUTCMonth() + 1, 1) - KST_OFFSET_MS;
}

export function nextReset(kind: ResetKind, now = Date.now()): number {
  switch (kind) {
    case 'daily':
      return nextKstMidnight(now);
    case 'weeklyBoss':
      return nextKstWeekday(now, 4);
    case 'weeklyContent':
      return nextKstWeekday(now, 1);
    case 'monthly':
      return nextKstMonthStart(now);
  }
}

export function formatRemaining(ms: number): string {
  const totalMin = Math.max(0, Math.floor(ms / 60000));
  const d = Math.floor(totalMin / 1440);
  const h = Math.floor((totalMin % 1440) / 60);
  const m = totalMin % 60;
  if (d > 0) return `${d}일 ${h}시간`;
  if (h > 0) return `${h}시간 ${m}분`;
  return `${m}분`;
}
