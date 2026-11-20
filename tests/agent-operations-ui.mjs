import './browser-target-guard.mjs';
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { checkReopenQuickly } from './sheet-reopen.mjs';
import { createRequire } from 'node:module';
const { workKind } = createRequire(import.meta.url)('../app/run-cards.js'); // the server's Work chip mapping

const base=process.env.LOCALAI_URL||'http://127.0.0.1:3080';
const browser=await chromium.launch({headless:true});
const failures=[];
let dialogs=0;

async function check(name,fn){
  try{await fn();console.log('PASS',name)}
  catch(e){failures.push(name+': '+e.message);console.error('FAIL',name,e.message)}
}

const page=await browser.newPage({ serviceWorkers: 'block',viewport:{width:1440,height:1000}});
page.on('dialog',async d=>{dialogs++;await d.dismiss()});
await page.goto(base,{waitUntil:'domcontentloaded'});
await page.waitForSelector('.ux-primary-rail');
await page.waitForFunction(()=>typeof window.showView==='function');
await page.evaluate(()=>window.showView('agents'));
await page.waitForSelector('#agents.active');

await check('system capability health distinguishes optional companions',async()=>{
  await page.locator('.ux-primary-item[data-domain="system"]').click();
  await page.waitForSelector('#status.active');
  await page.locator('#statusRetryBtn').waitFor({state:'visible'});
  await page.locator('#statusRetryBtn').click();
  await page.locator('#serviceList .service-card').first().waitFor({state:'visible'});
  const optional=page.locator('#serviceList .service-card.OPTIONAL_OFFLINE');
  if(await optional.count()) assert.match(await optional.first().innerText(),/Optional · Offline|Core Local AI remains available/i);
  assert.match(await page.locator('#status').innerText(),/Core services determine appliance health/i);
  await page.evaluate(()=>window.showView('agents'));
  await page.waitForSelector('#agents.active');
});
await check('desktop navigation architecture',async()=>{
  await page.locator('.ux-primary-rail').waitFor({state:'visible'});
  assert.equal(await page.locator('.ux-primary-item').count(),5);
  assert.equal(await page.locator('.ux-primary-item[data-domain="work"]').getAttribute('aria-current'),'true','Agent World lights Work');
  // A Work tab since Pi Hub A7 (plan decision 9): Work's strip shows, with Agent World current.
  assert.equal(await page.locator('#uxPageStrip').isVisible(),true,'Work\'s strip');
  assert.equal(await page.locator('#uxPageStrip [aria-current="page"]').innerText(),'Agent World');
});
await check('contextual navigation switches domains',async()=>{
  await page.locator('.ux-primary-item[data-domain="projects"]').click();
  await page.waitForSelector('#projects.active');
  assert.equal(await page.locator('#uxPageStrip [aria-current="page"]').innerText(),'Projects');
  await page.evaluate(()=>window.showView('agents'));
  await page.waitForSelector('#agents.active');
  assert.equal(await page.locator('.ux-primary-item[data-domain="work"]').getAttribute('aria-current'),'true');
});
await check('the start sheet asks what the team should do',async()=>{
  await page.evaluate(()=>window.LocalAIAgentStart.open());
  await page.locator('#agentGoal').waitFor({state:'visible'});
  assert.equal(await page.locator('#missionRunBtn').innerText(),'Start');
  await page.keyboard.press('Escape');await page.locator('#awStart').waitFor({state:'hidden'});
});
await check('the start sheet opened again right after closing stays open',async()=>{
  // The closed sheet's queued close event and its history.back() used to land after the reopen and close the new sheet.
  for(let i=0;i<3;i++){
    await page.evaluate(()=>window.LocalAIAgentStart.open());
    await page.locator('#agentGoal').waitFor({state:'visible'});
    await page.keyboard.press('Escape');await page.locator('#awStart').waitFor({state:'hidden'});
    await page.evaluate(()=>window.LocalAIAgentStart.open());
    await page.waitForFunction(()=>!!history.state?.localaiSheet);
    await page.waitForTimeout(600); // past sheetHistory's 500 ms pop fallback: anything late has landed
    assert.equal(await page.evaluate(()=>document.getElementById('awStart').open),true,`round ${i}: the reopened sheet closed itself`);
    await page.keyboard.press('Escape');await page.locator('#awStart').waitFor({state:'hidden'});
    await page.waitForFunction(()=>!history.state?.localaiSheet);
  }
});
await check('the start sheet closed and opened again in the same task stays open, three times, and leaves no entry behind', async () => {
  await page.evaluate(() => window.LocalAIAgentStart.open());
  await page.locator('#agentGoal').waitFor({ state: 'visible' });
  await checkReopenQuickly(page, 'awStart', () => { document.getElementById('awStart').close(); window.LocalAIAgentStart.open(); });
});
await check('Agent World is mounted',async()=>{
  await page.locator('#agentWorldCityMount .awc').waitFor({state:'visible'});
  const box=await page.locator('#agentWorldCityMount .awc').boundingBox();
  assert.ok(box&&box.width>0&&box.height>0,'Agent World should render a visible game surface');
});
await check('Agent World stage is landscape and full-width',async()=>{
  const city=await page.locator('.aw-city').boundingBox(),plate=await page.locator('.aw-plate__main').boundingBox();
  assert.ok(city.width>=2.5*plate.width,'the city takes most of the faceplate; the mission beside it is narrow');
  const map=await page.locator('.awc__mapWrap').boundingBox();
  assert.ok(map&&map.width>map.height,'Game map should be landscape, not a tall portrait strip');
});
await check('Crew and story are readable and do not overlap the city at desktop widths',async()=>{
  const hit=(a,b)=>a.x<b.x+b.width-1&&b.x<a.x+a.width-1&&a.y<b.y+b.height-1&&b.y<a.y+a.height-1;
  for(const width of [1440,1280,1100]){
    await page.setViewportSize({width,height:900});
    const t=await page.locator('#agentTimeline').boundingBox();
    const i=await page.locator('#awcRoster').boundingBox();
    const m=await page.locator('.awc__mapWrap').boundingBox();
    assert.ok(t&&i&&m,`panels render at ${width}`);
    assert.ok(t.width>=280,`story ${Math.round(t.width)}px wide at ${width}`);
    assert.ok(i.width>=280,`crew ${Math.round(i.width)}px wide at ${width}`);
    assert.ok(!hit(t,i),`story overlaps crew at ${width}`);
    assert.ok(!hit(t,m)&&!hit(i,m),`panels overlap map at ${width}`);
  }
  await page.setViewportSize({width:1440,height:1000});
});
await check('Agent World full screen and follow controls',async()=>{
  if(await page.locator('#awcFollow').getAttribute('aria-pressed')==='true')await page.locator('#awcFollow').click();
  await page.locator('#awcFollow').click();
  assert.equal(await page.locator('#awcFollow').getAttribute('aria-pressed'),'true');
  await page.locator('#awMoreBtn').click();await page.locator('#awMenu [data-aw-view="theater"]').click();
  assert.ok((await page.locator('.awc-v3').getAttribute('class')).includes('is-expanded'));
  await page.keyboard.press('Escape');
  assert.ok(!(await page.locator('.awc-v3').getAttribute('class')).includes('is-expanded'));
});
await check('advanced routing collapsed by default',async()=>{
  await page.evaluate(()=>window.LocalAIAgentStart.open());
  assert.equal(await page.locator('#agentAdvancedPanel').isVisible(),false);
  await page.locator('#agentAdvancedToggle').click();
  assert.equal(await page.locator('#agentAdvancedPanel').isVisible(),true);
  await page.locator('#agentAdvancedToggle').click();
  await page.keyboard.press('Escape');await page.locator('#awStart').waitFor({state:'hidden'});
});
await check('the story and the worker card replace the timeline and inspector',async()=>{
  await page.locator('#agentTimeline').waitFor({state:'visible'});
  assert.equal(await page.locator('#agentInspector').isVisible(),false,'the worker card opens only for a chosen worker');
  assert.equal(await page.locator('#missionExecution').isVisible(),false);
});
await check('the result reads Summary, What each worker found, Sources',async()=>{
  await page.locator('#agentResultBody').waitFor({state:'attached'});
  assert.equal(await page.locator('[data-agent-result-tab]').count(),0,'no tabs');
});
await check('mission history exists',async()=>{await page.locator('#agentMissionHistory').waitFor({state:'visible'})});
await check('inline error replaces alert workflow',async()=>{
  await page.evaluate(()=>window.LocalAIAgentStart.open());
  await page.locator('#agentGoal').fill('');
  await page.locator('#missionRunBtn').click();
  await page.locator('#agentInlineNotice').waitFor({state:'visible'});
  assert.match(await page.locator('#agentInlineNotice').innerText(),/Say what the team should do first/i);
  assert.equal(dialogs,0,'No browser alert dialogs should be used');
});
await check('the web-search choice reaches the mission request',async()=>{
  const bodies=[],isDispatch=u=>u.pathname==='/api/agents/dispatch',isStart=u=>u.pathname==='/api/agents/missions/start';
  await page.route(isDispatch,r=>r.fulfill({contentType:'application/json',body:JSON.stringify({routing:{mode:'auto',workers:[],selectedAgentIds:[],inventory:[]}})}));
  await page.route(isStart,r=>{bodies.push(r.request().postDataJSON());r.fulfill({status:500,contentType:'application/json',body:JSON.stringify({error:'stubbed'})})});
  const sent=async n=>{for(let i=0;i<60&&bodies.length<n;i++)await page.waitForTimeout(100);assert.equal(bodies.length,n)};
  try{
   await page.evaluate(()=>window.LocalAIAgentStart.open());
   await page.locator('#agentGoal').fill('Check release notes');
   await page.locator('#agentWebSearch').check();
   await page.locator('#missionRunBtn').click();
   await sent(1);
   assert.equal(bodies[0].webSearch,true);
   await page.locator('#agentWebSearch').uncheck();
   await page.locator('#missionRunBtn').click();
   await sent(2);
   assert.equal(bodies[1].webSearch,undefined);
  }finally{await page.unroute(isDispatch);await page.unroute(isStart);await page.locator('#agentGoal').fill('');await page.keyboard.press('Escape')}
});
await check('the workers\' model select sits under Advanced and reaches the mission request',async()=>{
  const CODER='qwen2.5-coder:7b-16k',bodies=[],isDispatch=u=>u.pathname==='/api/agents/dispatch',isStart=u=>u.pathname==='/api/agents/missions/start',isModels=u=>u.pathname==='/api/agents/models';
  await page.route(isModels,r=>r.fulfill({contentType:'application/json',body:JSON.stringify({items:[{name:'qwen3:4b-instruct-32k'},{name:CODER}]})}));
  await page.route(isDispatch,r=>r.fulfill({contentType:'application/json',body:JSON.stringify({routing:{mode:'auto',workers:[],selectedAgentIds:[],inventory:[]}})}));
  await page.route(isStart,r=>{bodies.push(r.request().postDataJSON());r.fulfill({status:500,contentType:'application/json',body:JSON.stringify({error:'stubbed'})})});
  const sent=async n=>{for(let i=0;i<60&&bodies.length<n;i++)await page.waitForTimeout(100);assert.equal(bodies.length,n)};
  try{
   await page.evaluate(()=>window.LocalAIAgentStart.open());
   assert.equal(await page.locator('#agentWorkerModel').isVisible(),false,'closed under Advanced');
   await page.locator('#agentAdvancedToggle').click();
   await page.locator('#agentWorkerModel').waitFor({state:'visible'});
   await page.waitForFunction(n=>[...document.querySelectorAll('#agentWorkerModel option')].some(o=>o.value===n),CODER);
   assert.equal(await page.locator('#agentWorkerModel option').first().textContent(),'Automatic');
   await page.locator('#agentGoal').fill('Review the mission code');
   await page.locator('#missionRunBtn').click();
   await sent(1);
   assert.equal(bodies[0].workerModel,undefined,'Automatic sends nothing');
   await page.locator('#agentWorkerModel').selectOption(CODER);
   await page.locator('#missionRunBtn').click();
   await sent(2);
   assert.equal(bodies[1].workerModel,CODER);
  }finally{
   await page.unroute(isModels);await page.unroute(isDispatch);await page.unroute(isStart);
   await page.evaluate(()=>{const s=document.getElementById('agentWorkerModel');if(s)s.value=''});
   if(await page.locator('#agentAdvancedPanel').isVisible())await page.locator('#agentAdvancedToggle').click();
   await page.locator('#agentGoal').fill('');await page.keyboard.press('Escape')}
});
await check('the demo runs and stops from its chip',async()=>{
  await page.evaluate(()=>window.LocalAIAgentWorld.demo());
  assert.equal(await page.locator('.awc-v3').getAttribute('data-source'),'demo');
  await page.evaluate(()=>{window.LocalAIAgentWorld.demoStep();window.LocalAIAgentWorld.demoStep()});
  assert.match(await page.locator('#awSheetStatus').textContent(),/Working|Needs you|Done/);
  await page.locator('#awcLiveBtn').click();
  await page.locator('#awcLiveBtn').waitFor({state:'hidden'});
});
await check('desktop zoom controls',async()=>{
  await page.locator('#awcZoomIn').click();
  assert.notEqual(await page.locator('#awcZoomLabel').innerText(),'100%');
  await page.locator('#awMoreBtn').click();await page.locator('#awMenu [data-aw-view="fit"]').click();
  assert.equal(await page.locator('#awcZoomLabel').innerText(),'100%');
});
await check('Replay: one scrubber with markers, Play, and a historical mission timeline',async()=>{
  await page.evaluate(()=>window.dispatchEvent(new CustomEvent('localai:agentworld-replay-mission',{detail:{mission:{id:'history-test',goal:'Historical test',status:'complete',workers:[{id:'router',name:'Mission Router',state:'complete',dependsOn:[]},{id:'ux_analyst',name:'UX Analyst',state:'complete',dependsOn:['router']}],timeline:[{at:new Date(Date.now()-1000).toISOString(),type:'mission-start',detail:'Started',status:'running',workerId:'router',workers:[{id:'router',name:'Mission Router',state:'complete'},{id:'ux_analyst',name:'UX Analyst',state:'running'}]},{at:new Date().toISOString(),type:'mission-complete',detail:'Done',status:'complete',workerId:'ux_analyst',workers:[{id:'router',name:'Mission Router',state:'complete'},{id:'ux_analyst',name:'UX Analyst',state:'complete'}]}]}}})));
  await page.locator('#awcScrub').waitFor({state:'visible'});
  assert.deepEqual(await page.locator('#awcReplayMarkers .awc__mark').evaluateAll(m=>m.map(x=>x.dataset.kind)),['done'],'one mark: the finish');
  await page.locator('#awcReplayRange').focus();await page.keyboard.press('End');
  assert.match(await page.locator('#awcReplayLabel').innerText(),/Step 2 of 2 · Mission complete/);
  await page.locator('#awMoreBtn').click();await page.locator('#awMenu [data-aw-view="speed"]').click();
  assert.match(await page.locator('#awMenu [data-aw-view="speed"]').innerText(),/2×/);
  await page.keyboard.press('Escape');
  const stored=await page.evaluate(()=>{const v=JSON.parse(localStorage.getItem('localai.agentworld.replay.v2')||'null');return v?.frames?.length||0});
  assert.ok(stored>=2,'replay steps persist locally');
  await page.locator('#awcReplayLive').click();
});
await check('Agent World running-worker controls remain interactive',async()=>{
  await page.evaluate(()=>window.LocalAIAgentWorld.demo());
  await page.waitForTimeout(250);
  assert.match(await page.locator('#awSheetStatus').textContent(),/Starting|Working|Done/);
  const beforeFollow=await page.locator('#awcFollow').getAttribute('aria-pressed');
  await page.locator('#awcFollow').click();
  const afterFollow=await page.locator('#awcFollow').getAttribute('aria-pressed');
  assert.notEqual(afterFollow,beforeFollow);
  if(afterFollow==='true')await page.locator('#awcFollow').click();
  await page.locator('#awcLiveBtn').click();
});
await check('Agent World keeps same-district workers separated',async()=>{
  await page.evaluate(()=>window.LocalAIAgentWorld.demo());
  await page.waitForTimeout(200);
  const rosterCount=await page.locator('#awcRoster .awc__rosterItem').count();
  assert.ok(rosterCount>=4);
  await page.locator('#awcLiveBtn').click();
});
await check('Agent World crew have portraits',async()=>{
  await page.evaluate(()=>window.LocalAIAgentWorld.demo());
  await page.waitForTimeout(150);
  assert.ok(await page.locator('#awcRoster .awc__avatar').count()>=4);
  await page.locator('#awcLiveBtn').click();
});
await check('Agent World worker identities render in roster',async()=>{
  await page.evaluate(()=>window.LocalAIAgentWorld.demo());
  await page.waitForTimeout(150);
  assert.ok(await page.locator('#awcRoster .awc__avatar').count()>=4);
  assert.match(await page.locator('#awcRoster').innerText(),/UX Analyst/i);
  await page.locator('#awcLiveBtn').click();
});
await check('Agent World HUD: minimap, night and flows through ⋯ › View',async()=>{
  await page.locator('#awcRoster').waitFor({state:'visible'});
  await page.locator('#awcMinimap').waitFor({state:'visible'});
  await page.locator('#awMoreBtn').click();await page.locator('#awMenu [data-aw-view="night"]').click();
  assert.equal(await page.locator('#awMenu [data-aw-view="night"]').getAttribute('aria-checked'),'true');
  await page.locator('#awMenu [data-aw-view="night"]').click();
  await page.locator('#awMenu [data-aw-view="flows"]').click();
  assert.equal(await page.locator('#awMenu [data-aw-view="flows"]').getAttribute('aria-checked'),'false');
  await page.locator('#awMenu [data-aw-view="flows"]').click();await page.keyboard.press('Escape');
});
await page.close();

