import { useState } from 'react';
import type { CharacterStateResponse, CharacterSummary, SchedulerBoss, SchedulerContent } from '../api/nexon';
import { bossKey, formatMeso } from '../data/crystals';
import {
  bossShare,
  CYCLE_LABELS,
  isBossDone,
  isContentDone,
  normalizeCycle,
  tally,
  visibleItems,
  weeklyIncome,
  type BossCycle,
  type PartySizes,
  type Tally,
} from '../lib/progress';

interface Props {
  character: CharacterSummary;
  result: { data: CharacterStateResponse } | { error: string } | undefined;
  registeredOnly: boolean;
  party: PartySizes | undefined;
  onPartyChange: (key: string, size: number) => void;
}

type Tab = 'bosses' | 'daily' | 'weekly';
const TAB_LABELS: Record<Tab, string> = { bosses: '보스', daily: '일일', weekly: '주간' };

const DIFFICULTY_CLASS: Record<string, string> = {
  이지: 'easy',
  노멀: 'normal',
  노말: 'normal',
  하드: 'hard',
  카오스: 'chaos',
  익스트림: 'extreme',
};

const PARTY_SIZES = [1, 2, 3, 4, 5, 6];

function CheckIcon({ done }: { done: boolean }) {
  return (
    <span className={done ? 'check done' : 'check'} aria-label={done ? '완료' : '미완료'}>
      {done && (
        <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
          <path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )}
    </span>
  );
}

function Avatar({ character }: { character: CharacterSummary }) {
  const [failed, setFailed] = useState(false);
  return (
    <div className="avatar">
      {character.character_image && !failed ? (
        <img src={character.character_image} alt="" loading="lazy" onError={() => setFailed(true)} />
      ) : (
        <svg viewBox="0 0 40 40" width="34" height="34" aria-hidden="true" className="avatar-fallback">
          <circle cx="20" cy="14" r="7" />
          <path d="M6 36c1.5-8 7-12 14-12s12.5 4 14 12z" />
        </svg>
      )}
    </div>
  );
}

function Ring({ value, max }: { value: number; max: number }) {
  const r = 22;
  const c = 2 * Math.PI * r;
  const ratio = max > 0 ? Math.min(1, value / max) : 0;
  return (
    <div className={ratio >= 1 ? 'ring full' : 'ring'} title="주간 보스 처치 횟수">
      <svg viewBox="0 0 56 56" width="56" height="56" aria-hidden="true">
        <circle cx="28" cy="28" r={r} className="ring-track" />
        <circle
          cx="28"
          cy="28"
          r={r}
          className="ring-bar"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - ratio)}
          transform="rotate(-90 28 28)"
        />
      </svg>
      <div className="ring-text">
        <strong>{value}</strong>
        <span>/{max}</span>
      </div>
    </div>
  );
}

function IncomeStrip({ data, party }: { data: CharacterStateResponse; party: PartySizes | undefined }) {
  const income = weeklyIncome(data, party);
  if (income.expected === 0 && income.earned === 0) return null;
  const ratio = income.expected > 0 ? Math.min(1, income.earned / income.expected) : 0;
  return (
    <div className="income">
      <div className="income-head">
        <span className="income-label">주간 결정석</span>
        <span className="income-value">
          <strong>{formatMeso(income.earned)}</strong>
          <span> / {formatMeso(income.expected)}</span>
        </span>
      </div>
      <div className="bar">
        <span className={ratio >= 1 ? 'full' : ''} style={{ width: `${ratio * 100}%` }} />
      </div>
      {income.unknown > 0 && <p className="income-note">가격 정보가 없는 보스 {income.unknown}개는 제외됨</p>}
    </div>
  );
}

function PartySelect({ boss, party, onChange }: { boss: SchedulerBoss; party: PartySizes | undefined; onChange: Props['onPartyChange'] }) {
  const key = bossKey(boss.content_name, boss.difficulty);
  const size = party?.[key] ?? 1;
  return (
    <select
      className={size > 1 ? 'party multi' : 'party'}
      value={size}
      onChange={(e) => onChange(key, Number(e.target.value))}
      aria-label={`${boss.content_name} 파티 인원`}
    >
      {PARTY_SIZES.map((n) => (
        <option key={n} value={n}>
          {n}인
        </option>
      ))}
    </select>
  );
}

