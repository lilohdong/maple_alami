import { useCallback, useEffect, useState } from 'react';
import { getCharacterState, NexonApiError, type CharacterStateResponse } from './api/nexon';
import { loadSettings, saveSettings, type Settings } from './lib/storage';
import { ResetTimers } from './components/ResetTimers';
import { SettingsPanel } from './components/SettingsPanel';
import { CharacterCard } from './components/CharacterCard';

/** 화면이 보이는 동안 자동 새로고침 주기 */
const AUTO_REFRESH_MS = 5 * 60 * 1000;
/** 개발용 키의 초당 호출 제한을 피하기 위한 캐릭터 간 간격 */
const REQUEST_GAP_MS = 250;

type StateResult = { data: CharacterStateResponse } | { error: string };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export default function App() {
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [showSettings, setShowSettings] = useState(() => !loadSettings().apiKey);
  const [states, setStates] = useState<Record<string, StateResult>>({});
  const [loading, setLoading] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);

  const updateSettings = (next: Settings) => {
    setSettings(next);
    saveSettings(next);
  };

  const refresh = useCallback(async () => {
    const { apiKey, tracked } = settings;
    if (!apiKey || tracked.length === 0) return;
    setLoading(true);
    for (const [i, c] of tracked.entries()) {
      if (i > 0) await sleep(REQUEST_GAP_MS);
      let result: StateResult;
      try {
        result = { data: await getCharacterState(apiKey, c.ocid) };
      } catch (e) {
        result = { error: e instanceof NexonApiError ? e.message : '네트워크 오류가 발생했습니다.' };
      }
      setStates((prev) => ({ ...prev, [c.ocid]: result }));
    }
    setUpdatedAt(new Date());
    setLoading(false);
  }, [settings]);

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

  return (
    <div className="app">
      <header className="header">
        <h1>메이플 할일 알리미</h1>
        <div className="header-actions">
          <button onClick={refresh} disabled={loading || !settings.apiKey}>
            {loading ? '불러오는 중…' : '새로고침'}
          </button>
          <button onClick={() => setShowSettings((v) => !v)}>{showSettings ? '닫기' : '설정'}</button>
        </div>
      </header>

      <ResetTimers />

      {showSettings && (
        <SettingsPanel settings={settings} onChange={updateSettings} onDone={() => setShowSettings(false)} />
      )}

      {!showSettings && settings.tracked.length === 0 && (
        <p className="empty">설정에서 API 키를 입력하고 표시할 캐릭터를 선택해주세요.</p>
      )}

      {settings.tracked.length > 0 && (
        <label className="filter">
          <input
            type="checkbox"
            checked={settings.registeredOnly}
            onChange={(e) => updateSettings({ ...settings, registeredOnly: e.target.checked })}
          />
          인게임 스케줄러에 등록된 항목만 보기
        </label>
      )}

      <main className="cards">
        {settings.tracked.map((c) => (
          <CharacterCard key={c.ocid} character={c} result={states[c.ocid]} registeredOnly={settings.registeredOnly} />
        ))}
      </main>

      {updatedAt && <footer className="footer">마지막 갱신: {updatedAt.toLocaleTimeString('ko-KR')}</footer>}
    </div>
  );
}
