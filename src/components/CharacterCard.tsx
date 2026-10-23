import type { CharacterStateResponse, CharacterSummary, SchedulerBoss, SchedulerContent } from '../api/nexon';

interface Props {
  character: CharacterSummary;
  result: { data: CharacterStateResponse } | { error: string } | undefined;
  registeredOnly: boolean;
}

function isContentDone(c: SchedulerContent): boolean {
  if (c.type === 'quest') return c.quest_state === '2';
  return c.max_count > 0 && c.now_count >= c.max_count;
}

function ContentList({ title, items }: { title: string; items: SchedulerContent[] }) {
  if (items.length === 0) return null;
  const done = items.filter(isContentDone).length;
  return (
    <div className="section">
      <h4>
        {title} <span className="muted">{done}/{items.length}</span>
      </h4>
      <ul className="items">
        {items.map((c) => (
          <li key={c.content_name} className={isContentDone(c) ? 'done' : ''}>
            <span>{c.content_name}</span>
            <span className="muted">
              {c.type === 'quest'
                ? isContentDone(c) ? '완료' : c.quest_state === '1' ? '진행 중' : '-'
                : `${c.now_count}/${c.max_count}`}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function BossList({ bosses }: { bosses: SchedulerBoss[] }) {
  if (bosses.length === 0) return null;
  const sorted = [...bosses].sort((a, b) => a.list_order_no - b.list_order_no);
  return (
    <ul className="items">
      {sorted.map((b) => (
        <li key={`${b.content_name}-${b.difficulty}`} className={b.complete_flag === 'true' ? 'done' : ''}>
          <span>
            {b.complete_flag === 'true' ? '✓ ' : ''}
            {b.content_name} <span className="muted">{b.difficulty}</span>
          </span>
          <span className="muted">{b.cycle}</span>
        </li>
      ))}
    </ul>
  );
}

export function CharacterCard({ character, result, registeredOnly }: Props) {
  const level = result && 'data' in result ? result.data.character_level : character.character_level;
  const header = (
    <div className="card-header">
      <strong>{character.character_name}</strong>
      <span className="muted">
        Lv.{level} {character.character_class} · {character.world_name}
      </span>
    </div>
  );

  if (!result) {
    return (
      <article className="card">
        {header}
        <p className="muted">불러오는 중…</p>
      </article>
    );
  }
  if ('error' in result) {
    return (
      <article className="card">
        {header}
        <p className="error">{result.error}</p>
      </article>
    );
  }

  const s = result.data;
  const keep = <T extends { registration_flag: string }>(items: T[] | null) =>
    (items ?? []).filter((i) => !registeredOnly || i.registration_flag === 'true');
  const bosses = keep(s.boss_contents);
  const daily = keep(s.daily_contents);
  const weekly = keep(s.weekly_contents);
  const bossLeft = bosses.filter((b) => b.complete_flag !== 'true').length;
  const empty = bosses.length + daily.length + weekly.length === 0;

  return (
    <article className="card">
      {header}
      <div className="section">
        <h4>
          보스 <span className="muted">주간 처치 {s.weekly_boss_clear_count}/{s.weekly_boss_clear_limit_count}</span>
          {bosses.length > 0 && (
            <span className={bossLeft === 0 ? 'badge ok' : 'badge'}>{bossLeft === 0 ? '완료' : `${bossLeft}개 남음`}</span>
          )}
        </h4>
        <BossList bosses={bosses} />
      </div>
      <ContentList title="일일" items={daily} />
      <ContentList title="주간" items={weekly} />
      {empty && (
        <p className="muted">
          {registeredOnly ? '스케줄러에 등록된 항목이 없습니다.' : '오늘 접속 기록이 없거나 데이터가 없습니다.'}
        </p>
      )}
    </article>
  );
}
