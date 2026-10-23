import { useEffect, useState } from 'react';
import { formatRemaining, nextReset, RESET_LABELS, type ResetKind } from '../lib/reset';

const KINDS: ResetKind[] = ['daily', 'weeklyBoss', 'weeklyContent', 'monthly'];
/** 이 시간 이내로 남으면 강조 표시 */
const URGENT_MS = 6 * 60 * 60 * 1000;

export function ResetTimers() {
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  return (
    <section className="timers" aria-label="리셋까지 남은 시간">
      {KINDS.map((kind) => {
        const left = nextReset(kind, now) - now;
        return (
          <div key={kind} className={left < URGENT_MS ? 'timer urgent' : 'timer'}>
            <span className="timer-label">{RESET_LABELS[kind]}</span>
            <span className="timer-value">{formatRemaining(left)}</span>
          </div>
        );
      })}
    </section>
  );
}
