// Nexon Open API (메이플스토리) 클라이언트.
// 브라우저/Cloudflare Worker 양쪽에서 재사용할 수 있도록 fetch 외의 의존성을 두지 않는다.

const BASE_URL = 'https://open.api.nexon.com';

export interface CharacterSummary {
  ocid: string;
  character_name: string;
  world_name: string;
  character_class: string;
  character_level: number;
}

export interface CharacterListResponse {
  account_list: {
    account_id: string;
    character_list: CharacterSummary[];
  }[];
}

/** 'true' / 'false' 문자열로 내려오는 플래그 */
type StringFlag = 'true' | 'false';

export interface SchedulerContent {
  content_name: string;
  type: 'contents' | 'quest';
  registration_flag: StringFlag;
  now_count: number;
  max_count: number;
  /** 퀘스트인 경우 "0":기타, "1":진행 중, "2":완료 */
  quest_state: '0' | '1' | '2' | null;
}

export interface SchedulerBoss {
  content_name: string;
  difficulty: string;
  cycle: string;
  list_order_no: number;
  registration_flag: StringFlag;
  complete_flag: StringFlag;
}

export interface CharacterStateResponse {
  date: string | null;
  character_name: string;
  world_name: string;
  character_level: number;
  character_class: string;
  daily_contents: SchedulerContent[];
  weekly_contents: SchedulerContent[];
  boss_contents: SchedulerBoss[];
  weekly_boss_clear_count: number;
  weekly_boss_clear_limit_count: number;
}

const ERROR_MESSAGES: Record<string, string> = {
  OPENAPI00001: '넥슨 API 서버 내부 오류입니다. 잠시 후 다시 시도해주세요.',
  OPENAPI00002: '이 API를 호출할 권한이 없습니다.',
  OPENAPI00003: '유효하지 않은 캐릭터 식별자입니다.',
  OPENAPI00004: '요청 파라미터가 올바르지 않습니다.',
  OPENAPI00005: 'API 키가 유효하지 않습니다.',
  OPENAPI00006: '유효하지 않은 게임 또는 API 경로입니다.',
  OPENAPI00007: 'API 호출량 한도를 초과했습니다. 잠시 후 다시 시도해주세요.',
  OPENAPI00009: '아직 데이터가 준비되지 않았습니다.',
  OPENAPI00010: '게임 점검 중입니다.',
  OPENAPI00011: 'API 점검 중입니다.',
};

export class NexonApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'NexonApiError';
  }
}

async function request<T>(apiKey: string, path: string, params: Record<string, string> = {}): Promise<T> {
  const url = new URL(path, BASE_URL);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const res = await fetch(url, { headers: { 'x-nxopen-api-key': apiKey } });
  const body = await res.json().catch(() => null);

  if (!res.ok) {
    const code: string = body?.error?.name ?? `HTTP${res.status}`;
    throw new NexonApiError(code, ERROR_MESSAGES[code] ?? body?.error?.message ?? `요청 실패 (${res.status})`, res.status);
  }
  return body as T;
}

/** API 키 소유 계정의 전체 캐릭터 목록 */
export async function getCharacterList(apiKey: string): Promise<CharacterSummary[]> {
  const data = await request<CharacterListResponse>(apiKey, '/maplestory/v1/character/list');
  return data.account_list.flatMap((a) => a.character_list);
}

/** 캐릭터 스케줄러 수행 현황 (본인 계정 캐릭터만 조회 가능). date 미지정 시 실시간 */
export function getCharacterState(apiKey: string, ocid: string, date?: string): Promise<CharacterStateResponse> {
  return request<CharacterStateResponse>(apiKey, '/maplestory/v1/scheduler/character-state', {
    ocid,
    ...(date ? { date } : {}),
  });
}
