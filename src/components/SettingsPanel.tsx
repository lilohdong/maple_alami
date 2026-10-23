import { useState } from 'react';
import { getCharacterList, NexonApiError, type CharacterSummary } from '../api/nexon';
import type { Settings } from '../lib/storage';

interface Props {
  settings: Settings;
  onChange: (next: Settings) => void;
  onDone: () => void;
}

export function SettingsPanel({ settings, onChange, onDone }: Props) {
  const [apiKey, setApiKey] = useState(settings.apiKey);
  const [characters, setCharacters] = useState<CharacterSummary[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(() => new Set(settings.tracked.map((c) => c.ocid)));
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const loadCharacters = async () => {
    setError('');
    setLoading(true);
    try {
      const list = await getCharacterList(apiKey.trim());
      list.sort((a, b) => b.character_level - a.character_level);
      setCharacters(list);
    } catch (e) {
      setError(e instanceof NexonApiError ? e.message : '네트워크 오류가 발생했습니다.');
    } finally {
      setLoading(false);
    }
  };

  const toggle = (ocid: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(ocid)) next.delete(ocid);
      else next.add(ocid);
      return next;
    });
  };

  const save = () => {
    const pool = characters ?? settings.tracked;
    onChange({ ...settings, apiKey: apiKey.trim(), tracked: pool.filter((c) => selected.has(c.ocid)) });
    onDone();
  };

  return (
    <section className="panel">
      <h2>설정</h2>
      <label className="field">
        <span>API 키</span>
        <input
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder="openapi.nexon.com 에서 발급한 키"
          autoComplete="off"
        />
      </label>
      <p className="hint">
        <a href="https://openapi.nexon.com" target="_blank" rel="noreferrer">
          NEXON Open API
        </a>
        에서 본인 넥슨 계정으로 애플리케이션을 등록해 발급한 키를 입력하세요. 키는 이 기기에만 저장됩니다.
      </p>
      <button onClick={loadCharacters} disabled={!apiKey.trim() || loading}>
        {loading ? '불러오는 중…' : '내 캐릭터 불러오기'}
      </button>
      {error && <p className="error">{error}</p>}

      {characters && (
        <ul className="char-list">
          {characters.map((c) => (
            <li key={c.ocid}>
              <label>
                <input type="checkbox" checked={selected.has(c.ocid)} onChange={() => toggle(c.ocid)} />
                <span className="char-name">{c.character_name}</span>
                <span className="muted">
                  Lv.{c.character_level} {c.character_class} · {c.world_name}
                </span>
              </label>
            </li>
          ))}
        </ul>
      )}

      <div className="panel-actions">
        <button className="primary" onClick={save} disabled={!apiKey.trim()}>
          저장
        </button>
      </div>
    </section>
  );
}
