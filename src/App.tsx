import { useCallback, useEffect, useRef, useState } from 'react';
import { getCharacterBasic, getCharacterState, NexonApiError, type CharacterStateResponse } from './api/nexon';
import { DEMO_CHARACTERS, DEMO_PARTY, getDemoState } from './api/demo';
import { CRYSTAL_PRICE_AS_OF, formatMeso } from './data/crystals';
import { loadSettings, saveSettings, type Settings } from './lib/storage';
import { tally, visibleItems, weeklyIncome } from './lib/progress';
import { ResetTimers } from './components/ResetTimers';
import { SettingsPanel } from './components/SettingsPanel';
import { CharacterCard } from './components/CharacterCard';
import { buildPayload, NotifyPanel } from './components/NotifyPanel';
import { NOTIFY_API, updateSubscription } from './api/notify';

/** 화면이 보이는 동안 자동 새로고침 주기 */
const AUTO_REFRESH_MS = 5 * 60 * 1000;
/** 개발용 키의 초당 호출 제한을 피하기 위한 요청 간 간격 */
const REQUEST_GAP_MS = 250;

const DEMO = new URLSearchParams(location.search).has('demo');

type StateResult = { data: CharacterStateResponse } | { error: string };
type Panel = 'settings' | 'notify';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function initialSettings(): Settings {
  const s = loadSettings();
  return DEMO ? { ...s, apiKey: 'demo', tracked: DEMO_CHARACTERS, party: DEMO_PARTY } : s;
}

