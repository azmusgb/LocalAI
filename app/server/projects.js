'use strict';

// Projects and what is filed under them: conversations, knowledge sources (with search) and memory.
// Moved from server.js unchanged (the server split: docs/superpowers/specs/2026-10-18-server-split-design.md). ctx holds
// what this code uses from the rest of the server.
function createProjects(ctx) {
  const { CONVERSATIONS_STORE, KNOWLEDGE_STORE, MEMORY_STORE, PROJECTS_STORE, json, makeId, normalizeTitle, nowIso, objectStore, readBody, recordActivity, requireFeature, saveStore, storage, storageError } = ctx;
  function projectStore(){ return objectStore(PROJECTS_STORE); }
  function conversationStore(){ return objectStore(CONVERSATIONS_STORE); }
  function knowledgeStore(){ return objectStore(KNOWLEDGE_STORE); }
  function statePage(collection, urlObj, defaultLimit) {
    const rawLimit = urlObj.searchParams.get('limit');
    const rawOffset = urlObj.searchParams.get('offset');
    const limit = rawLimit === null ? defaultLimit : Number(rawLimit);
    const offset = rawOffset === null ? 0 : Number(rawOffset);
    if ((rawLimit !== null && !/^\d+$/.test(rawLimit)) || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000 ||
        (rawOffset !== null && !/^\d+$/.test(rawOffset)) || !Number.isSafeInteger(offset) || offset < 0) {
      const error = new Error('limit must be 1..1000 and offset must be a nonnegative integer');
      error.statusCode = 400; throw error;
    }
    const projectId = urlObj.searchParams.get('projectId') || undefined;
    return { items: storage.list(collection,{projectId,limit,offset}), total:storage.count(collection,projectId),limit,offset };
  }
  function publicProject(p){
    const conv = storage.count('conversations',p.id);
    const docs = storage.count('knowledge',p.id);
    const artifacts = storage.count('library',p.id);
    return {...p, counts:{conversations:conv, knowledge:docs, artifacts}};
  }
  async function apiProjects(req,res,urlObj){
    if(!requireFeature(res,3)) return;
    const page=statePage('projects',urlObj,250);
    json(res,200,{...page,items:page.items.map(publicProject)});
  }
  async function apiProjectsCreate(req,res){
    if(!requireFeature(res,3)) return;
    try{
      const b=await readBody(req); const name=String(b.name||'').trim();
      if(!name) return json(res,400,{error:'name is required'});
      const items=projectStore(); const item={id:makeId('prj'),name:normalizeTitle(name,'Project'),description:String(b.description||'').slice(0,1200),createdAt:nowIso(),updatedAt:nowIso(),pinned:false};
      items.unshift(item); saveStore(PROJECTS_STORE,items,250); recordActivity('project','Created project',item.name,{projectId:item.id});
      json(res,201,{item:publicProject(item)});
    }catch(e){storageError(res,e,400)}
  }
  async function apiProjectsUpdate(req,res){
    if(!requireFeature(res,3)) return;
    try{
      const b=await readBody(req); const items=projectStore(); const i=items.findIndex(x=>x.id===b.id); if(i<0)return json(res,404,{error:'Project not found'});
      if(typeof b.name==='string'&&b.name.trim())items[i].name=normalizeTitle(b.name,'Project');
      if(typeof b.description==='string')items[i].description=b.description.slice(0,1200);
      if(typeof b.pinned==='boolean')items[i].pinned=b.pinned;
      // "Use these notes in chat" on the project's Memory tab (project Memory in chat, D2): on unless set to false.
      if(b.notesInChat!==undefined){if(typeof b.notesInChat!=='boolean')return json(res,400,{error:'notesInChat must be true or false'});items[i].notesInChat=b.notesInChat}
      items[i].updatedAt=nowIso(); saveStore(PROJECTS_STORE,items,250); json(res,200,{item:publicProject(items[i])});
    }catch(e){storageError(res,e,400)}
  }
  async function apiConversations(req,res,urlObj){
    if(!requireFeature(res,3)) return;
    json(res,200,statePage('conversations',urlObj,300));
  }
  async function apiConversationSave(req,res){
    if(!requireFeature(res,3)) return;
    try{
      const b=await readBody(req,2*1024*1024); const messages=(Array.isArray(b.messages)?b.messages:[]).filter(m=>m&&(m.role==='user'||m.role==='assistant')&&typeof m.content==='string').map(m=>({role:m.role,content:m.content})); if(!messages.length)return json(res,400,{error:'messages[] is required'});
      const items=conversationStore(); let item=items.find(x=>x.id===b.id);
      const firstUser=messages.find(x=>x.role==='user')?.content||'Conversation';
      if(!item){item={id:makeId('chat'),createdAt:nowIso(),pinned:false};items.unshift(item)}
      item.projectId=String(b.projectId||item.projectId||''); item.title=normalizeTitle(b.title||item.title||firstUser,'Conversation'); item.updatedAt=nowIso(); item.messages=messages; item.webSearch=!!b.webSearch;
      saveStore(CONVERSATIONS_STORE,items,500); recordActivity('conversation','Saved conversation',item.title,{conversationId:item.id,projectId:item.projectId});
      json(res,200,{item});
    }catch(e){storageError(res,e,400)}
  }
  async function apiConversationDelete(req,res){
    if(!requireFeature(res,3)) return;
    try{const b=await readBody(req);const items=conversationStore();const next=items.filter(x=>x.id!==b.id);if(next.length===items.length)return json(res,404,{error:'Conversation not found'});saveStore(CONVERSATIONS_STORE,next,500,items);json(res,200,{ok:true})}catch(e){storageError(res,e,400)}
  }
  function chunkText(textValue, chunkSize=1800){
    const t=String(textValue||'').replace(/\r/g,'').trim(); const out=[]; if(!t)return out;
    for(let i=0;i<t.length;i+=chunkSize){out.push(t.slice(i,i+chunkSize))} return out;
  }
  function tokens(s){return String(s||'').toLowerCase().match(/[a-z0-9_\-.]{2,}/g)||[]}
  function knowledgeScore(query,textValue){
    const q=[...new Set(tokens(query))]; if(!q.length)return 0; const t=String(textValue||'').toLowerCase(); let score=0; for(const w of q){if(t.includes(w))score+=1+(t.split(w).length-2)*0.08} return score/q.length;
  }
  async function apiKnowledge(req,res,urlObj){
    if(!requireFeature(res,3)) return; const page=statePage('knowledge',urlObj,500); json(res,200,{...page,items:page.items.map(x=>({...x,chunks:undefined,content:undefined}))});
  }
  async function apiKnowledgeImport(req,res){
    if(!requireFeature(res,3)) return;
    try{
      const b=await readBody(req,6*1024*1024); const content=String(b.content||''); const name=String(b.name||'').trim(); if(!name||!content.trim())return json(res,400,{error:'name and content are required'});
      const items=knowledgeStore(); const chunks=chunkText(content); const item={id:makeId('doc'),projectId:String(b.projectId||''),name:normalizeTitle(name,'Document'),mimeType:String(b.mimeType||'text/plain'),size:Buffer.byteLength(content,'utf8'),createdAt:nowIso(),updatedAt:nowIso(),chunks,preview:content.slice(0,800)};
      items.unshift(item);saveStore(KNOWLEDGE_STORE,items,500);recordActivity('knowledge','Indexed knowledge source',item.name,{projectId:item.projectId,chunks:chunks.length});json(res,201,{item:{...item,chunks:undefined}});
    }catch(e){storageError(res,e,400)}
  }
  async function apiKnowledgeDelete(req,res){if(!requireFeature(res,3))return;try{const b=await readBody(req);const items=knowledgeStore();const next=items.filter(x=>x.id!==b.id);if(next.length===items.length)return json(res,404,{error:'Knowledge source not found'});saveStore(KNOWLEDGE_STORE,next,500,items);json(res,200,{ok:true})}catch(e){storageError(res,e,400)}}
  async function apiKnowledgeSearch(req,res){
    if(!requireFeature(res,3)) return; try{const b=await readBody(req);const query=String(b.query||'').trim();if(!query)return json(res,400,{error:'query is required'});let docs=knowledgeStore();if(b.projectId)docs=docs.filter(x=>x.projectId===b.projectId);const hits=[];for(const d of docs){(d.chunks||[]).forEach((c,i)=>{const score=knowledgeScore(query,c);if(score>0)hits.push({documentId:d.id,name:d.name,projectId:d.projectId,chunk:i,score:Number(score.toFixed(3)),text:c})})}hits.sort((a,b)=>b.score-a.score);json(res,200,{query,hits:hits.slice(0,10)})}catch(e){storageError(res,e,400)}
  }
  function memoryStore(){ return objectStore(MEMORY_STORE); }
  async function apiMemory(req,res,urlObj){
    if(!requireFeature(res,8))return;
    const projectId=urlObj.searchParams.get('projectId')||'';
    let items=memoryStore(); if(projectId)items=items.filter(x=>x.projectId===projectId);
    json(res,200,{items});
  }
  async function apiMemoryAdd(req,res){
    if(!requireFeature(res,8))return;
    try{const b=await readBody(req);const textValue=String(b.text||'').trim();if(!textValue)return json(res,400,{error:'text is required'});
      const items=memoryStore();const item={id:makeId('mem'),projectId:String(b.projectId||''),category:String(b.category||'note'),text:textValue.slice(0,4000),pinned:!!b.pinned,createdAt:nowIso(),updatedAt:nowIso()};
      items.unshift(item);saveStore(MEMORY_STORE,items,1000);recordActivity('memory','Saved project memory',item.text.slice(0,160),{projectId:item.projectId});json(res,201,{item});
    }catch(e){storageError(res,e,400)}
  }
  async function apiMemoryUpdate(req,res){
    if(!requireFeature(res,8))return;
    try{const b=await readBody(req);const items=memoryStore();const i=items.findIndex(x=>x.id===b.id);if(i<0)return json(res,404,{error:'Memory not found'});
      if(typeof b.text==='string'&&b.text.trim())items[i].text=b.text.slice(0,4000);if(typeof b.pinned==='boolean')items[i].pinned=b.pinned;if(typeof b.category==='string')items[i].category=b.category;
      items[i].updatedAt=nowIso();saveStore(MEMORY_STORE,items,1000);json(res,200,{item:items[i]});
    }catch(e){storageError(res,e,400)}
  }
  async function apiMemoryDelete(req,res){
    if(!requireFeature(res,8))return;
    try{const b=await readBody(req);const items=memoryStore();const next=items.filter(x=>x.id!==b.id);if(next.length===items.length)return json(res,404,{error:'Memory not found'});saveStore(MEMORY_STORE,next,1000,items);json(res,200,{ok:true})}catch(e){storageError(res,e,400)}
  }
  async function apiProjectIntelligence(req,res,urlObj){
    if(!requireFeature(res,8))return;
    const projectId=urlObj.searchParams.get('projectId')||'';
    const p=projectStore().find(x=>x.id===projectId); if(!p)return json(res,404,{error:'Project not found'});
    const mem=memoryStore().filter(x=>x.projectId===projectId);
    const docs=knowledgeStore().filter(x=>x.projectId===projectId);
    const conv=conversationStore().filter(x=>x.projectId===projectId);
    json(res,200,{project:publicProject(p),memory:mem.slice(0,30),summary:{knowledge:docs.length,conversations:conv.length,pinnedMemory:mem.filter(x=>x.pinned).length}});
  }
  return { apiConversationDelete, apiConversationSave, apiConversations, apiKnowledge, apiKnowledgeDelete, apiKnowledgeImport, apiKnowledgeSearch, apiMemory, apiMemoryAdd, apiMemoryDelete, apiMemoryUpdate, apiProjectIntelligence, apiProjects, apiProjectsCreate, apiProjectsUpdate, knowledgeScore, knowledgeStore, projectStore };
}

module.exports = { createProjects };
