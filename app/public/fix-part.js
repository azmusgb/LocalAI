// Images › Fix a part: circle one part of a finished picture and redraw only that part, two ways, then keep the one you
// like. The mask is a soft ellipse (fully white inside, fading to black over its outer 15%), which blends far better
// than a hard-edged area; the brush adds to it. The pure helpers (window.LocalAIFixPart) are tested in Node; the page
// wiring waits for app.js (a module) to expose window.LocalAIImages.
(function(){
'use strict';
const FEATHER=0.15,TINT='92,184,255',SHOW=0.55;
// The chips: each fills the "What to change" box with plain words the image model follows well.
const PRESETS=[
  {id:'hands',label:'Hands',text:'natural hands with five fingers each'},
  {id:'face',label:'Face',text:'a natural face with clear, even eyes'},
  {id:'ears',label:'Ears',text:'bigger, clearer ears'},
  {id:'remove',label:'Remove object',text:'nothing here, same background as around it'}];
// A tap or a drag on the picture -> the ellipse to redraw ({cx,cy,rx,ry}, in the picture's pixels). A drag's whole path
// counts (corner to corner, or a loop around the part); its box is widened so the soft edge falls outside the part.
// A tap (under 12 px of movement) circles a part around it, about a third of the picture's short side across.
function ellipseFromPath(points,w,h){
  const xs=points.map(p=>p[0]),ys=points.map(p=>p[1]),x0=Math.min(...xs),x1=Math.max(...xs),y0=Math.min(...ys),y1=Math.max(...ys);
  if(Math.max(x1-x0,y1-y0)<12){const r=Math.round(Math.min(w,h)*0.16);return {cx:points[0][0],cy:points[0][1],rx:r,ry:r}}
  const grow=1/(1-FEATHER),min=16;
  return {cx:(x0+x1)/2,cy:(y0+y1)/2,rx:Math.max(min,(x1-x0)/2*grow),ry:Math.max(min,(y1-y0)/2*grow)};
}
// One value per pixel: 255 inside, a smooth fall to 0 over the outer `feather` of the radius, 0 outside.
function ellipseMask(w,h,e,feather=FEATHER){
  const out=new Uint8ClampedArray(w*h);if(!e||!(e.rx>0)||!(e.ry>0))return out;
  const f=Math.max(0.01,Math.min(1,feather)),x0=Math.max(0,Math.floor(e.cx-e.rx)),x1=Math.min(w,Math.ceil(e.cx+e.rx)),y0=Math.max(0,Math.floor(e.cy-e.ry)),y1=Math.min(h,Math.ceil(e.cy+e.ry));
  for(let y=y0;y<y1;y++){const dy=(y+.5-e.cy)/e.ry;for(let x=x0;x<x1;x++){const dx=(x+.5-e.cx)/e.rx,d=Math.sqrt(dx*dx+dy*dy);if(d>=1)continue;const t=(1-d)/f;out[y*w+x]=t>=1?255:Math.round(255*t*t*(3-2*t))}}
  return out;
}
// The mask the server reads (its red channel is the area to repaint): grey levels from the ellipse, full white where the
// brush painted (`strokes` is that layer's RGBA, any alpha counts), opaque everywhere.
function maskPixels(w,h,e,strokes){
  const v=ellipseMask(w,h,e),px=new Uint8ClampedArray(w*h*4);
  for(let i=0;i<v.length;i++){const m=strokes&&strokes[i*4+3]>0?255:v[i];px[i*4]=px[i*4+1]=px[i*4+2]=m;px[i*4+3]=255}
  return px;
}
// What to change first, then the scene it belongs in (the picture's own prompt), so the model keeps the rest consistent.
function composePrompt(fix,scene){
  const a=String(fix||'').trim().replace(/[\s.,;:]+$/,''),b=String(scene||'').trim();
  return a?(b?`${a}. ${b}`:a):'';
}
// The request: an ordinary masked edit at full strength, two variations, no prompt rewriting (it would bury the fix).
function fixBody({fix,scene,source,mask,width,height,strength=1,engine,style}){
  return {prompt:composePrompt(fix,scene),source,mask,sourceWidth:width,sourceHeight:height,strength,count:2,engine,style:style||'none',enhance:false,upscale:false};
}
window.LocalAIFixPart={PRESETS,FEATHER,ellipseFromPath,ellipseMask,maskPixels,composePrompt,fixBody};

function init(){
  const I=window.LocalAIImages,$=id=>document.getElementById(id),c=$('imageMaskCanvas');if(!I||!$('imageFixPart')||!c)return;
  const ui=I.ui,esc=s=>String(s??'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
  const hint=t=>{$('imageEditHint').textContent=t};
  const HINT={circle:'Tap the part to fix, or drag around it.',brush:'Paint to add to the area. Switch back to Circle to move it.',done:'Circled. Tap or drag again to move it, or use Brush to add more.'};
  $('imageFixChips').innerHTML=PRESETS.map(p=>`<button type="button" class="img-fix-chip" data-fix-preset="${p.id}" aria-pressed="false">${esc(p.label)}</button>`).join('');
  const setMode=m=>{if(ui.fix)ui.fix.mode=m;document.querySelectorAll('[data-fix-mode]').forEach(b=>{const on=b.dataset.fixMode===m;b.classList.toggle('active',on);b.setAttribute('aria-checked',String(on))});hint(m==='brush'?HINT.brush:ui.fix?.ellipse?HINT.done:HINT.circle)};
  const pressChip=id=>document.querySelectorAll('[data-fix-preset]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.fixPreset===id)));
  // The overlay: the soft ellipse (drawn once per circle), the brush layer over it, and the outline while dragging.
  function render(path){
    const fix=ui.fix;if(!fix)return;const ctx=c.getContext('2d'),{width:w,height:h}=c;ctx.clearRect(0,0,w,h);
    if(fix.ellipse){if(!fix.shown){const v=ellipseMask(w,h,fix.ellipse),img=ctx.createImageData(w,h),[r,g,b]=TINT.split(',').map(Number);for(let i=0;i<v.length;i++){if(!v[i])continue;img.data[i*4]=r;img.data[i*4+1]=g;img.data[i*4+2]=b;img.data[i*4+3]=Math.round(v[i]*SHOW)}
      fix.shown=document.createElement('canvas');fix.shown.width=w;fix.shown.height=h;fix.shown.getContext('2d').putImageData(img,0,0)}ctx.drawImage(fix.shown,0,0)}
    if(fix.strokes)ctx.drawImage(fix.strokes,0,0);
    if(path){const e=ellipseFromPath(path,w,h);ctx.save();ctx.strokeStyle=`rgb(${TINT})`;ctx.lineWidth=Math.max(2,w/256);ctx.setLineDash([ctx.lineWidth*4,ctx.lineWidth*3]);ctx.beginPath();ctx.ellipse(e.cx,e.cy,e.rx,e.ry,0,0,Math.PI*2);ctx.stroke();ctx.restore()}
  }
  const pt=e=>{const r=c.getBoundingClientRect();return [(e.clientX-r.left)*c.width/r.width,(e.clientY-r.top)*c.height/r.height]};
  let path=null,last=null;
  const brush=p=>{const fix=ui.fix,ctx=fix.strokes.getContext('2d'),size=Number($('imageBrush').value)*c.width/Math.max(1,c.getBoundingClientRect().width);ctx.strokeStyle=ctx.fillStyle=`rgba(${TINT},${SHOW})`;ctx.lineWidth=size;ctx.lineCap='round';
    ctx.beginPath();if(last){ctx.moveTo(...last);ctx.lineTo(...p);ctx.stroke()}else{ctx.arc(p[0],p[1],size/2,0,Math.PI*2);ctx.fill()}last=p;fix.painted=true;render()};
  // Capture listeners on the canvas run before app.js's brush and stop it: while fixing, this owns the canvas.
  c.addEventListener('pointerdown',e=>{if(!ui.fix||!ui.edit)return;e.stopImmediatePropagation();e.preventDefault();try{c.setPointerCapture(e.pointerId)}catch{}
    if(ui.fix.mode==='brush'){last=null;path=null;ui.fix.brushing=true;brush(pt(e))}else{path=[pt(e)];render(path)}},true);
  c.addEventListener('pointermove',e=>{if(!ui.fix)return;e.stopImmediatePropagation();if(ui.fix.brushing)brush(pt(e));else if(path){path.push(pt(e));render(path)}},true);
  const end=e=>{const fix=ui.fix;if(!fix)return;e.stopImmediatePropagation();fix.brushing=false;last=null;if(!path)return;fix.ellipse=ellipseFromPath(path,c.width,c.height);fix.shown=null;path=null;render();hint(HINT.done)};
  c.addEventListener('pointerup',end,true);c.addEventListener('pointercancel',end,true);
  $('imageMaskClear').addEventListener('click',e=>{const fix=ui.fix;if(!fix)return;e.stopImmediatePropagation();fix.ellipse=null;fix.shown=null;fix.painted=false;fix.strokes.getContext('2d').clearRect(0,0,c.width,c.height);render();setMode(fix.mode)},true);
  $('imageFixMode').addEventListener('click',e=>{const b=e.target.closest('[data-fix-mode]');if(b)setMode(b.dataset.fixMode)});
  $('imageFixChips').addEventListener('click',e=>{const b=e.target.closest('[data-fix-preset]');const p=b&&PRESETS.find(x=>x.id===b.dataset.fixPreset);if(!p)return;$('imageFixPrompt').value=p.text;pressChip(p.id)});
  $('imageFixPrompt').addEventListener('input',()=>{const p=PRESETS.find(x=>x.text===$('imageFixPrompt').value.trim());pressChip(p?.id)});
  $('imageFixPrompt').addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();go()}});
  $('imageFixPart').addEventListener('click',()=>{const l=ui.last;if(!l?.imageUrl||ui.busy)return;ui.editThread=ui.threadId;
    const fix={mode:'circle',ellipse:null,shown:null,painted:false,strokes:null,scene:l.prompt||'',from:{imageUrl:l.imageUrl,engine:l.engine,style:l.style}};
    I.edit(l.imageUrl,fix,(w,h)=>{fix.strokes=document.createElement('canvas');fix.strokes.width=w;fix.strokes.height=h;$('imageFixPrompt').value='';pressChip(null);setMode('circle');render()})});
  async function go(){
    const fix=ui.fix;if(!fix||!ui.edit||ui.busy)return;const ask=$('imageFixPrompt').value.trim();
    if(!fix.ellipse&&!fix.painted){hint('Tap or circle the part to fix first.');return}
    if(!ask){hint('Say what to change, or pick one of the buttons.');$('imageFixPrompt').focus();return}
    const {w,h}=ui.edit,m=document.createElement('canvas');m.width=w;m.height=h;const mc=m.getContext('2d'),img=mc.createImageData(w,h);
    img.data.set(maskPixels(w,h,fix.ellipse,fix.painted?fix.strokes.getContext('2d').getImageData(0,0,w,h).data:null));mc.putImageData(img,0,0);
    const engine=I.engines().some(e=>e.id===fix.from.engine)?fix.from.engine:ui.engine;
    const body=fixBody({fix:ask,scene:fix.scene,source:$('imageEditCanvas').toDataURL('image/png'),mask:m.toDataURL('image/png'),width:w,height:h,strength:Number($('imageStrength').value)/100,engine,style:fix.from.style});
    $('imageFixGo').disabled=true;
    try{const j=await I.generate(body);if(j?.images?.length){ui.last.prompt=fix.scene;compare(j,fix)}}finally{$('imageFixGo').disabled=false}
  }
  $('imageFixGo').addEventListener('click',go);
  // The results: the original beside each new version; tapping a picture shows it large, Keep keeps that one.
  function compare(j,fix){
    const box=$('imageFixCompare'),images=j.images,bust=I.bust;$('imageBatch').hidden=true;
    const pic=(url,i,label)=>`<figure class="img-fix-compare__item"><button type="button" class="img-thumb img-fix-compare__pic" data-fix-show="${i}" aria-label="Show ${esc(label)} larger"><img alt="${esc(label)}" src="${esc(bust(url)||'')}"></button><figcaption>${esc(label)}</figcaption>${i>=0?`<button type="button" class="btn-primary" data-fix-keep="${i}" aria-label="Keep ${esc(label)}">Keep</button>`:''}</figure>`;
    box.innerHTML=`<p class="img-fix-compare__head"><b>Keep the one you like.</b> The other is deleted, with Undo. Not right? Change the circle or the words and tap Fix it again.</p><div class="img-fix-compare__grid">${pic(fix.from.imageUrl,-1,'Original')}${images.map((im,i)=>pic(im.imageUrl,i,`Fix ${i+1}`)).join('')}</div>`;
    box.hidden=false;box.scrollIntoView?.({block:'nearest',behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'});
    box.onclick=async e=>{const s=e.target.closest('[data-fix-show]'),k=e.target.closest('[data-fix-keep]');
      if(s){const i=Number(s.dataset.fixShow),u=bust(i<0?fix.from.imageUrl:images[i].imageUrl);$('generatedImage').src=u;$('imageOpen').href=u;return}
      if(!k)return;const i=Number(k.dataset.fixKeep),chosen=images[i],others=images.filter((_,n)=>n!==i);k.disabled=true;
      try{await I.reload();const ids=I.library().filter(x=>x.kind==='image'&&others.some(o=>o.imageUrl===x.meta?.imageUrl)).map(x=>({kind:'library',id:x.id}));
        if(ids.length&&!(await window.LocalAIUI.deleteItems(ids,{onUndo:()=>I.reload()})))return;
        const meta=$('imageMeta').textContent.replace(/seed \d+/,`seed ${chosen.seed}`),thread=ui.threadId;
        I.stop();I.show(chosen.imageUrl,meta,null,fix.scene,thread);Object.assign(ui.last,{engine:fix.from.engine,style:fix.from.style,seed:chosen.seed});await I.reload();
        if(!ids.length)window.LocalAIUI?.toast?.('Kept.');
      }finally{if(k.isConnected)k.disabled=false}};
  }
}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else init();
})();
