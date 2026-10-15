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
    const pv=runPreview(c.preview);if(pv)main.appendChild(pv);
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
  // Each run kind can own the body of its run view: mount(run, el) fills el. Kinds with none show the Output block.
  const runBodies=new Map();
  function registerRunBody(kind,mount){if(typeof mount==='function')runBodies.set(String(kind),mount)}
  const runBodyFor=kind=>runBodies.get(String(kind))||null;
  window.LocalAIUI=Object.assign(window.LocalAIUI||{},{fetchJson,loadInto,ask,runCard,registerRunBody,runBodyFor});
})();
