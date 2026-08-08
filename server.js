const http = require('http');
const fs = require('fs');
const path = require('path');

// .env 로드 (의존성 없이)
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}

const KEY = process.env.SENURI_KEY;
if (!KEY) {
  console.error('SENURI_KEY가 없습니다. .env 파일을 확인하세요.');
  process.exit(1);
}

const SENURI = 'https://apis.data.go.kr/B552474/SenuriService';
const JECHEON_RSS = 'https://www.jecheon.go.kr/rssBbsNtt.do?bbsNo=18';
const JECHEON_VIEW = 'https://www.jecheon.go.kr/www/selectBbsNttView.do?bbsNo=18&key=5233&nttNo=';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const PAGES = 10;         // 노인일자리: 최근 10,000건 (일 트래픽 10,000건 한도 내)
const CACHE_MS = 10 * 60 * 1000;
const PORT = process.env.PORT || 3465;

const PHONE_RE = /(?<!\d)0(?:2|1[016789]|[3-6]\d|70)[-.\s]?\d{3,4}[-.\s]?\d{4}(?!\d)/g;

function decodeXml(s) {
  return s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
}

function findPhones(text) {
  return [...new Set(String(text).match(PHONE_RE) || [])];
}

function ymd(d) {
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

function daysBetween(fromYmd, toYmd) {
  const p = s => new Date(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8));
  return Math.round((p(toYmd) - p(fromYmd)) / 86400000);
}

// ---------- 노인일자리 (한국노인인력개발원) ----------
function parseItems(xml) {
  const items = [];
  for (const block of xml.match(/<item>[\s\S]*?<\/item>/g) || []) {
    const o = {};
    for (const m of block.matchAll(/<([A-Za-z]+)>([^<]*)<\/\1>/g)) o[m[1]] = decodeXml(m[2]);
    items.push(o);
  }
  return items;
}

// 목록 API는 지역명을 안 준다(지역코드만). 주소는 상세 조회에만 있어서,
// 접수 중인 공고만 상세를 한 번씩 받아 저장해두고 지역 검색에 쓴다. 공고 내용은 바뀌지 않으므로 영구 캐시.
const details = new Map();     // jobId -> { addr, phones, age, clerk, plbizNm, frAcptDd, toAcptDd, etcItm }
const detailFails = new Map(); // jobId -> 실패 횟수 (3번 실패하면 포기)

const SIDO_SHORT = {
  서울특별시: '서울', 부산광역시: '부산', 대구광역시: '대구', 인천광역시: '인천',
  광주광역시: '광주', 대전광역시: '대전', 울산광역시: '울산', 세종특별자치시: '세종',
  경기도: '경기', 강원특별자치도: '강원', 강원도: '강원', 충청북도: '충북', 충청남도: '충남',
  전북특별자치도: '전북', 전라북도: '전북', 전라남도: '전남', 경상북도: '경북', 경상남도: '경남',
  제주특별자치도: '제주',
};

// "27161 충청북도 제천시 용두대로23길 14" -> "충북 제천시"
function placeFromAddr(addr) {
  const parts = String(addr).replace(/^\d{5}\s*/, '').trim().split(/\s+/);
  if (!parts[0]) return '';
  return [SIDO_SHORT[parts[0]] || parts[0], parts[1] || ''].join(' ').trim();
}

