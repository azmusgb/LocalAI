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
  window.LocalAIUI=Object.assign(window.LocalAIUI||{},{fetchJson,loadInto});
})();
