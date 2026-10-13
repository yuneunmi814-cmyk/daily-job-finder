import {test} from 'node:test';
import assert from 'node:assert/strict';
import worker from './src/worker.mjs';
const data={at:'2026-10-13T02:00:00Z',jobs:[
 {id:'soon',open:true,endDd:'20990101',pubDd:'20261001',place:'서울',src:'city'},
 {id:'new',open:true,endDd:'20990201',pubDd:'20261013',place:'서울',src:'city'},
 {id:'expired',open:true,endDd:'20000101',pubDd:'20261013',place:'서울',src:'city'},
 {id:'unknown',open:true,endDd:'20990115',place:'서울',src:'city'}]};
const env={JOBS:{get:async()=>structuredClone(data)}};
test('default deadlines remain unchanged; recent mode excludes expired and prefers new posts',async()=>{
 const load=async query=>(await worker.fetch(new Request('https://example.org/api/jobs'+query),env)).json();
 const d=await load('');assert.deepEqual(d.jobs.map(j=>j.id),['soon','unknown','new']);assert.equal(d.order,'deadline');
 const r=await load('?sort=recent');assert.deepEqual(r.jobs.map(j=>j.id),['new','soon','unknown']);assert.equal(r.updatedAt,data.at);assert.equal(r.total,3);
});
