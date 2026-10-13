// Bound requests and stop a whole-network outage before probing every municipality.
async function collectBatches(targets, {concurrency=1, outageThreshold=6, pauseMs=300, onError=()=>{}, sleep=ms=>new Promise(r=>setTimeout(r,ms))}={}) {
  const out=[],failed=[]; let successes=0,attempted=0;
  for(let i=0;i<targets.length;i+=concurrency){
    const part=targets.slice(i,i+concurrency);
    await Promise.all(part.map(async t=>{attempted++;try{out.push(...await t.run());successes++;}catch(e){failed.push(t);onError(t,e);}}));
    // A valid empty response counts as success. Never confuse 'no jobs' with a network failure.
    if(!successes && attempted>=outageThreshold && i+concurrency<targets.length)
      return {out,failed,aborted:true,attempted};
    if(i+concurrency<targets.length)await sleep(pauseMs);
  }
  return {out,failed,aborted:false,attempted};
}
module.exports={collectBatches};
