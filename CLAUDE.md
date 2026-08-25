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

## 배포 — 두 방식이 섞여 있으니 주의

- **현행: Cloudflare Workers + KV.** `wrangler.jsonc`(main=`src/worker.mjs`)가 본체.
  배포는 `npx wrangler deploy`
- ⚠️ `server.js`와 `render.yaml`, README의 "Render 배포" 절차는 **이전 방식의 흔적**이다
  (2026-08-25 Workers로 전환). 고치라는 요청이 없으면 건드리지 말고, README 갱신은 별도 작업
- ⏰ 남은 일: **`CLOUDFLARE_API_TOKEN` 시크릿 등록 1건** (자동 갱신용)

## 폴더

```
src/worker.mjs    Workers 본체 — 수집·필터·렌더링
public/           index.html, sw.js(서비스워커), manifest — PWA("홈 화면에 추가")
server.js         (이전 Render용 — 참고만)
```

## 알려진 함정

- 충주 일부 공고는 본문이 비어 있고 첨부 HWPX에만 내용이 있다 → "공고 원문 보기"로 넘긴다
- 푸시 알림은 앱을 열어둔 동안만 동작(10분 주기). 진짜 Web Push는 미구현
