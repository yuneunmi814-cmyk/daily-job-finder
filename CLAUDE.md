# 일자리 알리미 (daily-job-finder) — 작업 규칙

시니어용 일자리 웹앱. **라이브: daily-job-finder.yuneunmi814.workers.dev**
전국 92개 시·군청 공고(제천 RSS + 91곳 새올 전자민원) + 노인일자리여기를 모아
**접수 중인 것만, 큰 글씨로, 전화 걸기 버튼과 함께** 보여준다.

## 절대 규칙 — 사용자는 시니어다

1. **글씨를 줄이지 않는다. 정보를 늘려서 화면을 빽빽하게 만들지 않는다.**
   기능을 넣고 싶을 때 "우리 부모님이 안경 없이 쓸 수 있나"로 판단한다.
2. **전화 걸기 버튼은 항상 살아 있어야 한다** — 이 앱의 최종 동작은 클릭이 아니라 전화다.
3. 공고 라이선스 주의: 제천/단양/충주는 공공누리 2·4유형(**상업적 이용 금지**).
   수익화 기능을 붙이기 전에 반드시 라이선스부터 재확인.

## 배포 — 수집과 보여주기가 나뉘어 있다

한 덩어리가 아니다. **수집은 GitHub Actions, 보여주기는 Cloudflare Worker**다.
시·군 92곳을 도는 데 외부 요청이 수천 건 필요한데, Worker 한 번 실행에 허용되는
요청 수로는 감당이 안 돼서 나눴다.

1. **수집** — GitHub Actions(`.github/workflows/crawl.yml`)가 하루 3번(한국시간 06·12·18시)
   `CRAWL_OUT=jobs.json CRAWL_PREV=prev.json node server.js` 를 돌린다
2. **저장** — 그 결과 JSON을 Cloudflare KV `JOBS` 네임스페이스의 `jobs:latest` 키에 넣는다
3. **보여주기** — `src/worker.mjs` 가 KV를 읽어 `/api/jobs`·`/api/job`·`/api/status`로 내보낸다.
   배포는 `npx wrangler deploy`

- ⚠️ **`server.js`는 살아 있는 수집기다. 지우거나 무시하면 자동 갱신이 죽는다.**
  (`CRAWL_OUT` 환경변수가 없으면 예전처럼 로컬 서버로 뜬다 — `npm start`)
- `render.yaml`과 README의 "Render 배포" 절차만 이전 방식의 흔적이다
- ⏰ 남은 일: **`CLOUDFLARE_API_TOKEN` 시크릿 등록 1건** (없으면 자동 갱신이 안 돈다).
  `SENURI_KEY`·`CLOUDFLARE_ACCOUNT_ID`는 등록 완료

## 폴더

```
server.js                    수집기 — 시·군 92곳 + 노인일자리. GitHub Actions가 돌린다
src/worker.mjs               Worker — KV를 읽어 보여주기만 한다 (수집 안 함)
.github/workflows/crawl.yml  하루 3번 수집 → KV 적재
public/                      index.html, sw.js(서비스워커), manifest — PWA("홈 화면에 추가")
```

## 손대기 전에 알아야 할 것

- `EMINWON_CITIES`의 **기존 11곳 `prefix`(dy/cj/wj/yw/yj/mg/es/jch/gs/pc/jsn)는 바꾸면 안 된다.**
  공고 ID가 이걸로 만들어져서, 바꾸면 "새 공고" 배지와 저장된 목록이 전부 깨진다
- host가 시군명과 다른 곳: 문경=gbmg, 영월=yw, 평창=pc, 경기광주=gjcity, 양평=yp21, 강원고성=gwgs
- 제천은 새올 도메인 자체가 없어 RSS를 쓴다 — "빠졌다"고 넣으려 하지 말 것
- 수집이 0건이면 예외를 던져 **KV를 덮어쓰지 않는다.** 이 안전장치를 없애지 말 것
- 화면(HTML)은 서비스워커에서 **network-first**여야 한다. cache-first로 되돌리면
  홈 화면에 설치한 사람은 앱이 영원히 갱신되지 않는다 (실제로 있었던 버그)

## 알려진 함정

- 충주 일부 공고는 본문이 비어 있고 첨부 HWPX에만 내용이 있다 → "공고 원문 보기"로 넘긴다
- 푸시 알림은 앱을 열어둔 동안만 동작(10분 주기). 진짜 Web Push는 미구현
