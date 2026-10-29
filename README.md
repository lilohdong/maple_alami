# 메이플 할일 알리미

NEXON Open API의 [스케줄러 API](https://openapi.nexon.com/ko/game/maplestory/?id=57)로 캐릭터별 보스 처치 여부와 일일/주간 콘텐츠 진행 현황, 주간 결정석 수익을 보여주는 PWA입니다. 리셋 전에 남은 할일을 디스코드로 알려줍니다.

- 앱: https://maple-alami.pages.dev (데모: `/?demo`)
- 알림 Worker: https://maple-alami-notify.lilohdong.workers.dev

## 실행 / 배포

```bash
npm install
npm run dev            # 개발 서버
npm run deploy         # 앱 빌드 후 Cloudflare Pages 배포
npm run deploy:worker  # 알림 Worker 배포
```

최초 1회 `npx wrangler login` 필요. wrangler는 Node 20 호환을 위해 4.20.0으로 고정되어 있습니다.

## 사용법

1. [NEXON Open API](https://openapi.nexon.com)에 본인 넥슨 계정으로 로그인해 애플리케이션을 등록하고 API 키를 발급받습니다.
2. 앱의 **설정**에서 키를 입력하고 **내 캐릭터 불러오기** → 표시할 캐릭터를 선택 → 저장.
3. (선택) 🔔 **디스코드 알림**에서 웹훅 주소와 초대 코드를 입력해 알림을 켭니다.

API 키는 브라우저 localStorage에 저장되며 넥슨 API로만 전송됩니다. 디스코드 알림을 켠 경우에만 알림 Worker에 AES-GCM으로 암호화되어 저장되고, 알림을 끄면 삭제됩니다.

## 디스코드 알림

| 알림 | 시각 (KST) | 내용 |
|---|---|---|
| 주간 보스 | 수 18:00 | 남은 등록 주간 보스, 남은 결정석 |
| 주간 콘텐츠 | 수 18:00 | 남은 등록 주간 콘텐츠 |
| 일일 콘텐츠 | 매일 22:00 | 남은 등록 일일 콘텐츠, 미접속 캐릭터 |

남은 할일이 없으면 보내지 않습니다. 웹훅이 삭제되면 구독도 자동 삭제됩니다.

### Worker 운영

- 구독 정보: KV `SUBS` (`sub:<id>`, 암호화된 JSON)
- 비밀값: `ENCRYPTION_KEY` (base64 32바이트), `INVITE_CODE` — `npx wrangler secret put <NAME> -c worker/wrangler.toml`
- 초대 코드 변경: `INVITE_CODE`만 다시 설정하면 됨 (기존 구독은 유지)
- `ENCRYPTION_KEY`를 바꾸면 기존 구독을 모두 읽을 수 없게 되므로 바꾸지 말 것
- 무료 플랜 제약: 크론 1회 실행당 외부 요청 50개 → 대략 (캐릭터 수 + 1) × 구독자 수 ≤ 50

## 데이터 갱신 시점 (넥슨 문서 기준)

- 보스, 에픽던전, 무릉도장, 길드 콘텐츠: 완료 즉시
- 그 외 콘텐츠/퀘스트: 접속 중 또는 접속 종료 시

## 구조

| 경로 | 설명 |
|---|---|
| `src/api/nexon.ts` | Nexon API 클라이언트 (앱·Worker 공용) |
| `src/api/notify.ts` | 알림 Worker 클라이언트 |
| `src/lib/progress.ts` | 진행도/결정석 수익 계산 (앱·Worker 공용) |
| `src/data/crystals.ts` | 보스 결정석 가격표 — 패치 시 이 파일만 수정 |
| `src/lib/reset.ts` | KST 기준 리셋 시각 계산 |
| `src/components/` | 화면 컴포넌트 |
| `worker/` | 디스코드 알림 Worker (구독 API + 크론) |
| `public/_headers` | CSP 등 보안 헤더 |

## 로드맵

- [x] 1단계: 서버 없는 PWA 대시보드
- [x] 2단계: Cloudflare Worker 크론 + 디스코드 알림 (봇 /등록 /현황 /설정 /해제 /연결, 웹훅)
- [ ] 3단계: NEXON Open ID 로그인 (넥슨 프렌즈 승인 필요)
