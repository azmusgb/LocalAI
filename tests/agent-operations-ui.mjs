import { chromium } from 'playwright';
import assert from 'node:assert/strict';
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
  await page.locator('.ux-secondary-nav').waitFor({state:'hidden'}); // Work has one page, so no page list beside the rail
  assert.equal(await page.locator('.ux-primary-item').count(),5);
  assert.equal(await page.locator('#uxSecondaryTitle').textContent(),'Work');
});
await check('contextual navigation switches domains',async()=>{
  await page.locator('.ux-primary-item[data-domain="projects"]').click();
  await page.waitForSelector('#projects.active');
  assert.equal(await page.locator('#uxSecondaryTitle').innerText(),'Projects');
  await page.evaluate(()=>window.showView('agents'));
  await page.waitForSelector('#agents.active');
  assert.equal(await page.locator('#uxSecondaryTitle').textContent(),'Work');
});
await check('mission-first composer',async()=>{
  await page.locator('#agentGoal').waitFor({state:'visible'});
  await page.locator('#missionRunBtn').waitFor({state:'visible'});
  assert.equal(await page.locator('#missionRunBtn').innerText(),'Start mission');
});
await check('Missions leads with workers and the current step; the live map waits behind Watch live map (E2)',async()=>{
  const order=await page.evaluate(()=>{const at=s=>document.querySelector(s);const before=(a,b)=>!!(at(a).compareDocumentPosition(at(b))&Node.DOCUMENT_POSITION_FOLLOWING);return{strip:before('.agent-mission-strip','#agentWorldCityMount'),workers:before('#agentTimeline','#agentWorldCityMount'),toggle:before('#agentMapToggle','#agentWorldCityMount')}});
  assert.deepEqual(order,{strip:true,workers:true,toggle:true});
  assert.equal(await page.locator('#agentMapPanel').isVisible(),false,'the map is hidden until asked for');
  assert.equal(await page.locator('#agentMapToggle').getAttribute('aria-expanded'),'false');
  assert.equal(await page.locator('#agentMapToggle').innerText(),'Watch live map');
  await page.locator('#agentMapToggle').click();
  assert.equal(await page.locator('#agentMapToggle').getAttribute('aria-expanded'),'true');
  assert.equal(await page.locator('#agentMapToggle').innerText(),'Hide live map');
});
await check('the result tabs and the map toolbar speak in words',async()=>{
  assert.deepEqual((await page.locator('[data-agent-result-tab]').allInnerTexts()).map(s=>s.trim()),['Summary','Workers','Sources','Steps']);
  const bar=(await page.locator('.awc__toolbar button').allInnerTexts()).map(s=>s.trim());
  assert.deepEqual(bar,['Whole map','Find worker','Follow worker','Zoom out','Zoom in','Names','Hand-offs','Dark map','Workers','Full screen']);
  assert.doesNotMatch(await page.locator('#agents').innerText(),/Theater|Routing override|Advanced routing|IDLE|Direct execution|Mission objective|Start Mission/);
});
await check('Agent World is mounted',async()=>{
  await page.locator('#agentWorldCityMount .awc').waitFor({state:'visible'});
  const box=await page.locator('#agentWorldCityMount .awc').boundingBox();
  assert.ok(box&&box.width>0&&box.height>0,'Agent World should render a visible game surface');
});
await check('Agent World stage is landscape and full-width',async()=>{
  const panel=await page.locator('#agentMapPanel').boundingBox(),ops=await page.locator('.agent-ops').boundingBox();
  assert.ok(panel&&ops&&panel.width>=ops.width-2,'Agent World spans the page, not squeezed beside a column');
  const map=await page.locator('.awc__mapWrap').boundingBox();
  assert.ok(map&&map.width>map.height,'Game map should be landscape, not a tall portrait strip');
});
await check('Mission timeline and Inspector are readable and do not overlap at desktop widths',async()=>{
  const hit=(a,b)=>a.x<b.x+b.width-1&&b.x<a.x+a.width-1&&a.y<b.y+b.height-1&&b.y<a.y+a.height-1;
  for(const width of [1440,1280,1100]){
    await page.setViewportSize({width,height:900});
    const t=await page.locator('#agentTimeline').boundingBox();
    const i=await page.locator('#agentInspector').boundingBox();
    const m=await page.locator('.awc__mapWrap').boundingBox();
    assert.ok(t&&i&&m,`panels render at ${width}`);
    assert.ok(t.width>=280,`timeline ${Math.round(t.width)}px wide at ${width}`);
    assert.ok(i.width>=280,`inspector ${Math.round(i.width)}px wide at ${width}`);
    assert.ok(!hit(t,i),`timeline overlaps inspector at ${width}`);
    assert.ok(!hit(t,m)&&!hit(i,m),`panels overlap map at ${width}`);
  }
  await page.setViewportSize({width:1440,height:1000});
});
await check('Agent World theater, crew and follow controls',async()=>{
  await page.locator('#awcCrewToggle').click();
  assert.ok((await page.locator('.awc-v3').getAttribute('class')).includes('crew-hidden'));
  await page.locator('#awcCrewToggle').click();
  await page.locator('#awcFollow').click();
  assert.equal(await page.locator('#awcFollow').getAttribute('aria-pressed'),'true');
  await page.locator('#awcExpand').click();
  assert.ok((await page.locator('.awc-v3').getAttribute('class')).includes('is-expanded'));
  await page.keyboard.press('Escape');
  assert.ok(!(await page.locator('.awc-v3').getAttribute('class')).includes('is-expanded'));
});
await check('advanced routing collapsed by default',async()=>{
  assert.equal(await page.locator('#agentAdvancedPanel').isVisible(),false);
  await page.locator('#agentAdvancedToggle').click();
  assert.equal(await page.locator('#agentAdvancedPanel').isVisible(),true);
});
await check('timeline + inspector replace duplicate execution views',async()=>{
  await page.locator('#agentTimeline').waitFor({state:'visible'});
  await page.locator('#agentInspector').waitFor({state:'visible'});
  assert.equal(await page.locator('#missionExecution').isVisible(),false);
});
await check('results tabs are interactive',async()=>{
  await page.locator('[data-agent-result-tab="evidence"]').click();
  assert.ok((await page.locator('[data-agent-result-tab="evidence"]').getAttribute('class')||'').includes('active'));
  await page.locator('[data-agent-result-tab="routing"]').click();
  assert.ok((await page.locator('[data-agent-result-tab="routing"]').getAttribute('class')||'').includes('active'));
  assert.doesNotMatch(await page.locator('#agentResultBody').innerText(),/[{}\[\]]/,'Steps is a list, not JSON');
});
await check('mission history exists',async()=>{await page.locator('#agentMissionHistory').waitFor({state:'visible'})});
await check('inline error replaces alert workflow',async()=>{
  await page.locator('#agentGoal').fill('');
  await page.locator('#missionRunBtn').click();
  await page.locator('#agentInlineNotice').waitFor({state:'visible'});
  assert.match(await page.locator('#agentInlineNotice').innerText(),/Enter a goal first/i);
  assert.equal(dialogs,0,'No browser alert dialogs should be used');
});
await check('the web-search choice reaches the mission request',async()=>{
  const bodies=[],isDispatch=u=>u.pathname==='/api/agents/dispatch',isStart=u=>u.pathname==='/api/agents/missions/start';
  await page.route(isDispatch,r=>r.fulfill({contentType:'application/json',body:JSON.stringify({routing:{mode:'auto',workers:[],selectedAgentIds:[],inventory:[]}})}));
  await page.route(isStart,r=>{bodies.push(r.request().postDataJSON());r.fulfill({status:500,contentType:'application/json',body:JSON.stringify({error:'stubbed'})})});
  const sent=async n=>{for(let i=0;i<60&&bodies.length<n;i++)await page.waitForTimeout(100);assert.equal(bodies.length,n)};
  try{
   await page.locator('#agentGoal').fill('Check release notes');
   await page.locator('#agentWebSearch').check();
   await page.locator('#missionRunBtn').click();
   await sent(1);
   assert.equal(bodies[0].webSearch,true);
   await page.locator('#agentWebSearch').uncheck();
   await page.locator('#missionRunBtn').click();
   await sent(2);
   assert.equal(bodies[1].webSearch,undefined);
  }finally{await page.unroute(isDispatch);await page.unroute(isStart);await page.locator('#agentGoal').fill('')}
});
await check('interactive demo controls',async()=>{
  await page.locator('#awcDemoPlay').click();
  assert.equal(await page.locator('#awcSource').innerText(),'Demo');
  await page.locator('#awcDemoStep').click();
  await page.locator('#awcDemoSpeed').click();
  assert.equal(await page.locator('#awcDemoSpeed').innerText(),'2×');
  await page.locator('#awcDemoScenario').selectOption('failure');
  await page.locator('#awcDemoStep').click();
  await page.locator('#awcDemoStep').click();
  assert.match(await page.locator('#awcStatus').innerText(),/Needs attention|Running/i);
  await page.locator('#awcLiveBtn').click();
});
await check('desktop zoom controls',async()=>{
  await page.locator('#awcZoomIn').click();
  assert.notEqual(await page.locator('#awcZoomLabel').innerText(),'100%');
  await page.locator('#awcFit').click();
  assert.equal(await page.locator('#awcZoomLabel').innerText(),'100%');
});
await check('Living Worksite replay controls are interactive',async()=>{
  await page.locator('#awcReplayPlay').waitFor({state:'visible'});
  await page.locator('#awcReplayRange').waitFor({state:'visible'});
  await page.locator('#awcDemoPlay').click();
  await page.locator('#awcDemoStep').click();
  await page.locator('#awcDemoStep').click();
  const max=Number(await page.locator('#awcReplayRange').getAttribute('max'));
  assert.ok(max>=1,'demo should create replay checkpoints');
  await page.locator('#awcReplayPlay').click();
  assert.match(await page.locator('#awcReplayLabel').innerText(),/Replay/i);
  await page.locator('#awcReplayLive').click();
  await page.locator('#awcLiveBtn').click();
});
await check('Replay supports event stepping, speed, and historical mission timelines',async()=>{
  await page.locator('#awcReplayPrev').waitFor({state:'visible'});
  await page.locator('#awcReplayNext').waitFor({state:'visible'});
  await page.locator('#awcReplaySpeed').click();
  assert.equal(await page.locator('#awcReplaySpeed').innerText(),'2×');
  await page.evaluate(()=>window.dispatchEvent(new CustomEvent('localai:agentworld-replay-mission',{detail:{mission:{id:'history-test',goal:'Historical test',status:'complete',workers:[{id:'router',name:'Mission Router',state:'complete',dependsOn:[]},{id:'ux_analyst',name:'UX Analyst',state:'complete',dependsOn:['router']}],timeline:[{at:new Date(Date.now()-1000).toISOString(),type:'mission-start',detail:'Started',status:'running',workerId:'router',workers:[{id:'router',name:'Mission Router',state:'complete',dependsOn:[]},{id:'ux_analyst',name:'UX Analyst',state:'pending',dependsOn:['router']}]},{at:new Date().toISOString(),type:'mission-complete',detail:'Finished',status:'complete',workerId:'ux_analyst',workers:[{id:'router',name:'Mission Router',state:'complete',dependsOn:[]},{id:'ux_analyst',name:'UX Analyst',state:'complete',dependsOn:['router']}]}]}}})));
  await page.waitForTimeout(100);
  assert.equal(await page.locator('#awcReplayMarkers button').count(),2);
  await page.locator('#awcReplayNext').click();
  assert.match(await page.locator('#awcReplayLabel').innerText(),/Replay 2 \/ 2/i);
  await page.locator('#awcReplayLive').click();
});
await check('Operational Agent World exposes durable observability semantics',async()=>{
  await page.locator('#awcStatArtifacts').waitFor({state:'visible'});
  assert.match(await page.locator('.awc__legend').innerText(),/Active dependency/i);
  await page.locator('#awcDemoPlay').click();
  await page.locator('#awcDemoStep').click();
  await page.locator('#awcDemoStep').click();
  const stored=await page.evaluate(()=>{const v=JSON.parse(localStorage.getItem('localai.agentworld.replay.v2')||'null');return v?.frames?.length||0});
  assert.ok(stored>=2,'replay events should persist locally');
  await page.locator('#awcLiveBtn').click();
});
await check('Agent World running-worker controls remain interactive',async()=>{
  await page.locator('#awcDemoPlay').click();
  await page.waitForTimeout(250);
  assert.match(await page.locator('#awcStage').innerText(),/Router planning|UX analysis|Documentation|Synthesis|Complete/i);
  const beforeFollow=await page.locator('#awcFollow').getAttribute('aria-pressed');
  await page.locator('#awcFollow').click();
  const afterFollow=await page.locator('#awcFollow').getAttribute('aria-pressed');
  assert.notEqual(afterFollow,beforeFollow);
  if(afterFollow==='true')await page.locator('#awcFollow').click();
  await page.locator('#awcLiveBtn').click();
});
await check('Agent World keeps same-district workers separated',async()=>{
  await page.locator('#awcDemoPlay').click();
  await page.waitForTimeout(200);
  const rosterCount=await page.locator('#awcRoster .awc__rosterItem').count();
  assert.ok(rosterCount>=4);
  await page.locator('#awcLiveBtn').click();
});
await check('Agent World uses construction-crew presentation',async()=>{
  assert.match(await page.locator('.awc__sub').innerText(),/construction crew/i);
  await page.locator('#awcDemoPlay').click();
  await page.waitForTimeout(150);
  assert.ok(await page.locator('#awcRoster .awc__rosterGlyph').count()>=4);
  await page.locator('#awcLiveBtn').click();
});
await check('Agent World worker identities render in roster',async()=>{
  await page.locator('#awcDemoPlay').click();
  await page.waitForTimeout(150);
  assert.ok(await page.locator('#awcRoster .awc__rosterGlyph').count()>=4);
  assert.match(await page.locator('#awcRoster').innerText(),/UX Analyst/i);
  await page.locator('#awcLiveBtn').click();
});
await check('Agent World v3 HUD and simulation controls',async()=>{
  await page.locator('#awcRoster').waitFor({state:'visible'});
  await page.locator('#awcMinimap').waitFor({state:'visible'});
  await page.locator('[data-awc-display="night"]').click();
  assert.equal(await page.locator('[data-awc-display="night"]').getAttribute('aria-pressed'),'true');
  await page.locator('[data-awc-display="night"]').click();
  await page.locator('[data-awc-district="ux"]').click();
  assert.match(await page.locator('#awcSelection').innerText(),/UX Lab/i);
  await page.locator('[data-awc-display="flows"]').click();
  assert.equal(await page.locator('[data-awc-display="flows"]').getAttribute('aria-pressed'),'false');
  await page.locator('[data-awc-display="flows"]').click();
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
await mobile.locator('#agentMapToggle').click();
await mobile.waitForSelector('#agentWorldCityMount .awc');

await check('mobile navigation is domain-first with contextual sheet',async()=>{
  await mobile.locator('#uxMobileNav').waitFor({state:'visible'});
  assert.equal(await mobile.locator('#uxMobileNav [data-domain]').count(),5);
  await mobile.locator('#uxContextMenu').click();
  await mobile.locator('#uxMobileSheet').waitFor({state:'visible'});
  assert.match(await mobile.locator('#uxMobileSheetTitle').innerText(),/Work/i);
  await mobile.locator('#uxMobileSheetClose').click();
});
await check('mobile layout has no page-level horizontal overflow',async()=>{
  const dims=await mobile.evaluate(()=>({sw:document.documentElement.scrollWidth,cw:document.documentElement.clientWidth}));
  assert.ok(dims.sw<=dims.cw+2,`scrollWidth ${dims.sw} > clientWidth ${dims.cw}`);
});
await check('mobile touch targets and controls are available',async()=>{
  for(const id of ['#awcZoomIn','#awcZoomOut','#awcFit','#awcCenter','#awcDemoPlay','#awcDemoStep']){
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
await check('mobile demo remains user-controlled',async()=>{
  await mobile.locator('#awcDemoPlay').click();
  await mobile.locator('#awcDemoStep').click();
  assert.equal(await mobile.locator('#awcSource').innerText(),'Demo');
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
  await pg.waitForFunction(g=>document.getElementById('awcObjective')?.textContent===g,goal,{timeout:10000});
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
    assert.equal(await pg.locator('[data-work-kind="missions"]').getAttribute('aria-pressed'),'true');
    assert.deepEqual(await pg.locator('#work .run-card').evaluateAll(r=>r.map(x=>x.dataset.kind)),['agent']);
  };
  const deep=await visit('#agents',{width:1280,height:860});await onlyMissions(deep);await deep.close();
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
