// An incomplete page set must never be published as an empty successful source.
async function fetchPages(fetchPage,{pages=10,concurrency=2}={}){
 const out=[];
 for(let i=0;i<pages;i+=concurrency){
  const batch=await Promise.all(Array.from({length:Math.min(concurrency,pages-i)},async(_,n)=>{
   const xml=await fetchPage(i+n+1);
   if(!/<resultCode>00<\/resultCode>/.test(xml)||!/<items(?:>|\s*\/)/.test(xml))throw Error('노인일자리 API 응답 오류 — 기존 자료 유지');
   return xml;
  }));out.push(...batch);
 }
 if(!out.some(x=>/<item>/.test(x)))throw Error('노인일자리 전체 0건 — 기존 자료 유지');
 return out;
}
module.exports={fetchPages};