async function fetchDetail(id) {
  const xml = await fetch(`${SENURI}/getJobInfo?serviceKey=${KEY}&id=${id}`).then(r => r.text());
  const it = parseItems(xml)[0];
  if (!it) throw new Error('상세 없음');
  const d = {
    addr: it.plDetAddr || '',
    phones: findPhones(Object.values(it).join(' ')),
    age: it.age || '', clerk: it.clerk || '', plbizNm: it.plbizNm || '',
    frAcptDd: it.frAcptDd || '', toAcptDd: it.toAcptDd || '', etcItm: it.etcItm || '',
  };
  details.set(id, d);
  return d;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// 캐시에 들어있는 공고 객체를 직접 채운다(참조 공유). 첫 응답을 막지 않도록 백그라운드에서 돈다.
// 상세 API가 몰아치면 실패하므로 조금씩 나눠서 요청하고, 실패한 건 다음 갱신 때 다시 시도한다.
async function enrichOpenJobs(jobs, { budget = 300, concurrency = 3, pauseMs = 120 } = {}) {
  const apply = (j, d) => {
    j.place = placeFromAddr(d.addr) || j.place;
    j.addr = d.addr;
    j.phones = d.phones;
  };
  for (const j of jobs) {
    const d = details.get(j.id);
    if (d) apply(j, d);
  }

  const todo = jobs
    .filter(j => j.src === 'senuri' && j.open && !details.has(j.id) && (detailFails.get(j.id) || 0) < 3)
    .slice(0, budget);
  if (!todo.length) return;

  let ok = 0;
  for (let i = 0; i < todo.length; i += concurrency) {
    await Promise.all(todo.slice(i, i + concurrency).map(j =>
      fetchDetail(j.id)
        .then(d => { apply(j, d); ok++; })
        .catch(() => detailFails.set(j.id, (detailFails.get(j.id) || 0) + 1))
    ));
    await sleep(pauseMs);
  }
  console.log(`상세 보강: ${ok}/${todo.length}건 성공 (누적 ${details.size}건)`);
}

async function fetchSenuri() {
  const pages = await Promise.all(
    Array.from({ length: PAGES }, (_, i) =>
      fetch(`${SENURI}/getJobList?serviceKey=${KEY}&numOfRows=1000&pageNo=${i + 1}`)
        .then(r => r.text())
        .catch(() => '')
    )
  );
  return pages.flatMap(parseItems).map(j => ({
    src: 'senuri',
    id: j.jobId,
    title: j.recrtTitle || '',
    org: j.oranNm || '',
    place: j.workPlcNm || '',          // 목록엔 대개 비어 있고, 상세 보강 단계에서 채워진다
    endDd: j.toDd || '',
    acpt: j.acptMthd || '',
    open: j.deadline === '접수중',
  }));
}

// ---------- 제천시청 고시·공고 ----------
// 사람을 뽑는 공고만 남긴다
const JOB_WORDS = /채용|구인|공공근로|기간제|근로자|일자리|(?:강사|요원|관리원|지도사|도우미|보조원|상담사|인력|직원|사원|인턴|기사|조무사|보호사)\s*(?:추가\s*)?(?:선발\s*)?(?:모집|채용)/;
// 일자리가 아닌데 '모집/채용' 단어만 겹치는 공고
const NOISE_WORDS = /합격자|면접\s*시행|최종\s*합격|결과\s*공고|선정\s*결과|취소\s*공고|입주자|당첨자|비자\s*사업|지역특화형|운영체|수탁|위탁\s*기관|공모전|입찰|교육생|수강생|참여자\s*모집\s*안내|임용시험|경력경쟁임용|공개경쟁임용|전입\s*희망|전입희망|서류전형\s*결과|적격자/;

// "접수기간 : 2026. 8. 10.(월) ~ 8. 14.(금) 18:00" 에서 마지막 날짜(마감일)를 뽑는다
function parseAcceptEnd(desc, fallbackYear) {
  const seg = desc.match(/(?:접수|신청|원서|공고|제출|모집)\s*(?:기간|기한|일정)\s*[:：]?\s*([^\n]{0,100})/);
  if (!seg) return '';
  const dates = [...seg[1].matchAll(/(?:(\d{4})\s*[.\-]\s*)?(\d{1,2})\s*[.\-]\s*(\d{1,2})\s*\.?/g)];
  if (!dates.length) return '';
  const last = dates[dates.length - 1];
  const y = last[1] || dates.find(d => d[1])?.[1] || fallbackYear;
  const mo = +last[2], dd = +last[3];
  if (mo < 1 || mo > 12 || dd < 1 || dd > 31) return '';
  return `${y}${String(mo).padStart(2, '0')}${String(dd).padStart(2, '0')}`;
}

function detectAcpt(desc) {
  if (/방문\s*접수/.test(desc)) return '방문';
  if (/이메일|메일\s*접수|온라인|누리집/.test(desc)) return '온라인';
  if (/등기|우편/.test(desc)) return '우편';
  return '';
}

// 시군을 추가하려면 여기에 한 줄 넣으면 된다.
// rss: 고시·공고 RSS 주소 / idFrom: 링크에서 글번호 뽑기 / viewUrl: 원문 주소 만들기
const CITIES = [
  {
    key: 'jecheon', prefix: 'jc', org: '제천시청', place: '충북 제천시',
    rss: 'https://www.jecheon.go.kr/rssBbsNtt.do?bbsNo=18',
    idFrom: link => (link.match(/nttNo=(\d+)/) || [])[1],
    viewUrl: id => `https://www.jecheon.go.kr/www/selectBbsNttView.do?bbsNo=18&key=5233&nttNo=${id}`,
  },
];

// 새올(eminwon) 고시공고 시스템을 쓰는 시군. RSS가 없는 대신
// "게재 중인 공고만" 골라 받을 수 있어서, 접수 마감된 공고가 애초에 안 넘어온다.
// 제천에서 통근 가능한 거리 순. host 만 추가하면 다른 시군도 바로 붙는다.
const EMINWON_CITIES = [
  { key: 'danyang',   prefix: 'dy',  org: '단양군청', place: '충북 단양군', host: 'eminwon.danyang.go.kr' },
  { key: 'chungju',   prefix: 'cj',  org: '충주시청', place: '충북 충주시', host: 'eminwon.chungju.go.kr' },
  { key: 'wonju',     prefix: 'wj',  org: '원주시청', place: '강원 원주시', host: 'eminwon.wonju.go.kr' },
  { key: 'yeongwol',  prefix: 'yw',  org: '영월군청', place: '강원 영월군', host: 'eminwon.yw.go.kr' },
  { key: 'yeongju',   prefix: 'yj',  org: '영주시청', place: '경북 영주시', host: 'eminwon.yeongju.go.kr' },
  { key: 'mungyeong', prefix: 'mg',  org: '문경시청', place: '경북 문경시', host: 'eminwon.gbmg.go.kr' },
  { key: 'eumseong',  prefix: 'es',  org: '음성군청', place: '충북 음성군', host: 'eminwon.eumseong.go.kr' },
  { key: 'jincheon',  prefix: 'jch', org: '진천군청', place: '충북 진천군', host: 'eminwon.jincheon.go.kr' },
  { key: 'goesan',    prefix: 'gs',  org: '괴산군청', place: '충북 괴산군', host: 'eminwon.goesan.go.kr' },
  { key: 'pyeongchang', prefix: 'pc', org: '평창군청', place: '강원 평창군', host: 'eminwon.pc.go.kr' },
  { key: 'jeongseon', prefix: 'jsn', org: '정선군청', place: '강원 정선군', host: 'eminwon.jeongseon.go.kr' },
];

// 한 번 받은 공고 상세는 바뀌지 않으므로 계속 재사용한다 (시군이 많아 매번 다시 받으면 부담이 크다)
const eminwonDetails = new Map();   // `${key}:${mgtNo}` -> { title, dept, person, body }

const stripTags = s => decodeXml(String(s).replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ''))
  .replace(/&nbsp;/g, ' ').replace(/[ \t]+/g, ' ').trim();

