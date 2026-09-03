// 새올 시군 사이트에 하나씩 붙어보고, 실패하면 진짜 이유(e.cause)까지 찍는다.
// 크롤러 본체는 'fetch failed'만 찍어서 원인을 알 수 없었다.
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const hosts = [...src.matchAll(/host:\s*'([^']+)'/g)].map(m => m[1]);
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const why = (e) => {
  const parts = [];
  let c = e;
  while (c) { parts.push(`${c.name || ''}:${c.message || ''}${c.code ? '(' + c.code + ')' : ''}`); c = c.cause; }
  return parts.join(' ← ');
};

async function probe(host) {
  const url = `https://${host}/emwp/gov/mogaha/ntis/web/ofr/action/OfrAction.do`
    + '?jndinm=OfrNotAncmtEJB&context=NTIS&homepage_pbs_yn=Y&subCheck=N'
    + '&method=selectListOfrNotAncmt&methodnm=selectListOfrNotAncmtHomepage'
    + '&countYn=Y&ofr_pageSize=100&pageIndex=1&list_gubun=&not_ancmt_se_code=05';
  const t0 = Date.now();
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20000) });
    const body = await r.text();
    return { host, ok: true, status: r.status, ms: Date.now() - t0, bytes: body.length };
  } catch (e) {
    return { host, ok: false, ms: Date.now() - t0, why: why(e) };
  }
}

// 한 번에 하나씩(동시성 없이) 재서, 동시 접속 때문인지 아닌지 가른다
const results = [];
for (const h of hosts) results.push(await probe(h));

const ok = results.filter(r => r.ok);
const bad = results.filter(r => !r.ok);
console.log(`\n===== 결과: 성공 ${ok.length} / 실패 ${bad.length} (전체 ${results.length}) =====\n`);
console.log('-- 성공 --');
for (const r of ok) console.log(`  ${r.status}  ${String(r.ms).padStart(6)}ms  ${String(r.bytes).padStart(7)}B  ${r.host}`);
console.log('\n-- 실패 --');
for (const r of bad) console.log(`  ${String(r.ms).padStart(6)}ms  ${r.host}\n          ${r.why}`);

const reasons = {};
for (const r of bad) { const k = r.why.split(' ← ').pop(); reasons[k] = (reasons[k] || 0) + 1; }
console.log('\n-- 실패 사유별 --');
for (const [k, v] of Object.entries(reasons).sort((a, b) => b[1] - a[1])) console.log(`  ${v}건  ${k}`);
