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
  let askSeq=0;
  function ask(o={}){
    const opener=document.activeElement,id='askSheet'+(++askSeq);
    const d=document.createElement('dialog');d.className='ask-sheet ask-sheet--'+(o.tone||'default');
    d.setAttribute('aria-labelledby',id+'t');d.setAttribute('aria-describedby',id+'d');
    // Each field is one entry here so a later option (a select, say) is one more case, not a rewrite.
    const fields=[];
    if(o.input)fields.push({name:'value',label:o.input.label||'',type:o.input.type||'text',placeholder:o.input.placeholder||'',required:!o.typed});
    if(o.typed)fields.push({name:'typed',label:`Type ${o.typed} to confirm`,type:'text',placeholder:o.typed,required:true,exact:o.typed});
    d.innerHTML=`<form method="dialog" class="ask-sheet__form" novalidate><h2 class="ask-sheet__title" id="${id}t"></h2><p class="ask-sheet__effect" id="${id}d"></p>${fields.map((f,i)=>`<label class="ask-sheet__field" for="${id}f${i}"><span></span><input id="${id}f${i}" name="${f.name}" autocomplete="off" autocapitalize="off" spellcheck="false"></label>`).join('')}<div class="ask-sheet__actions"><button type="button" class="btn-outline ask-sheet__cancel">Cancel</button><button type="submit" class="btn-primary ask-sheet__ok"></button></div></form>`;
    d.querySelector('.ask-sheet__title').textContent=o.title||'';
    const eff=d.querySelector('.ask-sheet__effect');if(o.effect)eff.textContent=o.effect;else eff.hidden=true;
    const ok=d.querySelector('.ask-sheet__ok'),cancel=d.querySelector('.ask-sheet__cancel');ok.textContent=o.confirmLabel||'Confirm';
    const inputs=[...d.querySelectorAll('input')];
    inputs.forEach((el,i)=>{const f=fields[i];el.type=f.type;el.placeholder=f.placeholder;el.previousElementSibling.textContent=f.label});
    const ready=()=>fields.every((f,i)=>f.exact?inputs[i].value===f.exact:!f.required||inputs[i].value.trim()!=='');
    const sync=()=>{ok.disabled=!ready()};sync();inputs.forEach(el=>el.addEventListener('input',sync));
    return new Promise(resolve=>{
      let out={ok:false};
      d.addEventListener('submit',e=>{e.preventDefault();if(ok.disabled)return;ok.disabled=true;cancel.disabled=true;out={ok:true};const v=fields.findIndex(f=>f.name==='value');if(v>=0)out.value=inputs[v].value.trim();d.close()});
      cancel.addEventListener('click',()=>d.close());
      d.addEventListener('click',e=>{if(e.target===d)d.close()});          // a click on the backdrop lands on the dialog itself
      d.addEventListener('close',()=>{d.remove();if(opener&&opener.isConnected&&opener.focus)opener.focus();resolve(out)});
      document.body.appendChild(d);d.showModal();(inputs[0]||cancel).focus();
    });
  }
  window.LocalAIUI=Object.assign(window.LocalAIUI||{},{fetchJson,loadInto,ask});
})();