// 11개 시군을 동시에 부르다 보면 간헐적으로 접속이 실패한다 → 한 번 쉬었다 재시도
async function getText(url, retries = 2) {
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA } });
      return (await r.text()).replace(/^﻿/, '');   // eminwon 응답에는 BOM이 붙는다
    } catch (e) {
      if (i >= retries) throw e;
      await sleep(500 * (i + 1));
    }
  }
}

function eminwonUrls(host) {
  const base = `https://${host}/emwp/gov/mogaha/ntis/web/ofr/action/OfrAction.do`;
  const common = 'jndinm=OfrNotAncmtEJB&context=NTIS&homepage_pbs_yn=Y&subCheck=N';
  // list_gubun 을 빈 값으로 두면 '현재 게재 중'인 공고만 온다. 05 = 채용공고
  const list = codes =>
    `${base}?${common}&method=selectListOfrNotAncmt&methodnm=selectListOfrNotAncmtHomepage&countYn=Y&ofr_pageSize=100&pageIndex=1&list_gubun=&not_ancmt_se_code=${codes}`;
  return {
    list: list('05'),
    // 괴산처럼 채용공고를 05로 분류하지 않는 곳이 있어, 05가 비면 전체 분류에서 제목으로 골라낸다
    listAll: list('01,02,03,04,05'),
    view: id => `${base}?${common}&method=selectOfrNotAncmt&methodnm=selectOfrNotAncmtRegst&not_ancmt_mgt_no=${id}`,
  };
}

// 상세에서 전체 제목·담당자 연락처·본문을 가져온다 (목록 제목은 40자에서 잘린다)
function parseEminwonDetail(html) {
  const field = label => {
    const m = html.match(new RegExp(`>\\s*${label}\\s*</th>\\s*<td[^>]*>([\\s\\S]*?)</td>`));
    return m ? stripTags(m[1]) : '';
  };
  const bodyM = html.match(/<td style="word-break:break-all;" colspan="4">([\s\S]*?)<\/td>/);
  return {
    title: field('제목'),
    dept: field('담당부서'),
    person: field('담당자/연락처'),
    body: bodyM ? stripTags(bodyM[1]) : '',
  };
}

