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
// 전국 91개 시군을 돌기 때문에, 시군 한 곳당 보는 공고 수와 동시 요청 수를 묶어둔다.
// (묶지 않으면 상세 요청이 수천 건이 되어 수집이 끝나지 않는다)
const MAX_ROWS_PER_CITY = Number(process.env.MAX_ROWS_PER_CITY || 40);
// 6이었는데 2026-09-04에 6이 원인이라는 게 실측으로 나왔다.
//   미국 러너에서 순차로 두드리면 91곳 중 12곳 실패 (한국에서 잰 것과 같다)
//   같은 러너에서 동시 6으로 두드리면            60곳 실패
// 위치 문제가 아니라 한꺼번에 세게 두드리는 게 문제다. 새올 시군들은 IP가 달라도
// 27.101.x / 152.99.x 같은 정부 공용 대역에 몰려 있어, 한 관문에서 보면
// 한 곳에서 쏟아지는 것으로 보인다(정황 추론).
const CITY_CONCURRENCY  = Number(process.env.CITY_CONCURRENCY  || 3);
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
  // 노인일자리 API가 실제로 내려주는 값. 함평군·광산구가 모두 이 이름으로 오는데,
  // 시군청 공고 쪽은 '전남 ○○'으로 오므로 지역 필터가 갈라지지 않게 '전남'으로 맞춘다.
  전남광주통합특별시: '전남',
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
  // --- 초기 11곳 (prefix는 기존 공고 ID 유지를 위해 그대로 둔다) ---
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
  // --- 전국 확대분 80곳 (2026-08-25, DNS+실제 목록 파싱으로 검증) ---
  { key: 'ansan', prefix: 'ansan', org: '안산시청', place: '경기 안산시', host: 'eminwon.ansan.go.kr' },
  { key: 'anseong', prefix: 'anseong', org: '안성시청', place: '경기 안성시', host: 'eminwon.anseong.go.kr' },
  { key: 'anyang', prefix: 'anyang', org: '안양시청', place: '경기 안양시', host: 'eminwon.anyang.go.kr' },
  { key: 'asan', prefix: 'asan', org: '아산시청', place: '충남 아산시', host: 'eminwon.asan.go.kr' },
  { key: 'boeun', prefix: 'boeun', org: '보은군청', place: '충북 보은군', host: 'eminwon.boeun.go.kr' },
  { key: 'boseong', prefix: 'boseong', org: '보성군청', place: '전남 보성군', host: 'eminwon.boseong.go.kr' },
  { key: 'buan', prefix: 'buan', org: '부안군청', place: '전북 부안군', host: 'eminwon.buan.go.kr' },
  { key: 'buyeo', prefix: 'buyeo', org: '부여군청', place: '충남 부여군', host: 'eminwon.buyeo.go.kr' },
  { key: 'changwon', prefix: 'changwon', org: '창원시청', place: '경남 창원시', host: 'eminwon.changwon.go.kr' },
  { key: 'cheongdo', prefix: 'cheongdo', org: '청도군청', place: '경북 청도군', host: 'eminwon.cheongdo.go.kr' },
  { key: 'cheongyang', prefix: 'cheongyang', org: '청양군청', place: '충남 청양군', host: 'eminwon.cheongyang.go.kr' },
  { key: 'dangjin', prefix: 'dangjin', org: '당진시청', place: '충남 당진시', host: 'eminwon.dangjin.go.kr' },
  { key: 'gangjin', prefix: 'gangjin', org: '강진군청', place: '전남 강진군', host: 'eminwon.gangjin.go.kr' },
  { key: 'gangneung', prefix: 'gangneung', org: '강릉시청', place: '강원 강릉시', host: 'eminwon.gangneung.go.kr' },
  { key: 'geochang', prefix: 'geochang', org: '거창군청', place: '경남 거창군', host: 'eminwon.geochang.go.kr' },
  { key: 'gimje', prefix: 'gimje', org: '김제시청', place: '전북 김제시', host: 'eminwon.gimje.go.kr' },
  { key: 'gjcity', prefix: 'gjcity', org: '광주시청', place: '경기 광주시', host: 'eminwon.gjcity.go.kr' },
  { key: 'goheung', prefix: 'goheung', org: '고흥군청', place: '전남 고흥군', host: 'eminwon.goheung.go.kr' },
  { key: 'gongju', prefix: 'gongju', org: '공주시청', place: '충남 공주시', host: 'eminwon.gongju.go.kr' },
  { key: 'goryeong', prefix: 'goryeong', org: '고령군청', place: '경북 고령군', host: 'eminwon.goryeong.go.kr' },
  { key: 'goyang', prefix: 'goyang', org: '고양시청', place: '경기 고양시', host: 'eminwon.goyang.go.kr' },
  { key: 'gunpo', prefix: 'gunpo', org: '군포시청', place: '경기 군포시', host: 'eminwon.gunpo.go.kr' },
  { key: 'gunsan', prefix: 'gunsan', org: '군산시청', place: '전북 군산시', host: 'eminwon.gunsan.go.kr' },
  { key: 'gunwi', prefix: 'gunwi', org: '군위군청', place: '대구 군위군', host: 'eminwon.gunwi.go.kr' },
  { key: 'guri', prefix: 'guri', org: '구리시청', place: '경기 구리시', host: 'eminwon.guri.go.kr' },
  { key: 'gurye', prefix: 'gurye', org: '구례군청', place: '전남 구례군', host: 'eminwon.gurye.go.kr' },
  { key: 'gwangyang', prefix: 'gwangyang', org: '광양시청', place: '전남 광양시', host: 'eminwon.gwangyang.go.kr' },
  { key: 'gwgs', prefix: 'gwgs', org: '고성군청', place: '강원 고성군', host: 'eminwon.gwgs.go.kr' },
  { key: 'gyeryong', prefix: 'gyeryong', org: '계룡시청', place: '충남 계룡시', host: 'eminwon.gyeryong.go.kr' },
  { key: 'hadong', prefix: 'hadong', org: '하동군청', place: '경남 하동군', host: 'eminwon.hadong.go.kr' },
  { key: 'haenam', prefix: 'haenam', org: '해남군청', place: '전남 해남군', host: 'eminwon.haenam.go.kr' },
  { key: 'haman', prefix: 'haman', org: '함안군청', place: '경남 함안군', host: 'eminwon.haman.go.kr' },
  { key: 'hampyeong', prefix: 'hampyeong', org: '함평군청', place: '전남 함평군', host: 'eminwon.hampyeong.go.kr' },
  { key: 'hanam', prefix: 'hanam', org: '하남시청', place: '경기 하남시', host: 'eminwon.hanam.go.kr' },
  { key: 'hongcheon', prefix: 'hongcheon', org: '홍천군청', place: '강원 홍천군', host: 'eminwon.hongcheon.go.kr' },
  { key: 'hongseong', prefix: 'hongseong', org: '홍성군청', place: '충남 홍성군', host: 'eminwon.hongseong.go.kr' },
  { key: 'hwasun', prefix: 'hwasun', org: '화순군청', place: '전남 화순군', host: 'eminwon.hwasun.go.kr' },
  { key: 'icheon', prefix: 'icheon', org: '이천시청', place: '경기 이천시', host: 'eminwon.icheon.go.kr' },
  { key: 'iksan', prefix: 'iksan', org: '익산시청', place: '전북 익산시', host: 'eminwon.iksan.go.kr' },
  { key: 'imsil', prefix: 'imsil', org: '임실군청', place: '전북 임실군', host: 'eminwon.imsil.go.kr' },
  { key: 'jangheung', prefix: 'jangheung', org: '장흥군청', place: '전남 장흥군', host: 'eminwon.jangheung.go.kr' },
  { key: 'jangseong', prefix: 'jangseong', org: '장성군청', place: '전남 장성군', host: 'eminwon.jangseong.go.kr' },
  { key: 'jangsu', prefix: 'jangsu', org: '장수군청', place: '전북 장수군', host: 'eminwon.jangsu.go.kr' },
  { key: 'jeongeup', prefix: 'jeongeup', org: '정읍시청', place: '전북 정읍시', host: 'eminwon.jeongeup.go.kr' },
  { key: 'jinan', prefix: 'jinan', org: '진안군청', place: '전북 진안군', host: 'eminwon.jinan.go.kr' },
  { key: 'jindo', prefix: 'jindo', org: '진도군청', place: '전남 진도군', host: 'eminwon.jindo.go.kr' },
  { key: 'miryang', prefix: 'miryang', org: '밀양시청', place: '경남 밀양시', host: 'eminwon.miryang.go.kr' },
  { key: 'mokpo', prefix: 'mokpo', org: '목포시청', place: '전남 목포시', host: 'eminwon.mokpo.go.kr' },
  { key: 'muan', prefix: 'muan', org: '무안군청', place: '전남 무안군', host: 'eminwon.muan.go.kr' },
  { key: 'muju', prefix: 'muju', org: '무주군청', place: '전북 무주군', host: 'eminwon.muju.go.kr' },
  { key: 'naju', prefix: 'naju', org: '나주시청', place: '전남 나주시', host: 'eminwon.naju.go.kr' },
  { key: 'namhae', prefix: 'namhae', org: '남해군청', place: '경남 남해군', host: 'eminwon.namhae.go.kr' },
  { key: 'namwon', prefix: 'namwon', org: '남원시청', place: '전북 남원시', host: 'eminwon.namwon.go.kr' },
  { key: 'osan', prefix: 'osan', org: '오산시청', place: '경기 오산시', host: 'eminwon.osan.go.kr' },
  { key: 'paju', prefix: 'paju', org: '파주시청', place: '경기 파주시', host: 'eminwon.paju.go.kr' },
  { key: 'sancheong', prefix: 'sancheong', org: '산청군청', place: '경남 산청군', host: 'eminwon.sancheong.go.kr' },
  { key: 'sangju', prefix: 'sangju', org: '상주시청', place: '경북 상주시', host: 'eminwon.sangju.go.kr' },
  { key: 'seocheon', prefix: 'seocheon', org: '서천군청', place: '충남 서천군', host: 'eminwon.seocheon.go.kr' },
  { key: 'seogwipo', prefix: 'seogwipo', org: '서귀포시청', place: '제주 서귀포시', host: 'eminwon.seogwipo.go.kr' },
  { key: 'seosan', prefix: 'seosan', org: '서산시청', place: '충남 서산시', host: 'eminwon.seosan.go.kr' },
  { key: 'shinan', prefix: 'shinan', org: '신안군청', place: '전남 신안군', host: 'eminwon.shinan.go.kr' },
  { key: 'siheung', prefix: 'siheung', org: '시흥시청', place: '경기 시흥시', host: 'eminwon.siheung.go.kr' },
  { key: 'suncheon', prefix: 'suncheon', org: '순천시청', place: '전남 순천시', host: 'eminwon.suncheon.go.kr' },
  { key: 'suwon', prefix: 'suwon', org: '수원시청', place: '경기 수원시', host: 'eminwon.suwon.go.kr' },
  { key: 'taean', prefix: 'taean', org: '태안군청', place: '충남 태안군', host: 'eminwon.taean.go.kr' },
  { key: 'uiryeong', prefix: 'uiryeong', org: '의령군청', place: '경남 의령군', host: 'eminwon.uiryeong.go.kr' },
  { key: 'uiwang', prefix: 'uiwang', org: '의왕시청', place: '경기 의왕시', host: 'eminwon.uiwang.go.kr' },
  { key: 'uljin', prefix: 'uljin', org: '울진군청', place: '경북 울진군', host: 'eminwon.uljin.go.kr' },
  { key: 'ulleung', prefix: 'ulleung', org: '울릉군청', place: '경북 울릉군', host: 'eminwon.ulleung.go.kr' },
  { key: 'wando', prefix: 'wando', org: '완도군청', place: '전남 완도군', host: 'eminwon.wando.go.kr' },
  { key: 'wanju', prefix: 'wanju', org: '완주군청', place: '전북 완주군', host: 'eminwon.wanju.go.kr' },
  { key: 'yanggu', prefix: 'yanggu', org: '양구군청', place: '강원 양구군', host: 'eminwon.yanggu.go.kr' },
  { key: 'yangju', prefix: 'yangju', org: '양주시청', place: '경기 양주시', host: 'eminwon.yangju.go.kr' },
  { key: 'yangyang', prefix: 'yangyang', org: '양양군청', place: '강원 양양군', host: 'eminwon.yangyang.go.kr' },
  { key: 'yeoju', prefix: 'yeoju', org: '여주시청', place: '경기 여주시', host: 'eminwon.yeoju.go.kr' },
  { key: 'yeoncheon', prefix: 'yeoncheon', org: '연천군청', place: '경기 연천군', host: 'eminwon.yeoncheon.go.kr' },
  { key: 'yeongam', prefix: 'yeongam', org: '영암군청', place: '전남 영암군', host: 'eminwon.yeongam.go.kr' },
  { key: 'yesan', prefix: 'yesan', org: '예산군청', place: '충남 예산군', host: 'eminwon.yesan.go.kr' },
  { key: 'yongin', prefix: 'yongin', org: '용인시청', place: '경기 용인시', host: 'eminwon.yongin.go.kr' },
  { key: 'yp21', prefix: 'yp21', org: '양평군청', place: '경기 양평군', host: 'eminwon.yp21.go.kr' },
];