function BossRows({ bosses, party, onPartyChange }: { bosses: SchedulerBoss[]; party: PartySizes | undefined; onPartyChange: Props['onPartyChange'] }) {
  const groups = new Map<BossCycle, SchedulerBoss[]>();
  for (const b of bosses) {
    const cycle = normalizeCycle(b.cycle);
    groups.set(cycle, [...(groups.get(cycle) ?? []), b]);
  }
  const order: BossCycle[] = ['weekly', 'monthly', 'daily'];
  const showHeaders = groups.size > 1;

  return (
    <>
      {order
        .filter((cycle) => groups.has(cycle))
        .map((cycle) => (
          <div key={cycle} className="group">
            {showHeaders && <div className="group-label">{CYCLE_LABELS[cycle]}</div>}
            <ul className="rows">
              {groups.get(cycle)!.map((b) => {
                const share = cycle === 'daily' ? null : bossShare(b, party);
                return (
                  <li key={`${b.content_name}-${b.difficulty}`} className={isBossDone(b) ? 'row done' : 'row'}>
                    <CheckIcon done={isBossDone(b)} />
                    <span className={`diff ${DIFFICULTY_CLASS[b.difficulty] ?? ''}`}>{b.difficulty}</span>
                    <span className="row-name">{b.content_name}</span>
                    {share !== null && (
                      <>
                        <PartySelect boss={b} party={party} onChange={onPartyChange} />
                        <span className="price">{formatMeso(share)}</span>
                      </>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
    </>
  );
}

function ContentRows({ items }: { items: SchedulerContent[] }) {
  return (
    <ul className="rows">
      {items.map((c) => {
        const done = isContentDone(c);
        return (
          <li key={c.content_name} className={done ? 'row done' : 'row'}>
            <CheckIcon done={done} />
            <span className="row-name">{c.content_name}</span>
            {c.type === 'quest' ? (
              c.quest_state === '1' && !done && <span className="pill">진행 중</span>
            ) : (
              <span className="count">
                {c.max_count > 1 && (
                  <span className="minibar">
                    <span style={{ width: `${Math.min(100, (c.now_count / c.max_count) * 100)}%` }} />
                  </span>
                )}
                {c.now_count}/{c.max_count}
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function TabButton({ tab, active, t, onClick }: { tab: Tab; active: boolean; t: Tally; onClick: () => void }) {
  const left = t.total - t.done;
  return (
    <button role="tab" aria-selected={active} className={active ? 'tab active' : 'tab'} onClick={onClick}>
      {TAB_LABELS[tab]}
      {t.total > 0 && <span className={left === 0 ? 'tab-badge ok' : 'tab-badge'}>{left === 0 ? '✓' : left}</span>}
    </button>
  );
}

export function CharacterCard({ character, result, registeredOnly, party, onPartyChange }: Props) {
  const [tab, setTab] = useState<Tab>('bosses');
  const data = result && 'data' in result ? result.data : null;
  const level = data?.character_level ?? character.character_level;

  const header = (
    <header className="card-head">
      <Avatar character={character} />
      <div className="card-title">
        <strong>{character.character_name}</strong>
        <span>
          Lv.{level} · {character.character_class}
        </span>
        <span className="world">{character.world_name}</span>
      </div>
      {data && <Ring value={data.weekly_boss_clear_count} max={data.weekly_boss_clear_limit_count} />}
    </header>
  );

  if (!data) {
    return (
      <article className="card">
        {header}
        {result && 'error' in result ? (
          <p className="card-msg error">{result.error}</p>
        ) : (
          <div className="skeleton" aria-label="불러오는 중" />
        )}
      </article>
    );
  }

  const v = visibleItems(data, registeredOnly);
  const t = tally(v);
  const tabs: Tab[] = ['bosses', 'daily', 'weekly'];

  return (
    <article className="card">
      {header}
      <IncomeStrip data={data} party={party} />
      <div className="tabs" role="tablist">
        {tabs.map((k) => (
          <TabButton key={k} tab={k} t={t[k]} active={tab === k} onClick={() => setTab(k)} />
        ))}
      </div>
      <div className="tab-body">
        {v[tab].length === 0 ? (
          <p className="card-msg">
            {registeredOnly ? '인게임 스케줄러에 등록된 항목이 없습니다.' : '오늘 접속 기록이 없거나 데이터가 없습니다.'}
          </p>
        ) : tab === 'bosses' ? (
          <BossRows bosses={v.bosses} party={party} onPartyChange={onPartyChange} />
        ) : (
          <ContentRows items={v[tab]} />
        )}
      </div>
    </article>
  );
}
