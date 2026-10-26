// localStorage 래퍼. 사파리 프라이빗 모드 등에서 접근이 막혀도 앱이 동작하도록 예외를 삼킨다.

import type { CharacterSummary } from '../api/nexon';
import type { PartySizes } from './progress';
import type { NotifyPrefs } from '../api/notify';
import { normalizeDifficulty } from '../data/crystals';

const PREFIX = 'maple-alami:';

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    /* 저장 실패는 무시 */
  }
}

export interface Settings {
  apiKey: string;
  /** 대시보드에 표시할 캐릭터 (순서 유지) */
  tracked: CharacterSummary[];
  /** 인게임 스케줄러에 등록된 항목만 표시 */
  registeredOnly: boolean;
  /** 캐릭터(ocid)별 보스 파티 인원 */
  party: Record<string, PartySizes>;
  /** 디스코드 알림 구독 정보 (켜져 있을 때만) */
  notify?: NotifySettings;
}

export interface NotifySettings {
  id: string;
  token: string;
  webhookUrl: string;
  prefs: NotifyPrefs;
}

const DEFAULT_SETTINGS: Settings = { apiKey: '', tracked: [], registeredOnly: true, party: {} };

export function loadSettings(): Settings {
  const s = { ...DEFAULT_SETTINGS, ...read<Partial<Settings>>('settings', {}) };
  return { ...s, party: migrateParty(s.party) };
}

/** 예전 버전은 파티 인원 키에 영문 난이도('칼로스|normal')를 저장했음 → 한글 정식 표기로 변환 */
function migrateParty(party: Settings['party']): Settings['party'] {
  return Object.fromEntries(
    Object.entries(party).map(([ocid, sizes]) => [
      ocid,
      Object.fromEntries(
        Object.entries(sizes).map(([key, size]) => {
          const i = key.lastIndexOf('|');
          return [i < 0 ? key : `${key.slice(0, i)}|${normalizeDifficulty(key.slice(i + 1))}`, size];
        }),
      ),
    ]),
  );
}

export function saveSettings(settings: Settings): void {
  write('settings', settings);
}