export default function App() {
  const [settings, setSettings] = useState<Settings>(initialSettings);
  // ?panel=notify 처럼 링크로 패널을 바로 열 수 있음
  const [panel, setPanel] = useState<Panel | null>(() => {
    const requested = new URLSearchParams(location.search).get('panel');
    if (requested === 'settings' || requested === 'notify') return requested;
    return initialSettings().apiKey ? null : 'settings';
  });
  const togglePanel = (p: Panel) => setPanel((cur) => (cur === p ? null : p));
  const [states, setStates] = useState<Record<string, StateResult>>({});
  const [loading, setLoading] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  // 외형 이미지는 코디 변경을 반영하도록 앱을 열 때마다 한 번 갱신
  const basicsFetchedFor = useRef('');

  const updateSettings = useCallback((update: (prev: Settings) => Settings) => {
    setSettings((prev) => {
      const next = update(prev);
      if (!DEMO) saveSettings(next);
      return next;
    });
  }, []);

  const { apiKey, tracked } = settings;
  const trackedIds = tracked.map((c) => c.ocid).join(',');

  const refresh = useCallback(async () => {
    if (!apiKey || tracked.length === 0) return;
    setLoading(true);
    for (const [i, c] of tracked.entries()) {
      if (i > 0) await sleep(REQUEST_GAP_MS);
      let result: StateResult;
      try {
        result = { data: DEMO ? await getDemoState(c.ocid) : await getCharacterState(apiKey, c.ocid) };
      } catch (e) {
        result = { error: e instanceof NexonApiError ? e.message : '네트워크 오류가 발생했습니다.' };
      }
      setStates((prev) => ({ ...prev, [c.ocid]: result }));
    }
    setUpdatedAt(new Date());
    setLoading(false);

    if (DEMO || basicsFetchedFor.current === apiKey + trackedIds) return;
    basicsFetchedFor.current = apiKey + trackedIds;
    for (const c of tracked) {
      await sleep(REQUEST_GAP_MS);
      try {
        const basic = await getCharacterBasic(apiKey, c.ocid);
        updateSettings((prev) => ({
          ...prev,
          tracked: prev.tracked.map((t) =>
            t.ocid === c.ocid ? { ...t, character_image: basic.character_image, character_level: basic.character_level } : t,
          ),
        }));
      } catch {
        /* 이미지 없이 진행 */
      }
    }
    // tracked 객체는 이미지 갱신으로 바뀌므로 ocid 목록으로만 의존
  }, [apiKey, trackedIds, updateSettings]);

  useEffect(() => {
    refresh();
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') refresh();
    }, AUTO_REFRESH_MS);
    const onVisible = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [refresh]);

  // 알림이 켜져 있으면 캐릭터/파티/키 변경을 알림 서버에 반영 (연속 변경은 모아서 한 번)
  const notifySyncKey = settings.notify
    ? JSON.stringify([apiKey, tracked.map((c) => [c.ocid, c.character_image]), settings.party])
    : '';
  const lastSyncedKey = useRef(notifySyncKey);
  useEffect(() => {
    const sub = settings.notify;
    if (DEMO || !sub || notifySyncKey === lastSyncedKey.current) return;
    const timer = setTimeout(() => {
      lastSyncedKey.current = notifySyncKey;
      updateSubscription(sub, buildPayload(settings, sub.prefs, sub.webhookUrl)).catch(() => {
        lastSyncedKey.current = ''; // 실패 시 다음 변경 때 재시도
      });
    }, 1500);
    return () => clearTimeout(timer);
    // settings 전체가 아니라 동기화 대상 값(notifySyncKey)이 바뀔 때만 실행
  }, [notifySyncKey]);

  const setParty = (ocid: string, key: string, size: number) =>
    updateSettings((prev) => ({
      ...prev,
      party: { ...prev.party, [ocid]: { ...prev.party[ocid], [key]: size } },
    }));

  // 전체 캐릭터 합산
  const totals = { bosses: { done: 0, total: 0 }, daily: { done: 0, total: 0 }, weekly: { done: 0, total: 0 } };
  const meso = { earned: 0, expected: 0 };
  for (const c of tracked) {
    const r = states[c.ocid];
    if (!r || !('data' in r)) continue;
    const t = tally(visibleItems(r.data, settings.registeredOnly));
    for (const k of ['bosses', 'daily', 'weekly'] as const) {
      totals[k].done += t[k].done;
      totals[k].total += t[k].total;
    }
    const income = weeklyIncome(r.data, settings.party[c.ocid]);
    meso.earned += income.earned;
    meso.expected += income.expected;
  }
  const hasData = Object.values(states).some((r) => 'data' in r);
  const mesoRatio = meso.expected > 0 ? Math.min(1, meso.earned / meso.expected) : 0;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <img src={`${import.meta.env.BASE_URL}icon.svg`} alt="" width="28" height="28" />
          <h1>메이플 할일 알리미</h1>
          {DEMO && <span className="demo-tag">데모</span>}
        </div>
        <div className="topbar-actions">
          <button className="icon-btn" onClick={refresh} disabled={loading || !apiKey} title="새로고침">
            <svg viewBox="0 0 20 20" width="18" height="18" className={loading ? 'spin' : ''} aria-hidden="true">
              <path d="M16 10a6 6 0 1 1-1.8-4.3M16 3v4h-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <span className="sr-only">새로고침</span>
          </button>
          {!DEMO && NOTIFY_API && (
            <button className={panel === 'notify' ? 'icon-btn active' : 'icon-btn'} onClick={() => togglePanel('notify')} title="디스코드 알림">
              <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">
                <path d="M5 8a5 5 0 0 1 10 0c0 4 1.5 5.5 2 6H3c.5-.5 2-2 2-6z M8 16.5a2 2 0 0 0 4 0" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              {settings.notify && <span className="dot" aria-hidden="true" />}
              <span className="sr-only">디스코드 알림</span>
            </button>
          )}
          {!DEMO && (
            <button className={panel === 'settings' ? 'icon-btn active' : 'icon-btn'} onClick={() => togglePanel('settings')} title="설정">
              <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">
                <path d="M10 13a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M16.5 10l1.5-1.2-1.5-2.6-1.8.6a6 6 0 0 0-1.6-.9L12.8 4h-3l-.4 1.9a6 6 0 0 0-1.6.9l-1.8-.6-1.5 2.6L6 10l-1.5 1.2 1.5 2.6 1.8-.6c.5.4 1 .7 1.6.9l.4 1.9h3l.4-1.9c.6-.2 1.1-.5 1.6-.9l1.8.6 1.5-2.6z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
              </svg>
              <span className="sr-only">설정</span>
            </button>
          )}
        </div>
      </header>

      {panel === 'settings' && (
        <SettingsPanel settings={settings} onChange={(next) => updateSettings(() => next)} onDone={() => setPanel(null)} />
      )}
      {panel === 'notify' && <NotifyPanel settings={settings} onChange={updateSettings} />}

      <ResetTimers />

      {hasData && (
        <section className="summary">
          <div className="meso-card">
            <span className="meso-label">이번 주 결정석 수익</span>
            <div className="meso-value">
              <strong>{formatMeso(meso.earned)}</strong>
              <span>/ {formatMeso(meso.expected)} 메소</span>
            </div>
            <div className="bar thick">
              <span className={mesoRatio >= 1 ? 'full' : ''} style={{ width: `${mesoRatio * 100}%` }} />
            </div>
            <span className="meso-note">
              잡은 보스 + 남은 처치 횟수(주 12회) 안에서 비싼 등록 보스 기준 · {CRYSTAL_PRICE_AS_OF} 가격
            </span>
          </div>
          <div className="progress-card">
            <Total label="보스" t={totals.bosses} />
            <Total label="일일" t={totals.daily} />
            <Total label="주간" t={totals.weekly} />
          </div>
        </section>
      )}

      {panel !== 'settings' && tracked.length === 0 && (
        <div className="empty">
          <p>설정에서 API 키를 입력하고 표시할 캐릭터를 선택해주세요.</p>
          <button className="primary" onClick={() => setPanel('settings')}>
            설정 열기
          </button>
        </div>
      )}

      {tracked.length > 0 && (
        <div className="toolbar">
          <h2>
            캐릭터 <span>{tracked.length}</span>
          </h2>
          <label className="switch">
            <input
              type="checkbox"
              checked={settings.registeredOnly}
              onChange={(e) => updateSettings((prev) => ({ ...prev, registeredOnly: e.target.checked }))}
            />
            <span className="switch-track" aria-hidden="true" />
            스케줄러 등록 항목만
          </label>
        </div>
      )}

      <main className="cards">
        {tracked.map((c) => (
          <CharacterCard
            key={c.ocid}
            character={c}
            result={states[c.ocid]}
            registeredOnly={settings.registeredOnly}
            party={settings.party[c.ocid]}
            onPartyChange={(key, size) => setParty(c.ocid, key, size)}
          />
        ))}
      </main>

      {updatedAt && <footer className="footer">마지막 갱신 {updatedAt.toLocaleTimeString('ko-KR')}</footer>}
    </div>
  );
}

function Total({ label, t }: { label: string; t: { done: number; total: number } }) {
  const ratio = t.total > 0 ? t.done / t.total : 0;
  return (
    <div className="total">
      <div className="total-head">
        <span>{label}</span>
        <strong>
          {t.done}
          <span>/{t.total}</span>
        </strong>
      </div>
      <div className="bar">
        <span className={ratio >= 1 ? 'full' : ''} style={{ width: `${ratio * 100}%` }} />
      </div>
    </div>
  );
}
