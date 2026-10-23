// ?demo 로 접속했을 때 사용하는 가짜 데이터. API 키 없이 화면을 확인하기 위한 용도.

import type { CharacterStateResponse, CharacterSummary, SchedulerBoss, SchedulerContent } from './nexon';

export const DEMO_CHARACTERS: CharacterSummary[] = [
  { ocid: 'demo-1', character_name: '단풍잎용사', world_name: '스카니아', character_class: '아델', character_level: 287 },
  { ocid: 'demo-2', character_name: '메소줍는중', world_name: '스카니아', character_class: '비숍', character_level: 272 },
  { ocid: 'demo-3', character_name: '보스만잡음', world_name: '스카니아', character_class: '나이트로드', character_level: 265 },
];

const boss = (
  name: string,
  difficulty: string,
  cycle: string,
  order: number,
  done: boolean,
  registered = true,
): SchedulerBoss => ({
  content_name: name,
  difficulty,
  cycle,
  list_order_no: order,
  registration_flag: registered ? 'true' : 'false',
  complete_flag: done ? 'true' : 'false',
});

const content = (name: string, now: number, max: number): SchedulerContent => ({
  content_name: name,
  type: 'contents',
  registration_flag: 'true',
  now_count: now,
  max_count: max,
  quest_state: null,
});

const quest = (name: string, state: '0' | '1' | '2'): SchedulerContent => ({
  content_name: name,
  type: 'quest',
  registration_flag: 'true',
  now_count: 0,
  max_count: 0,
  quest_state: state,
});

const DEMO_STATES: Record<string, Omit<CharacterStateResponse, 'character_name' | 'world_name' | 'character_class' | 'character_level'>> = {
  'demo-1': {
    date: null,
    weekly_boss_clear_count: 9,
    weekly_boss_clear_limit_count: 12,
    boss_contents: [
      boss('검은 마법사', '하드', '월간', 1, false),
      boss('칼로스', '카오스', '주간', 2, false),
      boss('카링', '노멀', '주간', 3, false),
      boss('세렌', '하드', '주간', 4, true),
      boss('최초의 대적자', '노멀', '주간', 5, true),
      boss('진 힐라', '하드', '주간', 6, true),
      boss('듄켈', '하드', '주간', 7, true),
      boss('더스크', '카오스', '주간', 8, true),
      boss('윌', '하드', '주간', 9, true),
      boss('루시드', '하드', '주간', 10, true),
      boss('가디언 엔젤 슬라임', '카오스', '주간', 11, true),
      boss('스우', '하드', '주간', 12, true),
      boss('데미안', '하드', '주간', 13, true),
      boss('자쿰', '카오스', '주간', 14, false, false),
    ],
    daily_contents: [
      content('몬스터파크', 2, 2),
      quest('세르니움 일일 퀘스트', '2'),
      quest('아르크스 일일 퀘스트', '2'),
      quest('오디움 일일 퀘스트', '1'),
      quest('도원경 일일 퀘스트', '0'),
      content('우르스', 1, 3),
    ],
    weekly_contents: [
      content('에픽 던전 : 앵글러 컴퍼니', 1, 1),
      content('에픽 던전 : 하이마운틴', 0, 1),
      content('무릉도장', 1, 1),
      content('길드 플래그 레이스', 3, 3),
    ],
  },
  'demo-2': {
    date: null,
    weekly_boss_clear_count: 4,
    weekly_boss_clear_limit_count: 12,
    boss_contents: [
      boss('카오스 자쿰', '카오스', '주간', 1, true),
      boss('매그너스', '하드', '주간', 2, true),
      boss('파풀라투스', '카오스', '주간', 3, true),
      boss('스우', '노멀', '주간', 4, true),
      boss('데미안', '노멀', '주간', 5, false),
      boss('루시드', '노멀', '주간', 6, false),
      boss('윌', '노멀', '주간', 7, false),
      boss('혼테일', '카오스', '일간', 8, true),
      boss('반 레온', '하드', '일간', 9, false),
    ],
    daily_contents: [content('몬스터파크', 0, 2), quest('세르니움 일일 퀘스트', '0')],
    weekly_contents: [content('에픽 던전 : 앵글러 컴퍼니', 0, 1)],
  },
  'demo-3': {
    date: null,
    weekly_boss_clear_count: 12,
    weekly_boss_clear_limit_count: 12,
    boss_contents: [
      boss('세렌', '노멀', '주간', 1, true),
      boss('진 힐라', '노멀', '주간', 2, true),
      boss('듄켈', '노멀', '주간', 3, true),
      boss('더스크', '노멀', '주간', 4, true),
      boss('윌', '하드', '주간', 5, true),
      boss('루시드', '하드', '주간', 6, true),
    ],
    daily_contents: [content('몬스터파크', 2, 2), quest('세르니움 일일 퀘스트', '2')],
    weekly_contents: [content('무릉도장', 1, 1)],
  },
};

export async function getDemoState(ocid: string): Promise<CharacterStateResponse> {
  await new Promise((r) => setTimeout(r, 200));
  const c = DEMO_CHARACTERS.find((d) => d.ocid === ocid)!;
  return { ...c, ...DEMO_STATES[ocid] };
}

/** 파티 인원 설정 예시 */
export const DEMO_PARTY: Record<string, Record<string, number>> = {
  'demo-1': { '칼로스|카오스': 2, '카링|노멀': 3 },
};