// 한 번 받은 공고 상세는 바뀌지 않으므로 계속 재사용한다 (시군이 많아 매번 다시 받으면 부담이 크다)
const eminwonDetails = new Map();   // `${key}:${mgtNo}` -> { title, dept, person, body }

const stripTags = s => decodeXml(String(s).replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ''))
  .replace(/&nbsp;/g, ' ').replace(/[ \t]+/g, ' ').trim();

// 동시에 여러 시군을 부르다 보면 간헐적으로 접속이 실패한다 → 한 번 쉬었다 재시도.
//
// ⚠️ 시간 제한이 반드시 있어야 한다. node의 fetch는 그냥 두면 기다리는 시간에 끝이 없어서,
// 응답 없는 시군 하나가 배치 전체를 붙잡는다(Promise.all은 제일 느린 하나를 기다린다).
// 2026-09-04 실측: 91곳 중 17곳이 아예 응답을 안 했고, 그 탓에 한 회 수집이
// 8.7분 → 26.4분으로 늘어 있었다.
const FETCH_TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS || 15000);

async function getText(url, retries = 2) {
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(url, {
        headers: { 'User-Agent': UA },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      return (await r.text()).replace(/^﻿/, '');   // eminwon 응답에는 BOM이 붙는다
    } catch (e) {
      if (i >= retries) throw e;
      await sleep(500 * (i + 1));
    }
  }
}

