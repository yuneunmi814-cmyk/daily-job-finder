// 일자리 알리미 — Cloudflare Worker
//
// 역할은 "보여주기"뿐이다. 공고 수집은 GitHub Actions가 하루 몇 번 돌면서
// server.js 를 수집 모드로 실행하고, 그 결과 JSON을 KV(jobs:latest)에 넣어준다.
// 여기서는 그걸 읽어 걸러서 내보내기만 한다.
//
// 왜 이렇게 나눴나: 시군청 사이트 91곳을 도는 데는 요청이 수천 건 필요한데,
// Worker 한 번 실행에 허용되는 외부 요청 수로는 감당이 안 된다.

const KEY = 'jobs:latest';
const LIST_LIMIT = 200;

// 같은 isolate 안에서는 다시 읽지 않는다 (payload가 몇 MB라 매번 파싱하면 느리다)
let memo = { at: 0, data: null };
const MEMO_MS = 60 * 1000;

async function getData(env) {
  if (memo.data && Date.now() - memo.at < MEMO_MS) return memo.data;
  const data = await env.JOBS.get(KEY, { type: 'json', cacheTtl: 300 });
  if (data) {
    data.regions = buildRegions(data.jobs);   // 한 번만 계산해두고 재사용
    memo = { at: Date.now(), data };
  }
  return data;
}

// 지역 버튼에 쓸 목록. 전국 확대로 시군이 90곳이 넘어가서,
// 화면에 뭘 보여줄지 데이터에서 직접 뽑는다 — 공고가 없는 지역은 버튼도 안 나온다.
function buildRegions(jobs) {
  const out = {};
  for (const j of jobs) {
    if (!j.open || !j.place) continue;
    const [sido, sigun] = j.place.split(' ');
    if (!sido) continue;
    (out[sido] ||= {});
    if (sigun) out[sido][sigun] = (out[sido][sigun] || 0) + 1;
  }
  return out;
}

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=60',
    },
  });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/api/jobs') {
      const data = await getData(env);
      if (!data) return json({ total: 0, counts: {}, jobs: [], error: '아직 수집된 공고가 없습니다' }, 503);

      const q = (url.searchParams.get('q') || '').trim();
      const openOnly = url.searchParams.get('open') !== '0';

      let jobs = data.jobs;
      if (openOnly) jobs = jobs.filter(j => j.open);
      if (q) {
        const terms = q.split(/\s+/);
        jobs = jobs.filter(j => terms.every(t =>
          j.place.includes(t) || j.title.includes(t) || j.org.includes(t) || (j.addr || '').includes(t)));
      }

      // 마감이 가까운 것부터 보여준다. 시니어에게 제일 중요한 건 "언제까지"라서,
      // 사람인·잡코리아·워크넷이 공통으로 두는 축이기도 하다.
      // 마감일이 없는 공고(상시·채용시)는 워크넷처럼 뒤로 뺀다 — 급하지 않으니까.
      const byDeadline = [...jobs].sort((a, b) => {
        const x = a.endDd || '99999999';
        const y = b.endDd || '99999999';
        return x < y ? -1 : x > y ? 1 : 0;
      });

      return json({
        total: jobs.length,
        counts: {
          city: jobs.filter(j => j.src !== 'senuri').length,
          senuri: jobs.filter(j => j.src === 'senuri').length,
        },
        updatedAt: data.at,
        regions: data.regions,
        jobs: byDeadline.slice(0, LIST_LIMIT),
      });
    }

    if (path === '/api/job') {
      const id = url.searchParams.get('id');
      if (!id || !/^[A-Za-z0-9]+$/.test(id)) return json({ error: 'bad id' }, 400);

      const data = await getData(env);
      if (!data) return json({ job: null }, 503);

      // 시군청 공고는 목록에 본문이 이미 들어 있다
      const cached = data.jobs.find(j => j.id === id);
      if (cached && cached.src !== 'senuri') return json({ job: cached });

      // 노인일자리는 수집 때 따로 받아둔 상세를 쓴다
      const d = (data.senuriDetails || {})[id];
      if (!d) return json({ job: null });
      return json({
        job: {
          src: 'senuri',
          plDetAddr: d.addr, plbizNm: d.plbizNm, clerk: d.clerk, age: d.age,
          frAcptDd: d.frAcptDd, toAcptDd: d.toAcptDd, etcItm: d.etcItm, phones: d.phones,
        },
      });
    }

    // 수집이 언제 돌았는지 확인용
    if (path === '/api/status') {
      const data = await getData(env);
      return json(data ? { at: data.at, ...data.stats } : { error: '데이터 없음' }, data ? 200 : 503);
    }

    // 나머지는 정적 파일 (public/)
    return env.ASSETS.fetch(request);
  },
};
