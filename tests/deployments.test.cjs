'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {records,gates,sha,MAX_AGE_MS}=require('../app/public/deployments');
const commit='a'.repeat(40);
const health={status:'ok',appliance:'Local AI',releaseCommit:commit};
test('only a valid appliance report supplies a revision; never borrows it for another workstream',()=>{
 const rows=records(health,1000,2000);
 assert.equal(rows[0].deployedSha,commit);assert.equal(rows[0].evidence,'fresh');
 assert.ok(rows.slice(1).every(r=>r.deployedSha===null&&r.evidence==='unconnected'));
 assert.ok(rows.every(r=>r.sourceSha===null&&r.mergedSha===null&&r.artifact===null&&r.runtime==='Unknown'));
});
test('health success does not prove CI, merge, artifact, runtime or physical acceptance',()=>{
 const local=gates(records(health,1000,2000)[0]);
 assert.equal(local.find(g=>g[0]==='Deployed')[1],'reported');
 assert.ok(local.filter(g=>!['Deployed','Physical Acceptance'].includes(g[0])).every(g=>g[1]==='unknown'));
 assert.equal(gates(records(health,1000,2000)[1]).at(-1)[1],'unknown');
});
test('expired or future observations cannot establish a current deployment',()=>{
 for(const observed of [null,NaN,Infinity,2001,2000-MAX_AGE_MS-1]){
  const record=records(health,observed,2000)[0];assert.equal(record.evidence,'stale');
  assert.equal(gates(record).find(g=>g[0]==='Deployed')[1],'unknown');
 }
 assert.equal(records(health,2000-MAX_AGE_MS,2000)[0].evidence,'fresh');
});
test('malformed health and non-exact SHAs stay unknown',()=>{
 for(const h of [null,{},[],{...health,status:'error'},{...health,appliance:'other'}])assert.equal(records(h,1000,2000)[0].deployedSha,null);
 for(const value of [null,123,'abcdef0','<script>','a'.repeat(41)])assert.equal(sha(value),null);
 assert.equal(sha('A'.repeat(40)),commit);
 assert.equal(gates(records({...health,releaseCommit:'bad'},1000,2000)[0]).find(g=>g[0]==='Deployed')[1],'unknown');
});
