const {test}=require('node:test');
const assert=require('node:assert/strict');
const {collectBatches}=require('./lib/collection.cjs');
const options={sleep:async()=>{}};
test('network outage stops after six municipalities, without pretending success',async()=>{
 let calls=0;const result=await collectBatches(Array.from({length:92},()=>({run:async()=>{calls++;throw Error('timeout');}})),options);
 assert.equal(calls,6);assert.equal(result.aborted,true);assert.equal(result.out.length,0);
});
test('valid empty lists do not trigger outage breaker',async()=>{
 const r=await collectBatches(Array.from({length:12},()=>({run:async()=>[]})),options);
 assert.equal(r.aborted,false);assert.equal(r.attempted,12);
});
test('partial failures retain successful jobs and identify retry targets',async()=>{
 const bad={run:async()=>{throw Error('HTTP 503');}};
 const r=await collectBatches([{run:async()=>['job']},bad,{run:async()=>['other']}],options);
 assert.deepEqual(r.out,['job','other']);assert.deepEqual(r.failed,[bad]);assert.equal(r.aborted,false);
});
test('default scheduling never overlaps city requests',async()=>{
 let active=0,max=0;const r=await collectBatches(Array.from({length:8},()=>({run:async()=>{max=Math.max(max,++active);await new Promise(r=>setTimeout(r,1));active--;return [];}})),options);
 assert.equal(max,1);assert.equal(r.attempted,8);
});