// fetch가 실패하면 node는 'fetch failed'라고만 한다. 진짜 이유는 cause에 들어 있어서
// 그걸 안 펴면 로그만 보고는 원인을 알 수 없다(타임아웃인지 DNS인지 인증서인지).
function whyFailed(e) {
  const parts = [];
  for (let c = e; c; c = c.cause) {
    parts.push(`${c.name || 'Error'}: ${c.message || ''}${c.code ? ` (${c.code})` : ''}`);
  }
  return parts.join(' ← ');
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
  // 상세 페이지는 한 건당 요청 1회다. 목록 제목만 보고 공고가 아닌 글을 먼저 버리고,
  // 최근 MAX_ROWS_PER_CITY건까지만 본다.
  const targets = rows.filter(r => !NOISE_WORDS.test(r.listTitle || '')).slice(0, MAX_ROWS_PER_CITY);
  for (const r of targets) {
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

// 실패는 그때그때 다른 시군에서 난다 — 막힌 게 아니라 그 순간 응답이 없는 것이다.
// 2026-09-04 실측: 같은 자리(한국)에서 두 번 재니 실패한 곳이 17곳 → 12곳으로 바뀌었고
// 겹치지도 않았다. 그래서 한 바퀴 다 돌고 실패한 곳만 다시 한 번 간다.
// 한 바퀴 쉬었다 가므로 상대 서버가 숨 돌릴 틈도 생긴다.
async function fetchCitiesOnce(targets, label) {
  const out = [];
  const failed = [];
  for (let i = 0; i < targets.length; i += CITY_CONCURRENCY) {
    const part = targets.slice(i, i + CITY_CONCURRENCY);
    const lists = await Promise.all(part.map(t =>
      t.run().catch(e => {
        console.error(`${label}${t.cfg.org} 수집 실패:`, whyFailed(e));
        failed.push(t);
        return [];
      })));
    out.push(...lists.flat());
  }
  return { out, failed };
}

// 재시도는 점점 더 오래 쉬었다 간다.
// 2026-09-04 실측: 5초만 쉬고 한 번 더 가니 한국에선 5곳 중 3곳을 건졌는데
// 미국 러너에선 16곳 중 2곳뿐이었다. 상대가 조인 거라면 더 기다려야 풀린다.
// 재시도는 실패한 곳만 도는 거라 한 바퀴가 짧다 — 넉넉히 쉬어도 손해가 작다.
const RETRY_WAITS_MS = [15000, 45000];

async function fetchCities() {
  const first = await fetchCitiesOnce(ALL_CITIES, '');
  const jobs = first.out;
  let remaining = first.failed;

  for (let round = 0; round < RETRY_WAITS_MS.length && remaining.length; round++) {
    const wait = RETRY_WAITS_MS[round];
    console.error(`\n${round === 0 ? '1차' : `재시도 ${round}차`}에서 ${remaining.length}곳 실패`
      + ` → ${wait / 1000}초 쉬고 다시 시도한다`);
    await sleep(wait);
    const again = await fetchCitiesOnce(remaining, `[재시도 ${round + 1}차] `);
    jobs.push(...again.out);
    console.error(`재시도 ${round + 1}차: ${remaining.length - again.failed.length}곳 건졌다`);
    remaining = again.failed;
  }

  if (remaining.length) {
    console.error(`\n끝내 실패: ${remaining.length}곳 —`, remaining.map(t => t.cfg.org).join(' '));
  } else if (first.failed.length) {
    console.error('\n재시도로 전부 건졌다');
  }
  return jobs;
}

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
      const hit = ALL_CITIES
        .map(({ cfg }) => [cfg.org, city.filter(j => j.src === cfg.key).length])
        .filter(([, n]) => n > 0);
      console.log(`수집 완료: 시군 ${hit.length}/${ALL_CITIES.length}곳에서 ${city.length}건 · 노인일자리 ${senuri.length}건`);
      console.log('  ' + hit.map(([o, n]) => `${o} ${n}`).join(' · '));
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

// ---------- 수집 전용 모드 ----------
// GitHub Actions가 `CRAWL_OUT=jobs.json node server.js` 로 돌린다.
// 서버를 띄우지 않고 한 번만 수집해서 결과 JSON을 파일로 남기고 끝낸다.
// 진행 로그는 stderr로 보내 결과 파일을 더럽히지 않는다.
async function crawlOnce(outPath, prevPath) {
  const t0 = Date.now();

  // 지난번 결과가 있으면 상세 내용을 물려받는다.
  // 상세 페이지는 공고 하나당 요청 1회라, 새로 올라온 공고만 받으면 요청이 크게 줄어든다.
  let seeded = 0;
  let prevCityCount = 0;
  if (prevPath && fs.existsSync(prevPath)) {
    try {
      const prev = JSON.parse(fs.readFileSync(prevPath, 'utf-8'));
      for (const [id, d] of Object.entries(prev.senuriDetails || {})) { details.set(id, d); seeded++; }
      for (const [ck, d] of Object.entries(prev.eminwonDetails || {})) { eminwonDetails.set(ck, d); seeded++; }
      console.error(`이전 결과에서 상세 ${seeded}건 물려받음`);
      prevCityCount = new Set((prev.jobs || []).filter(j => j.src !== 'senuri').map(j => j.src)).size;
      if (prevCityCount) console.error(`직전 회차의 시군 수: ${prevCityCount}곳`);
    } catch (e) { console.error('이전 결과 읽기 실패(무시하고 새로 받음):', e.message); }
  }

  const [senuri, city] = await Promise.all([
    fetchSenuri().catch(e => { console.error('노인일자리 수집 실패:', e.message); return []; }),
    fetchCities(),
  ]);
  const jobs = [...city, ...senuri];
  if (!jobs.length) throw new Error('수집 결과가 0건이다 — 기존 데이터를 덮어쓰지 않는다');

  // 0건만 막는 걸로는 모자랐다. 2026-09-03 회차는 91곳 중 60곳이 실패했는데도
  // "성공"으로 끝나서, 공고 있는 시군이 78곳 → 30곳으로 쪼그라든 데이터가 그대로 올라갔다.
  // 직전 회차의 절반도 못 미치면 이번 결과는 버리고 기존 데이터를 지킨다.
  const cityCount = new Set(city.map(j => j.src)).size;
  if (prevCityCount && cityCount < prevCityCount * 0.5) {
    throw new Error(
      `수집된 시군이 ${cityCount}곳뿐이다 (직전 ${prevCityCount}곳의 절반 미만) — ` +
      '이번 결과는 버리고 기존 데이터를 지킨다');
  }

  // 노인일자리는 목록에 근무지·연락처가 비어 있어 상세를 받아야 쓸모가 있다.
  // 액션은 시간 여유가 있으니 로컬 기본값(300건)보다 넉넉히 받는다.
  await enrichOpenJobs(jobs, { budget: 800, concurrency: 4, pauseMs: 120 }).catch(e =>
    console.error('상세 보강 실패(목록만으로 진행):', e.message));

  const openCount = jobs.filter(j => j.open).length;
  const payload = {
    at: new Date().toISOString(),
    jobs,
    senuriDetails: Object.fromEntries(details),
    eminwonDetails: Object.fromEntries(eminwonDetails),
    stats: {
      total: jobs.length, open: openCount,
      city: city.length, senuri: senuri.length,
      cities: ALL_CITIES.length,
      citiesWithJobs: ALL_CITIES.filter(({ cfg }) => city.some(j => j.src === cfg.key)).length,
      tookSec: Math.round((Date.now() - t0) / 1000),
    },
  };
  fs.writeFileSync(outPath, JSON.stringify(payload));
  const mb = (fs.statSync(outPath).size / 1048576).toFixed(2);
  console.error(`\n저장: ${outPath} (${mb} MB)`);
  console.error(JSON.stringify(payload.stats));
}

if (process.env.CRAWL_OUT) {
  crawlOnce(process.env.CRAWL_OUT, process.env.CRAWL_PREV)
    .then(() => process.exit(0))
    .catch(e => { console.error('수집 실패:', e); process.exit(1); });
} else {
  server.listen(PORT, () => {
    console.log(`일자리 알리미 서버 실행: http://localhost:${PORT}`);
    refresh();                              // 시작하자마자 미리 받아둔다
    setInterval(refresh, CACHE_MS);         // 이후 10분마다 갱신
  });
}