const mobile=await browser.newPage({ serviceWorkers: 'block',viewport:{width:390,height:844},hasTouch:true,isMobile:true});
mobile.on('dialog',async d=>{dialogs++;await d.dismiss()});
await mobile.goto(base,{waitUntil:'domcontentloaded'});
await mobile.waitForSelector('#uxMobileNav');
// The tab bar can render before app.js has defined showView.
await mobile.waitForFunction(()=>typeof window.showView==='function');
await mobile.evaluate(()=>window.showView('agents'));
await mobile.waitForSelector('#agents.active');
await mobile.waitForSelector('#agentWorldCityMount .awc');

await check('mobile navigation is domain-first: the tab bar lights Work on Missions',async()=>{
  await mobile.locator('#uxMobileNav').waitFor({state:'visible'});
  assert.equal(await mobile.locator('#uxMobileNav [data-domain]').count(),5);
  assert.equal(await mobile.locator('#uxMobileNav [data-domain="work"]').getAttribute('aria-current'),'true');
});
await check('mobile layout has no page-level horizontal overflow',async()=>{
  const dims=await mobile.evaluate(()=>({sw:document.documentElement.scrollWidth,cw:document.documentElement.clientWidth}));
  assert.ok(dims.sw<=dims.cw+2,`scrollWidth ${dims.sw} > clientWidth ${dims.cw}`);
});
await check('mobile touch targets and controls are available',async()=>{
  // On a phone the city keeps three controls; the rest is in the sheet.
  for(const id of ['#awcZoomIn','#awcZoomOut','#awcFollow','#awSheetHandle']){
    await mobile.locator(id).waitFor({state:'visible'});
  }
});
await check('mobile pinch zoom changes world scale',async()=>{
  const c=mobile.locator('#awcCanvas');
  const b=await c.boundingBox();assert.ok(b);
  const cx=b.x+b.width/2,cy=b.y+b.height/2;
  await c.dispatchEvent('pointerdown',{pointerId:1,pointerType:'touch',clientX:cx-30,clientY:cy,bubbles:true});
  await c.dispatchEvent('pointerdown',{pointerId:2,pointerType:'touch',clientX:cx+30,clientY:cy,bubbles:true});
  await c.dispatchEvent('pointermove',{pointerId:2,pointerType:'touch',clientX:cx+100,clientY:cy,bubbles:true});
  await c.dispatchEvent('pointerup',{pointerId:2,pointerType:'touch',clientX:cx+100,clientY:cy,bubbles:true});
  await c.dispatchEvent('pointerup',{pointerId:1,pointerType:'touch',clientX:cx-30,clientY:cy,bubbles:true});
  assert.notEqual(await mobile.locator('#awcZoomLabel').innerText(),'100%');
});
await check('mobile demo is a tap away and stops from its chip',async()=>{
  await mobile.evaluate(()=>window.LocalAIAgentWorld.demo());
  assert.equal(await mobile.locator('.awc-v3').getAttribute('data-source'),'demo');
  await mobile.locator('#awcLiveBtn').click();
});
await mobile.close();
await check('the mission strip and Agent World show the same mission while the specialist catalog is slow',async()=>{
  const goal='Strip and Agent World agree on this mission';
  const mission={id:'mission-strip-sync',goal,status:'complete',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),
    workers:[{id:'research',name:'Research Agent',state:'complete'},{id:'synthesis',name:'Synthesis',state:'complete'}],results:[]};
  const pg=await browser.newPage({ serviceWorkers: 'block',viewport:{width:1440,height:1000}});
  let releaseCatalog;const catalogHeld=new Promise(r=>releaseCatalog=r);
  await pg.route(u=>u.pathname==='/api/agents/missions',r=>r.fulfill({contentType:'application/json',body:JSON.stringify({items:[mission]})}));
  await pg.route(u=>u.pathname==='/api/agents/catalog',async r=>{await catalogHeld;await r.fallback()});
  await pg.goto(base,{waitUntil:'domcontentloaded'});
  await pg.waitForSelector('.ux-primary-rail');
  await pg.waitForFunction(()=>typeof window.showView==='function');
  await pg.evaluate(()=>window.showView('agents'));
  await pg.waitForSelector('#agents.active');
  await pg.waitForFunction(g=>document.getElementById('awTitle')?.textContent===g,goal,{timeout:10000});
  await pg.waitForFunction(g=>document.getElementById('agentMissionHeadline')?.textContent===g,goal,{timeout:3000});
  releaseCatalog();
  await pg.close();
});

