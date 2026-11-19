'use strict';

// Notifications (the Inbox and the phone, through notifier) and approvals.
// Moved from server.js unchanged (the server split: docs/superpowers/specs/2026-10-18-server-split-design.md). ctx holds
// what this code uses from the rest of the server.
const journalRecorders = require('../journal-recorders');

function createNotifications(ctx) {
  const { APPROVALS_STORE, NOTIFICATIONS_STORE, changeStore, decideChange, hostDetail, isInfoNotice, journalWriter, json, makeId, normalizeTitle, notifier, notifyLib, nowIso, objectStore, prependRecord, readBody, recordActivity, requireFeature, saveStore, storage, storageError } = ctx;
  function notificationStore(){ return objectStore(NOTIFICATIONS_STORE); }
  function approvalStore(){ return objectStore(APPROVALS_STORE); }
  function addNotification(kind,title,detail='',meta={},level='attention'){
    const item={id:makeId('note'),kind,level,title:normalizeTitle(title,'Notification'),detail:String(detail||'').slice(0,2000),createdAt:nowIso(),read:false,resolved:false,meta};
    prependRecord(NOTIFICATIONS_STORE,item);
    const e=notifyLib.noticeEvent(kind,item.title,item.detail,level,meta);if(e)notifier.notify(meta.approvalId?{...e,tag:`approval:${meta.approvalId}`}:e);
    return item;
  }
  async function apiNotifications(req,res){
    if(!requireFeature(res,7))return;
    // Host notices stored before hostDetail() existed still carry PowerShell's filler lines; clean them on the way out.
    const items=notificationStore().map(x=>isInfoNotice(x)&&!x.level?{...x,level:'info'}:x).map(x=>x.meta?.source==='host'&&/RemoteException/.test(x.detail||'')?{...x,detail:hostDetail(x.detail)}:x);
    json(res,200,{items,unread:items.filter(x=>!x.read&&!x.resolved&&!isInfoNotice(x)).length});
  }
  async function apiNotificationUpdate(req,res){
    if(!requireFeature(res,7))return;
    try{const b=await readBody(req);const items=notificationStore();const i=items.findIndex(x=>x.id===b.id);if(i<0)return json(res,404,{error:'Notification not found'});
      if(typeof b.read==='boolean')items[i].read=b.read;if(typeof b.resolved==='boolean')items[i].resolved=b.resolved;
      saveStore(NOTIFICATIONS_STORE,items,500);json(res,200,{item:items[i]});
    }catch(e){storageError(res,e,400)}
  }
  // A failed update is over once a later one goes live: resolve it, so it stops counting on the Inbox and the bell.
  function resolveDeployFailures(by){
    let n=0;
    storage.transaction(()=>{const items=notificationStore();for(const x of items){if(x.kind==='deploy'&&!x.resolved&&x.meta?.outcome==='failed'){x.resolved=true;x.read=true;x.meta={...x.meta,resolvedBy:`Resolved by ${by}`};n++}}if(n)saveStore(NOTIFICATIONS_STORE,items,500)});
    return n;
  }
  // Host-side jobs (auto-deploy, backups, monitors) report to the Inbox. Same LAN trust model as the rest of the API.
  const HOST_NOTIFICATION_KINDS=new Set(['deploy','backup','monitor']);
  async function apiNotificationSystem(req,res){
    try{const b=await readBody(req,64*1024);const kind=String(b.kind||'');if(!HOST_NOTIFICATION_KINDS.has(kind))return json(res,400,{error:`kind must be one of ${[...HOST_NOTIFICATION_KINDS].join(', ')}`});
      const title=String(b.title||'').trim().slice(0,200);if(!title)return json(res,400,{error:'title is required'});
      const meta=b.meta&&typeof b.meta==='object'&&!Array.isArray(b.meta)?Object.fromEntries(Object.entries(b.meta).slice(0,12).map(([k,v])=>[String(k).slice(0,40),String(v).slice(0,300)])):{};
      // Only a known success is information; anything else (failures, alerts without an outcome) needs the owner.
      const level=/^(deployed|ok|success|succeeded|recovered|done)$/i.test(meta.outcome||'')?'info':'attention';
      const item=addNotification(kind,title,hostDetail(b.detail),{source:'host',...meta},level);
      if(kind==='deploy'&&meta.outcome==='deployed')resolveDeployFailures(title.replace(/^Local AI updated to\s*/i,'')||'a later update');
      json(res,201,{item})}catch(e){storageError(res,e,400)}
  }
  async function apiNotificationSeed(req,res){
    if(!requireFeature(res,7))return;
    const item=addNotification('system','Notification center ready','Local AI v1.7 notification state is active.');
    json(res,201,{item});
  }
  async function apiApprovals(req,res){
    if(!requireFeature(res,9))return;
    json(res,200,{items:approvalStore()});
  }
  async function apiApprovalCreate(req,res){
    if(!requireFeature(res,9))return;
    try{const b=await readBody(req);const items=approvalStore();const item={id:makeId('approval'),title:normalizeTitle(b.title,'Approval required'),detail:String(b.detail||'').slice(0,4000),risk:String(b.risk||'medium'),status:'pending',createdAt:nowIso(),updatedAt:nowIso(),meta:b.meta||{}};items.unshift(item);saveStore(APPROVALS_STORE,items,500);addNotification('approval',item.title,item.detail,{approvalId:item.id});json(res,201,{item})}catch(e){storageError(res,e,400)}
  }
  async function apiApprovalDecide(req,res){
    if(!requireFeature(res,9))return;
    try{const b=await readBody(req);const items=approvalStore();const i=items.findIndex(x=>x.id===b.id);if(i<0)return json(res,404,{error:'Approval not found'});
      if(!['approved','rejected'].includes(b.decision))return json(res,400,{error:'decision must be approved or rejected'});
      // An approval for a change decides the change as well; otherwise approving it here left the change waiting forever.
      const changeId=items[i].meta?.changeId;
      if(changeId&&items[i].status==='pending'){const changes=changeStore(),c=changes.find(x=>x.id===changeId);
        if(c&&c.status==='awaiting_approval'){decideChange(changes,c,b.decision);recordActivity('approval',`Approval ${b.decision}`,items[i].title,{approvalId:items[i].id,changeId});const item=approvalStore().find(x=>x.id===b.id)||items[i];journalRecorders.record(journalWriter,()=>journalRecorders.approvalEntry({...item,status:b.decision},{where:'app'}));return json(res,200,{item})}}
      items[i].status=b.decision;items[i].updatedAt=nowIso();saveStore(APPROVALS_STORE,items,500);recordActivity('approval',`Approval ${b.decision}`,items[i].title,{approvalId:items[i].id});journalRecorders.record(journalWriter,()=>journalRecorders.approvalEntry(items[i],{where:'app'}));json(res,200,{item:items[i]});
    }catch(e){storageError(res,e,400)}
  }
  return { addNotification, apiApprovalCreate, apiApprovalDecide, apiApprovals, apiNotificationSeed, apiNotificationSystem, apiNotificationUpdate, apiNotifications, approvalStore, notificationStore, resolveDeployFailures };
}

module.exports = { createNotifications };