function parseEminwonRows(html, { titleFilter = false } = {}) {
  const rows = [];
  for (const tr of html.match(/<tr[^>]*>[\s\S]*?<\/tr>/g) || []) {
    const mgtNo = (tr.match(/searchDetail\('(\d+)'\)/) || [])[1];
    if (!mgtNo) continue;
    const tds = [...tr.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(m => stripTags(m[1]));
    const [, ancmtNo, listTitle, dept, regDd, period] = tds;
    if (!listTitle || NOISE_WORDS.test(listTitle)) continue;
    if (titleFilter && !JOB_WORDS.test(listTitle)) continue;
    rows.push({ mgtNo, ancmtNo, listTitle, dept, regDd, period });
  }
  return rows;
}

async function fetchEminwon(cfg) {
  const u = eminwonUrls(cfg.host);
  let rows = parseEminwonRows(await getText(u.list));
  // 채용공고 분류(05)가 비어 있는 시군은 전체 분류에서 제목으로 골라낸다
  if (!rows.length) rows = parseEminwonRows(await getText(u.listAll), { titleFilter: true });
  const today = ymd(new Date());

  const jobs = [];
  for (const r of rows) {                       // 보통 몇 건뿐이라 순차로 충분하다
    const ck = `${cfg.key}:${r.mgtNo}`;
    let detail = eminwonDetails.get(ck);
    if (!detail) {
      detail = { title: '', dept: '', person: '', body: '' };
      try {
        detail = parseEminwonDetail(await getText(u.view(r.mgtNo)));
        eminwonDetails.set(ck, detail);
      } catch (e) { /* 목록 정보로 진행 */ }
    }

    const title = detail.title || r.listTitle;
    if (NOISE_WORDS.test(title)) continue;

    // 게재기간 "2026-08-07 ~ 2026-08-14" 의 끝날짜가 사실상 접수 마감일
    const endDd = (period => {
      const m = String(period).match(/(\d{4})-(\d{2})-(\d{2})\s*~\s*(\d{4})-(\d{2})-(\d{2})/);
      return m ? m[4] + m[5] + m[6] : '';
    })(r.period);

    const desc = [detail.body, detail.person ? `문의: ${detail.person}` : ''].filter(Boolean).join('\n\n');
    const pubDd = String(r.regDd || '').replace(/-/g, '');

    jobs.push({
      src: cfg.key,
      id: cfg.prefix + r.mgtNo,
      title,
      org: cfg.org,
      place: cfg.place,
      endDd,
      acpt: detectAcpt(desc),
      // 게재기간이 비어 있는(몇 년째 상시 게시된) 공고가 섞여 있어, 그때는 등록일 기준 3주로 자른다
      open: endDd ? endDd >= today : (!!pubDd && daysBetween(pubDd, today) <= 21),
      desc: desc || '자세한 내용은 공고 원문을 확인해 주세요.',
      link: u.view(r.mgtNo),
      phones: findPhones(desc),
      pubDd,
      dept: r.dept || detail.dept || '',
    });
  }
  return jobs;
}

const cdata = (block, tag) => {
  const m = block.match(new RegExp(`<${tag}>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${tag}>`));
  return m ? m[1].trim() : '';
};

async function fetchCityRss(cfg) {
  const xml = await fetch(cfg.rss, { headers: { 'User-Agent': UA } }).then(r => r.text());
  const today = ymd(new Date());
  const jobs = [];

  for (const block of xml.match(/<item>[\s\S]*?<\/item>/g) || []) {
    const title = cdata(block, 'title');
    if (!title || !JOB_WORDS.test(title) || NOISE_WORDS.test(title)) continue;

    const postId = cfg.idFrom(cdata(block, 'link'));
    if (!postId) continue;

    const pubYmd = cdata(block, 'pubDate').replace(/[^\d]/g, '').slice(0, 8);
    const desc = decodeXml(
      cdata(block, 'description').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')
    ).trim();

    const endDd = parseAcceptEnd(desc, pubYmd.slice(0, 4) || String(new Date().getFullYear()));
    // 마감일이 적혀 있으면 그 날짜 기준, 없으면(첨부파일에만 있는 경우) 게시 후 3주간 노출
    const open = endDd ? endDd >= today : (!!pubYmd && daysBetween(pubYmd, today) <= 21);

    jobs.push({
      src: cfg.key,
      id: cfg.prefix + postId,
      title,
      org: cfg.org,
      place: cfg.place,
      endDd,
      acpt: detectAcpt(desc),
      open,
      desc,
      link: cfg.viewUrl(postId),
      phones: findPhones(desc),
      pubDd: pubYmd,
    });
  }
  return jobs;
}

const ALL_CITIES = [
  ...CITIES.map(c => ({ cfg: c, run: () => fetchCityRss(c) })),
  ...EMINWON_CITIES.map(c => ({ cfg: c, run: () => fetchEminwon(c) })),
];

const fetchCities = () => Promise.all(
  ALL_CITIES.map(({ cfg, run }) =>
    run().catch(e => { console.error(`${cfg.org} 수집 실패:`, e.message); return []; }))
).then(lists => lists.flat());

// ---------- 캐시 ----------
let cache = { at: 0, jobs: [] };
let refreshing = null;

function refresh() {
  if (refreshing) return refreshing;
  refreshing = Promise.all([
    fetchSenuri().catch(e => { console.error('노인일자리 수집 실패:', e.message); return []; }),
    fetchCities(),
  ]).then(([senuri, city]) => {
    const jobs = [...city, ...senuri];   // 지역 공고를 앞에
    if (jobs.length) {
      cache = { at: Date.now(), jobs };
      const byCity = ALL_CITIES.map(({ cfg }) => `${cfg.org} ${city.filter(j => j.src === cfg.key).length}건`).join(' · ');
      console.log(`수집 완료: ${byCity} · 노인일자리 ${senuri.length}건`);
      enrichOpenJobs(jobs).catch(e => console.error('상세 보강 실패:', e.message));
    }
    return cache.jobs;
  }).finally(() => { refreshing = null; });
  return refreshing;
}

// 캐시가 오래돼도 일단 있는 걸 바로 주고, 갱신은 뒤에서 (첫 방문 외에는 기다리지 않게)
async function getJobs() {
  if (!cache.jobs.length) return refresh();
  if (Date.now() - cache.at > CACHE_MS) refresh();
  return cache.jobs;
}

function json(res, code, data) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  try {
    if (url.pathname === '/api/jobs') {
      const q = (url.searchParams.get('q') || '').trim();
      const openOnly = url.searchParams.get('open') !== '0';
      let jobs = await getJobs();
      if (openOnly) jobs = jobs.filter(j => j.open);
      if (q) {
        const terms = q.split(/\s+/);
        jobs = jobs.filter(j => terms.every(t =>
          j.place.includes(t) || j.title.includes(t) || j.org.includes(t) || (j.addr || '').includes(t)));
      }
      return json(res, 200, {
        total: jobs.length,
        counts: {
          city: jobs.filter(j => j.src !== 'senuri').length,
          senuri: jobs.filter(j => j.src === 'senuri').length,
        },
        jobs: jobs.slice(0, 200),
      });
    }

    if (url.pathname === '/api/job') {
      const id = url.searchParams.get('id');
      if (!id || !/^[A-Za-z0-9]+$/.test(id)) return json(res, 400, { error: 'bad id' });

      // 시청 공고는 목록에 이미 본문이 들어있다
      const cached = (await getJobs()).find(j => j.id === id);
      if (cached && cached.src !== 'senuri') return json(res, 200, { job: cached });

      // 노인일자리는 보강 단계에서 이미 받아둔 상세를 쓰고, 없으면 그때 받는다
      const d = details.get(id) || await fetchDetail(id).catch(() => null);
      if (!d) return json(res, 200, { job: null });
      return json(res, 200, {
        job: {
          src: 'senuri',
          plDetAddr: d.addr, plbizNm: d.plbizNm, clerk: d.clerk, age: d.age,
          frAcptDd: d.frAcptDd, toAcptDd: d.toAcptDd, etcItm: d.etcItm, phones: d.phones,
        },
      });
    }

    // 정적 파일
    let file = url.pathname === '/' ? '/index.html' : url.pathname;
    file = path.normalize(file).replace(/^(\.\.[/\\])+/, '');
    const full = path.join(__dirname, 'public', file);
    if (full.startsWith(path.join(__dirname, 'public')) && fs.existsSync(full) && fs.statSync(full).isFile()) {
      res.writeHead(200, { 'Content-Type': (MIME[path.extname(full)] || 'application/octet-stream') + '; charset=utf-8' });
      return res.end(fs.readFileSync(full));
    }
    res.writeHead(404); res.end('Not Found');
  } catch (e) {
    console.error(e);
    json(res, 500, { error: '서버 오류' });
  }
});

server.listen(PORT, () => {
  console.log(`일자리 알리미 서버 실행: http://localhost:${PORT}`);
  refresh();                              // 시작하자마자 미리 받아둔다
  setInterval(refresh, CACHE_MS);         // 이후 10분마다 갱신
});