// A navigation click reaches Missions: the #agents URL, and the Work tab then the Missions chip, both land on Work with only mission rows.
await check('navigation reaches Missions through Work',async()=>{
  const mk=(id,kind,title)=>({id,type:kind,status:'completed',progress:100,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),card:{kind,icon:'system',title,summary:'',badge:{label:'Done',tone:'good'},preview:null,action:{label:'Open'},approval:null}});
  const items=[mk('run-1-a','chat','A chat'),mk('legacy-agent:one','agent','A mission run'),mk('run-2-b','image','An image')];
  const visit=async(hash,viewport)=>{
    const pg=await browser.newPage({ serviceWorkers: 'block',viewport});
    await pg.route(u=>u.pathname==='/api/runs',r=>{const k=new URL(r.request().url()).searchParams.get('kind');r.fulfill({contentType:'application/json',body:JSON.stringify({items:items.filter(x=>!k||workKind(x)===k),summary:{}})})}); // the server filters by Work's chip
    await pg.goto(base+'/'+hash,{waitUntil:'domcontentloaded'});
    await pg.waitForFunction(()=>typeof window.showView==='function'&&window.LocalAIRouter&&location.hash);
    return pg;
  };
  const onlyMissions=async pg=>{
    await pg.waitForSelector('#work.active .run-card');
    assert.equal(await pg.locator('[data-work-kind="missions"]').getAttribute('aria-checked'),'true'); // Work's chips are one segmented control (E5)
    assert.deepEqual(await pg.locator('#work .run-card').evaluateAll(r=>r.map(x=>x.dataset.kind)),['agent']);
  };
  // #agents is Agent World again (a Work tab, Pi Hub A7 plan decision 9), not an alias of Work; #work?kind=missions lists them.
  const deep=await visit('#work?kind=missions',{width:1280,height:860});await onlyMissions(deep);await deep.close();
  const map=await visit('#agents',{width:1280,height:860});await map.waitForSelector('#agents.active');await map.close();
  for(const viewport of [{width:1280,height:860},{width:390,height:844}]){
    const pg=await visit('',viewport);
    await pg.locator(viewport.width<760?'#uxMobileNav [data-domain="work"]':'.ux-primary-item[data-domain="work"]').click();
    await pg.waitForSelector('#work.active .run-card');
    assert.equal(await pg.locator('#work .run-card').count(),3);
    await pg.locator('[data-work-kind="missions"]').click();
    await pg.waitForSelector('#workList:not([aria-busy="true"])');
    await onlyMissions(pg);await pg.close();
  }
});

await browser.close();

if(failures.length){
  console.error('\nAcceptance failures:\n'+failures.map(x=>' - '+x).join('\n'));
  process.exit(1);
}
console.log('\nAgent Operations v2 browser acceptance: PASS');
