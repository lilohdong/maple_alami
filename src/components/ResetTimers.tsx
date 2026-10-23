import { useEffect, useState } from 'react';
import { formatRemaining, nextReset, RESET_LABELS, type ResetKind } from '../lib/reset';

const KINDS: ResetKind[] = ['daily', 'weeklyBoss', 'weeklyContent', 'monthly'];

export function ResetTimers() {
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  return (
    <section className="timers">
      {KINDS.map((kind) => (
        <div key={kind} className="timer">
          <span className="timer-label">{RESET_LABELS[kind]}</span>
          <span className="timer-value">{formatRemaining(nextReset(kind, now) - now)}</span>
        </div>
      ))}
    </section>
  );
}
