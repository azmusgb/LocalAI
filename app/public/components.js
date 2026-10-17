// Shared front-end components. One object, window.LocalAIUI, that later tasks extend (ask, runCard, registerRunBody).
(function(){
  const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  // JSON in, JSON out: rejects on a non-2xx or non-JSON reply with the server's own `error` text.
  async function fetchJson(url,opt){
    const r=await fetch(url,opt);let j=null,bad=false;
    try{j=await r.json()}catch{bad=true}
    if(!r.ok)throw new Error((j&&j.error)||`HTTP ${r.status}`);
    if(bad||j===null||typeof j!=='object')throw new Error('The server sent an unreadable reply');
    return j;
  }
  // One load / empty / error lifecycle for any list. A failed load says so (with Retry) instead of looking like an empty list.
  function loadInto(container,load,{render,empty='Nothing here yet.',what='this'}={}){
    const hasContent=()=>container.children.length&&!container.querySelector(':scope > .state-loading,:scope > .state-error');
    // Loading shows only after 300 ms, and never over a list that is already on screen (refreshes stay quiet).
    const timer=setTimeout(()=>{if(!hasContent())container.innerHTML='<div class="state-loading empty-state" role="status">Loading…</div>'},300);
    return Promise.resolve().then(load).then(async data=>{
      clearTimeout(timer);
      if(await render(container,data)===false)container.innerHTML=`<div class="state-empty empty-state">${esc(empty)}</div>`;
      return data;
    }).catch(err=>{
      clearTimeout(timer);
      container.innerHTML=`<div class="state-error empty-state" role="alert"><div class="empty-state__title">Couldn't load ${esc(what)}.</div><div>${esc(err&&err.message||String(err))}</div><button type="button" class="btn-outline">Retry</button></div>`;
      container.querySelector('.state-error button').addEventListener('click',()=>{loadInto(container,load,{render,empty,what}).catch(()=>{})});
      throw err;
    });
  }
  // The one approval sheet for risky actions. ask({title,effect,confirmLabel,tone,typed,input}) -> {ok,value?}.
  // tone: default|danger|host. typed: a word to type before Confirm enables. input: {label,type,placeholder} collects a value.
  // select: {label,options:[{value,label}],value?} replaces input with a chooser; the chosen value comes back in `value`.
  let askSeq=0;
  function ask(o={}){
    const opener=document.activeElement,id='askSheet'+(++askSeq);
    const d=document.createElement('dialog');d.className='ask-sheet ask-sheet--'+(o.tone||'default');
    d.setAttribute('aria-labelledby',id+'t');if(o.effect)d.setAttribute('aria-describedby',id+'d');
    // Each field is one entry here so a later option (a select, say) is one more case, not a rewrite.
    const fields=[];
    if(o.select)fields.push({name:'value',label:o.select.label||'',select:o.select.options||[],initial:o.select.value||'',required:false});
    else if(o.input)fields.push({name:'value',label:o.input.label||'',type:o.input.type||'text',placeholder:o.input.placeholder||'',required:!o.typed});
    if(o.typed)fields.push({name:'typed',label:`Type ${o.typed} to confirm`,type:'text',placeholder:o.typed,required:true,exact:o.typed});
    d.innerHTML=`<form method="dialog" class="ask-sheet__form" novalidate><h2 class="ask-sheet__title" id="${id}t"></h2><p class="ask-sheet__effect" id="${id}d"></p>${fields.map((f,i)=>`<label class="ask-sheet__field" for="${id}f${i}"><span></span>${f.select?`<select id="${id}f${i}" name="${f.name}"></select>`:`<input id="${id}f${i}" name="${f.name}" autocomplete="off" autocapitalize="off" spellcheck="false">`}</label>`).join('')}<div class="ask-sheet__actions"><button type="button" class="btn-outline ask-sheet__cancel">Cancel</button><button type="submit" class="btn-primary ask-sheet__ok"></button></div></form>`;
    d.querySelector('.ask-sheet__title').textContent=o.title||'';
    const eff=d.querySelector('.ask-sheet__effect');if(o.effect)eff.textContent=o.effect;else eff.hidden=true;
    const ok=d.querySelector('.ask-sheet__ok'),cancel=d.querySelector('.ask-sheet__cancel');ok.textContent=o.confirmLabel||'Confirm';
    const inputs=[...d.querySelectorAll('input,select')];
    inputs.forEach((el,i)=>{const f=fields[i];el.previousElementSibling.textContent=f.label;
      if(f.select){f.select.forEach(op=>el.add(new Option(op.label,op.value)));el.value=f.initial}else{el.type=f.type;el.placeholder=f.placeholder}});
    const ready=()=>fields.every((f,i)=>f.exact?inputs[i].value===f.exact:!f.required||inputs[i].value.trim()!=='');
    const sync=()=>{ok.disabled=!ready()};sync();inputs.forEach(el=>{el.addEventListener('input',sync);el.addEventListener('change',sync)});
    return new Promise(resolve=>{
      let out={ok:false};
      d.addEventListener('submit',e=>{e.preventDefault();if(ok.disabled)return;ok.disabled=true;cancel.disabled=true;out={ok:true};const v=fields.findIndex(f=>f.name==='value');if(v>=0)out.value=inputs[v].value.trim();d.close()});
      cancel.addEventListener('click',()=>d.close());
      d.addEventListener('click',e=>{if(e.target===d)d.close()});          // a click on the backdrop lands on the dialog itself
      d.addEventListener('close',()=>{d.remove();if(opener&&opener.isConnected&&opener.focus)opener.focus();resolve(out)});
      document.body.appendChild(d);d.showModal();(inputs[0]||cancel).focus();
    });
  }
  // Focus after an action re-renders a list: refocus(id, {within, key, next, prev, control, fallback, highlight}) -> element|null.
  // Finds the row [data-<key>=id] inside `within` (an element or a selector), else the row for `next`, else `prev`, and focuses
  // its `control` (default: its first button or link), or the row itself. With none of them, `fallback` (an element or a
  // selector) gets focus, made focusable if it isn't. highlight: the row gets .is-highlighted for a few seconds.
  function refocus(id,{within=document,key='itemId',next='',prev='',control='button,a[href]',fallback=null,highlight=false}={}){
    const box=typeof within==='string'?document.querySelector(within):within;   // a list that emptied may be gone: then only the fallback
    const attr='data-'+key.replace(/[A-Z]/g,c=>'-'+c.toLowerCase()),find=v=>v&&box?[...box.querySelectorAll(`[${attr}]`)].find(n=>n.getAttribute(attr)===String(v)):null;
    const row=find(id)||find(next)||find(prev);
    const to=row?(row.querySelector(control)||row):(typeof fallback==='string'?box?.querySelector(fallback):fallback);
    if(!to)return null;
    if(!to.matches('button,a[href],input,select,textarea,[tabindex]'))to.tabIndex=-1;
    to.focus({preventScroll:true});to.scrollIntoView?.({block:'nearest'});
    if(row&&highlight){row.classList.add('is-highlighted');setTimeout(()=>row.classList.remove('is-highlighted'),4000)}
    return to;
  }
  // A sentence after an action, in the page's role=status #toast: the shared LocalAIUI.toast when there is one, else shown
  // for 6 s and emptied when it hides.
  function announce(m){
    if(window.LocalAIUI&&typeof window.LocalAIUI.toast==='function')return window.LocalAIUI.toast(m);
    const t=document.getElementById('toast');if(!t)return;t.textContent=m;t.classList.add('show');
    clearTimeout(t._hide);t._hide=setTimeout(()=>{t.classList.remove('show');t.replaceChildren()},6000);
  }
  window.LocalAIUI=Object.assign(window.LocalAIUI||{},{refocus,announce});
  // One card for every run, whatever its kind: icon, title, summary, status badge, a bar while active, the preview, one action.
  // item is a /api/runs list item; item.card (from the server) says what to show. onOpen(item) opens the run view.
  const ACTIVE=new Set(['queued','running','streaming','awaiting_approval']);
  function runPreview(p){
    if(!p)return null;
    const box=document.createElement('div');box.className='run-card__preview run-card__preview--'+p.type;
    if(p.type==='image'){
      if(p.src){const im=document.createElement('img');im.src=p.src;im.alt='';im.loading='lazy';box.appendChild(im)}
      else box.innerHTML=window.LocalAIKit?window.LocalAIKit.icon('image'):'';
      if(p.count>1){const n=document.createElement('span');n.className='run-card__count';n.textContent=p.count+' images';box.appendChild(n)}
    }else if(p.type==='diff'){
      const f=Array.isArray(p.files)?p.files:null;
      if(!f)box.textContent='Changes are being prepared';
      else{
        const a=f.reduce((n,x)=>n+(x.added||0),0),r=f.reduce((n,x)=>n+(x.removed||0),0);
        box.textContent=`${f.length} ${f.length===1?'file':'files'} · +${a} -${r}`;
        if(f.length){const names=document.createElement('span');names.className='run-card__files';names.textContent=f.slice(0,2).map(x=>x.path).join(', ')+(f.length>2?` +${f.length-2} more`:'');box.appendChild(names)}
      }
    }else if(p.text)box.textContent=p.text;else return null;
    return box;
  }
  function runCard(item,{onOpen,rowOpen=false}={}){
    item=item||{};
    const kit=window.LocalAIKit,c=item.card||{kind:'other',icon:'system',title:item.title||'Untitled run',summary:item.summary||'',badge:kit?kit.statusBadge(item.status):{label:'',tone:'neutral'},preview:null,action:{label:'Open'},approval:null};
    const row=document.createElement('div');row.className='list-row run-card';row.dataset.runId=item.id||'';row.dataset.kind=c.kind||'';
    const open=()=>{if(onOpen)onOpen(item)};
    row.addEventListener('click',open);
    const ico=document.createElement('span');ico.className='list-row__icon';ico.innerHTML=kit?kit.icon(c.icon||'system'):'';
    const main=document.createElement('div');main.className='list-row__main run-card__main';
    const title=document.createElement('div');title.className='list-row__title';title.textContent=c.title||'Untitled run';main.appendChild(title);
    if(c.summary){const sub=document.createElement('div');sub.className='list-row__sub';sub.textContent=c.summary;main.appendChild(sub)}
    // The summary shows once: a preview that repeats it (or extends a truncated copy of it) is dropped.
    const plain=t=>String(t||'').replace(/(\.\.\.|…)\s*$/,'').replace(/\s+/g,' ').trim(),pt=plain(c.preview&&c.preview.text),sm=plain(c.summary),dup=pt&&sm&&(pt===sm||pt.startsWith(sm)||sm.startsWith(pt));
    const pv=dup?null:runPreview(c.preview);if(pv)main.appendChild(pv);
    if(ACTIVE.has(item.status)){const bar=document.createElement('div');bar.className='run-card__bar';bar.setAttribute('role','progressbar');bar.setAttribute('aria-label','Progress');bar.setAttribute('aria-valuemin','0');bar.setAttribute('aria-valuemax','100');
      const pct=Math.max(0,Math.min(100,Number(item.progress)||0));bar.setAttribute('aria-valuenow',String(pct));const fill=document.createElement('span');fill.style.setProperty('--progress',pct+'%');bar.appendChild(fill);main.appendChild(bar)}
    const act=document.createElement('button');act.type='button';act.className='btn-primary run-card__action';act.textContent=(c.action&&c.action.label)||'Open';
    act.addEventListener('click',e=>{e.stopPropagation();open()});main.appendChild(act);
    const trail=document.createElement('div');trail.className='list-row__trail';
    const b=document.createElement('span');b.className='badge badge--'+((c.badge&&c.badge.tone)||'neutral');b.textContent=(c.badge&&c.badge.label)||'';trail.appendChild(b);
    row.append(ico,main,trail);
    // rowOpen: the whole row is the tap target, and the title is the one keyboard stop (a button whose ::after covers the row).
    if(rowOpen){const btn=document.createElement('button');btn.type='button';btn.className='work-open';btn.textContent=title.textContent;title.textContent='';title.appendChild(btn);btn.addEventListener('click',e=>{e.stopPropagation();open()})}
    return row;
  }
  // A sheet that Back should close. sheetHistory(el, onClose) -> release(), where `el` is the sheet element.
  // Call it as the sheet opens: it pushes a history entry, so Back (popstate) calls onClose(el) and the person stays on the page.
  // Call release() when the sheet closes any other way: it pops that entry again (no page change, hashchange never fires), and does
  // nothing if the entry is no longer on top (the router replaces it when a link inside the sheet navigates). release() is idempotent,
  // so onClose may call it, or the sheet's own close handler may.
  // afterSheetPop(fn) runs fn once a release()'s history.back() has landed (at once if none is pending), so a second history move never overlaps it.
  // Only a live sheet's entry counts (sheetLive): one that outlived its sheet (a reload, or Forward onto it) is stale. It sits on an entry with
  // the same URL, so dropStaleSheet() steps back past it (and afterSheetPop waits for that too). Ids carry a per-load prefix, so a stale
  // 'sheet1' from before a reload never matches a new sheet's id.
  let sheetSeq=0,popPending=false,popTimer=0,popWaiters=[];
  const sheetLoad=Date.now().toString(36),liveSheets=new Set();
  const popSettled=()=>{if(!popPending)return;popPending=false;clearTimeout(popTimer);popTimer=0;popWaiters.splice(0).forEach(fn=>fn())};
  const popBack=()=>{popPending=true;clearTimeout(popTimer);popTimer=setTimeout(popSettled,500);history.back()}; // the fallback timer belongs to this pop only
  window.addEventListener('popstate',()=>setTimeout(popSettled,0));
  const afterSheetPop=fn=>{if(popPending)popWaiters.push(fn);else fn()};
  const sheetLive=id=>!!id&&liveSheets.has(id);
  const dropStaleSheet=()=>{const s=history.state&&history.state.localaiSheet;if(!s||sheetLive(s)||popPending)return false;popBack();return true};
  function sheetHistory(el,onClose){
    const id='sheet'+sheetLoad+'-'+(++sheetSeq),here=()=>history.state&&history.state.localaiSheet===id;let live=true;
    liveSheets.add(id);
    try{history.pushState({...(history.state&&typeof history.state==='object'?history.state:{}),localaiSheet:id},'',location.href)}catch{}
    const onPop=()=>{if(!live||here())return;live=false;liveSheets.delete(id);window.removeEventListener('popstate',onPop);try{if(typeof onClose==='function')onClose(el)}catch(e){console.error(e)}};
    window.addEventListener('popstate',onPop);
    return function release(){if(!live)return;live=false;liveSheets.delete(id);window.removeEventListener('popstate',onPop);if(here())popBack()};
  }
  // Each run kind can own the body of its run view: mount(run, el) fills el. Kinds with none show the Output block.
  const runBodies=new Map();
  // opts.update(run, slot) -> boolean: the same run re-rendered keeps its slot (no release, no re-mount) and is updated in place; false asks for a re-mount.
  const runBodyOpts=new Map();
  function registerRunBody(kind,mount,opts){if(typeof mount==='function'){runBodies.set(String(kind),mount);runBodyOpts.set(String(kind),opts&&typeof opts.update==='function'?opts:null)}}
  const runBodyFor=kind=>runBodies.get(String(kind))||null;
  const runBodyUpdateFor=kind=>runBodyOpts.get(String(kind))?.update||null;
  // The one status toast (#toast, role=status): a sentence after an action, long enough to read (6 s), paused while the
  // pointer or focus is on it, and emptied when it hides so nothing invisible stays in the Tab order. Errors belong in the page.
  const TOAST_MS=6000;let toastBound=false;
  function hideToast(t){clearTimeout(t._hide);t._hide=0;t.classList.remove('show','whatsnew-toast');t.replaceChildren()}
  function toastTimer(t,ms){clearTimeout(t._hide);t._hide=ms>0?setTimeout(()=>{if(!t.matches(':hover')&&!t.contains(document.activeElement))hideToast(t)},ms):0}
  function toast(message,{ms=TOAST_MS}={}){
    const t=document.getElementById('toast');if(!t)return null;
    if(!toastBound){toastBound=true;
      const pause=()=>{clearTimeout(t._hide);t._hide=0},resume=()=>{if(t.classList.contains('show')&&t._ms>0)toastTimer(t,t._ms)};
      t.addEventListener('mouseenter',pause);t.addEventListener('focusin',pause);
      t.addEventListener('mouseleave',resume);t.addEventListener('focusout',e=>{if(!t.contains(e.relatedTarget))resume()})}
    t.classList.remove('whatsnew-toast');
    if(typeof message==='string')t.textContent=message;else t.replaceChildren(message);
    t._ms=ms;t.classList.add('show');toastTimer(t,ms);return t;
  }
  // A container whose children are all run cards (Work's groups, Home's Recent, Runs) is a list of them; one that also
  // holds other rows (Home's Needs you) or none is left alone, so a listitem never sits outside a list.
  function markRunList(box){if(!box||box.nodeType!==1)return;const kids=[...box.children],all=kids.length>0&&kids.every(k=>k.classList.contains('run-card'));
    if(all){box.setAttribute('role','list');box.dataset.runList='1';kids.forEach(k=>k.setAttribute('role','listitem'))}
    else if(box.dataset.runList){box.removeAttribute('role');delete box.dataset.runList;kids.forEach(k=>{if(k.getAttribute('role')==='listitem')k.removeAttribute('role')})}}
  // Lists are often built off the page and attached whole (Work's day groups), so added subtrees are searched too.
  new MutationObserver(ms=>{const boxes=new Set();for(const m of ms){if(m.type!=='childList')continue;
    if(m.target.dataset?.runList||[...m.removedNodes].some(n=>n.classList?.contains('run-card')))boxes.add(m.target);
    for(const n of m.addedNodes){if(n.nodeType!==1)continue;if(n.classList.contains('run-card'))boxes.add(m.target);else n.querySelectorAll('.run-card').forEach(c=>boxes.add(c.parentElement))}}
    boxes.forEach(markRunList)}).observe(document.documentElement,{subtree:true,childList:true});
  window.LocalAIUI=Object.assign(window.LocalAIUI||{},{toast,hideToast:()=>{const t=document.getElementById('toast');if(t)hideToast(t)},fetchJson,loadInto,ask,runCard,sheetHistory,afterSheetPop,sheetLive,dropStaleSheet,registerRunBody,runBodyFor,runBodyUpdateFor});
})();
// Pull to refresh (touch only): on a list page that registered a refresh, a finger pulling down from the very top by
// more than 64px refreshes the page once; a small status line says "Updating…", then "Updated just now".
// pullToRefresh(viewId, fn): fn() refreshes that page and returns a promise.
(function(){'use strict';
  const PULL=64,pages=new Map();let start=null,busy=false,hideTimer=0;
  const coarse=()=>!!window.matchMedia&&matchMedia('(pointer:coarse)').matches;
  function line(){
    let el=document.getElementById('pullRefresh');
    if(!el){el=document.createElement('div');el.id='pullRefresh';el.className='pull-refresh';el.setAttribute('role','status');el.hidden=true;document.body.appendChild(el)}
    const bar=document.getElementById('uxContextBar');el.style.setProperty('--pull-top',Math.max(0,Math.round(bar?bar.getBoundingClientRect().bottom:0))+'px');
    return el;
  }
  function show(text,{dy=0,ready=false}={}){clearTimeout(hideTimer);const el=line();el.hidden=false;if(el.textContent!==text)el.textContent=text;el.classList.toggle('is-ready',ready);el.style.setProperty('--pull',Math.round(Math.min(dy,PULL*1.5))+'px')}
  function hide(ms){clearTimeout(hideTimer);hideTimer=setTimeout(()=>{const el=document.getElementById('pullRefresh');if(el){el.hidden=true;el.textContent=''}},ms)}
  const current=()=>{const v=document.querySelector('.view.active');return v&&pages.has(v.id)?v:null};
  // Not from a text field, and not while a sheet or dialog is open: only from the page's own content at the very top.
  const blocked=t=>!t||!t.closest||!!t.closest('dialog,input,textarea,select,[contenteditable="true"]')||!!document.querySelector('dialog[open]')||document.body.classList.contains('ux-sheet-open');
  document.addEventListener('touchstart',e=>{
    start=null;if(busy||e.touches.length!==1||!coarse()||window.scrollY>0)return;
    const v=current();if(!v||!v.contains(e.target)||blocked(e.target))return;
    start={x:e.touches[0].clientX,y:e.touches[0].clientY,view:v.id,dy:0};
  },{passive:true});
  document.addEventListener('touchmove',e=>{
    if(!start)return;const t=e.touches[0];if(!t)return;
    const dy=t.clientY-start.y,dx=Math.abs(t.clientX-start.x);
    if(window.scrollY>0||dy<0||dx>Math.abs(dy)){start=null;hide(0);return} // a scroll or a sideways swipe
    start.dy=dy;if(dy>12)show(dy>PULL?'Release to refresh':'Pull to refresh',{dy,ready:dy>PULL});
  },{passive:true});
  document.addEventListener('touchcancel',()=>{start=null;hide(0)},{passive:true});
  document.addEventListener('touchend',async()=>{
    const s=start;start=null;if(!s)return;
    if(s.dy<=PULL){hide(0);return}
    const fn=pages.get(s.view);if(!fn||busy)return;
    busy=true;show('Updating…');
    try{await fn();show('Updated just now');hide(2500)}
    catch{show("Couldn't update. Pull down to try again.");hide(5000)}
    finally{busy=false}
  },{passive:true});
  function pullToRefresh(view,fn){if(typeof fn==='function')pages.set(String(view),fn)}
  window.LocalAIUI=Object.assign(window.LocalAIUI||{},{pullToRefresh});
})();
