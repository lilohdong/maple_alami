# 메이플 할일 알리미

NEXON Open API의 [스케줄러 API](https://openapi.nexon.com/ko/game/maplestory/?id=57)로 캐릭터별 보스 처치 여부와 일일/주간 콘텐츠 진행 현황을 보여주는 PWA입니다.

## 실행

```bash
npm install
npm run dev      # 개발 서버
npm run build    # dist/ 에 정적 파일 생성
```

## 사용법

1. [NEXON Open API](https://openapi.nexon.com)에 본인 넥슨 계정으로 로그인해 애플리케이션을 등록하고 API 키를 발급받습니다.
2. 앱의 **설정**에서 키를 입력하고 **내 캐릭터 불러오기** → 표시할 캐릭터를 선택 → 저장.
3. 화면이 보이는 동안 5분마다, 그리고 앱으로 돌아올 때마다 자동 갱신됩니다.

API 키는 브라우저 localStorage에만 저장되며 외부 서버로 전송되지 않습니다(넥슨 API 직접 호출).

## 데이터 갱신 시점 (넥슨 문서 기준)

- 보스, 에픽던전, 무릉도장, 길드 콘텐츠: 완료 즉시
- 그 외 콘텐츠/퀘스트: 접속 중 또는 접속 종료 시

## 구조

| 경로 | 설명 |
|---|---|
| `src/api/nexon.ts` | Nexon API 클라이언트 (fetch만 사용, Worker에서도 재사용 예정) |
| `src/lib/reset.ts` | KST 기준 일일/주간/월간 리셋 시각 계산 |
| `src/lib/storage.ts` | 설정 저장 (localStorage) |
| `src/components/` | 리셋 타이머, 설정, 캐릭터 카드 |

## 로드맵

- [x] 1단계: 서버 없는 PWA 대시보드
- [ ] 2단계: Cloudflare Worker 크론 + 알림 (디스코드 웹훅 / Web Push)
- [ ] 3단계: NEXON Open ID 로그인으로 다중 사용자 지원
