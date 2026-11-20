'use strict';

// Workbench: browse, search and edit mounted folders, fetch web pages, check URLs, inspect repos and run allow-listed commands (with a filtered environment).
// Moved from server.js unchanged (the server split: docs/superpowers/specs/2026-10-18-server-split-design.md). ctx holds
// what this code uses from the rest of the server.
function createWorkbench(ctx) {
  const { URL, WORKSPACE_ROOT, fetchWithTimeout, fs, json, path, readBody, recordActivity, requireFeature, spawn, storageError } = ctx;
  function safeWorkspacePath(rel=''){
    const clean=String(rel||'').replace(/\\/g,'/').replace(/^\/+/, ''); const root=path.resolve(WORKSPACE_ROOT); const full=path.resolve(root,clean); if(full!==root&&!full.startsWith(root+path.sep))throw new Error('Path escapes workspace'); return full;
  }
  function workspaceRel(full){return path.relative(path.resolve(WORKSPACE_ROOT),full).replace(/\\/g,'/')}
  function treeDir(full,depth=2){const out=[];if(depth<0||!fs.existsSync(full))return out;for(const e of fs.readdirSync(full,{withFileTypes:true}).slice(0,250)){if(e.name==='.git'||e.name==='node_modules')continue;const p=path.join(full,e.name);const item={name:e.name,path:workspaceRel(p),type:e.isDirectory()?'directory':'file'};if(e.isDirectory()&&depth>0)item.children=treeDir(p,depth-1);else if(e.isFile())try{item.size=fs.statSync(p).size}catch{}out.push(item)}return out}
  async function apiWorkbenchTree(req,res,urlObj){if(!requireFeature(res,5))return;try{const rel=urlObj.searchParams.get('path')||'';json(res,200,{root:WORKSPACE_ROOT,path:rel,items:treeDir(safeWorkspacePath(rel),2)})}catch(e){storageError(res,e,400)}}
  async function apiWorkbenchRead(req,res,urlObj){if(!requireFeature(res,5))return;try{const rel=urlObj.searchParams.get('path')||'';const full=safeWorkspacePath(rel);const st=fs.statSync(full);if(!st.isFile())return json(res,400,{error:'Not a file'});if(st.size>2*1024*1024)return json(res,413,{error:'File too large for editor'});json(res,200,{path:rel,content:fs.readFileSync(full,'utf8'),size:st.size,modifiedAt:st.mtime.toISOString()})}catch(e){storageError(res,e,400)}}
  function simpleDiff(before,after){const a=String(before).split('\n'),b=String(after).split('\n');let start=0;while(start<a.length&&start<b.length&&a[start]===b[start])start++;let ae=a.length-1,be=b.length-1;while(ae>=start&&be>=start&&a[ae]===b[be]){ae--;be--}const lines=[`@@ -${start+1},${Math.max(0,ae-start+1)} +${start+1},${Math.max(0,be-start+1)} @@`];for(let i=start;i<=ae;i++)lines.push('-'+a[i]);for(let i=start;i<=be;i++)lines.push('+'+b[i]);return lines.join('\n')}
  async function apiWorkbenchDiff(req,res){if(!requireFeature(res,5))return;try{const b=await readBody(req,3*1024*1024);const full=safeWorkspacePath(b.path);const before=fs.existsSync(full)?fs.readFileSync(full,'utf8'):'';const after=String(b.content||'');json(res,200,{path:b.path,diff:simpleDiff(before,after),changed:before!==after})}catch(e){storageError(res,e,400)}}
  async function apiWorkbenchWrite(req,res){if(!requireFeature(res,5))return;try{const b=await readBody(req,3*1024*1024);if(b.approved!==true)return json(res,409,{error:'Explicit approval is required',approvalRequired:true});const full=safeWorkspacePath(b.path);fs.mkdirSync(path.dirname(full),{recursive:true});let backup=null;if(fs.existsSync(full)){backup=`${full}.localai-${Date.now()}.bak`;fs.copyFileSync(full,backup)}fs.writeFileSync(full,String(b.content||''),'utf8');recordActivity('workbench','Workspace file written',String(b.path),{backup:backup?workspaceRel(backup):null});json(res,200,{ok:true,path:b.path,backup:backup?workspaceRel(backup):null,size:Buffer.byteLength(String(b.content||''),'utf8')})}catch(e){storageError(res,e,400)}}
  async function apiWorkbenchSearch(req,res){if(!requireFeature(res,5))return;try{const b=await readBody(req);const query=String(b.query||'').toLowerCase().trim();if(!query)return json(res,400,{error:'query is required'});const root=safeWorkspacePath(b.path||'');const results=[];let scannedBytes=0;const limited=()=>results.length>=100||scannedBytes>=64*1024*1024;function walk(dir,depth){if(depth>5||limited())return;for(const e of fs.readdirSync(dir,{withFileTypes:true})){if(limited())return;if(['.git','node_modules','.venv','bin','obj'].includes(e.name))continue;const p=path.join(dir,e.name);if(e.isDirectory())walk(p,depth+1);else if(e.isFile()){if(e.name.toLowerCase().includes(query))results.push({path:workspaceRel(p),match:'filename'});else{try{const st=fs.statSync(p);if(st.size<512000){scannedBytes+=st.size;const txt=fs.readFileSync(p,'utf8');const idx=txt.toLowerCase().indexOf(query);if(idx>=0)results.push({path:workspaceRel(p),match:'content',snippet:txt.slice(Math.max(0,idx-100),idx+query.length+160).replace(/\s+/g,' ')})}}catch{}}}if(results.length>=100)return}}walk(root,0);json(res,200,{results,truncated:limited()})}catch(e){storageError(res,e,400)}}
  function isPrivateIp(ip){
    if(!ip)return true;
    if(net.isIPv4(ip)){
      const p=ip.split('.').map(Number);
      if(p[0]===10||p[0]===127||p[0]===0)return true;
      if(p[0]===169&&p[1]===254)return true; // Link-local
      if(p[0]===172&&p[1]>=16&&p[1]<=31)return true; // RFC 1918
      if(p[0]===192&&p[1]===168)return true; // RFC 1918
      if(p[0]===100&&p[1]>=64&&p[1]<=127)return true; // CGNAT / Tailscale
      return false;
    }
    if(net.isIPv6(ip)){
      const l=ip.toLowerCase();
      if(l==='::1'||l==='::'||l.startsWith('fe80:')||l.startsWith('fc')||l.startsWith('fd'))return true;
      if(l.startsWith('::ffff:'))return isPrivateIp(l.slice(7));
      return false;
    }
    return true;
  }
  async function validateExternalUrl(raw){
    const u=new URL(String(raw||''));
    if(!['http:','https:'].includes(u.protocol))throw new Error('Only http/https URLs are allowed');
    const host=u.hostname;
    if(host==='localhost'||host==='127.0.0.1'||host==='::1'||host.endsWith('.local')||host.endsWith('.internal'))throw new Error('Access to private or local network hosts is blocked');
    if(net.isIP(host)){
      if(isPrivateIp(host))throw new Error('Access to private or loopback IP addresses is blocked');
    }else{
      try{
        const resolved=await dns.promises.lookup(host,{all:true});
        for(const addr of resolved){
          if(isPrivateIp(addr.address))throw new Error('Access to private or internal addresses is blocked');
        }
      }catch(e){
        if(e.message&&e.message.includes('blocked'))throw e;
        throw new Error(`Failed to resolve host: ${host}`);
      }
    }
    return u;
  }
  function stripHtml(html){return String(html||'').replace(/<script[\s\S]*?<\/script>/gi,' ').replace(/<style[\s\S]*?<\/style>/gi,' ').replace(/<[^>]+>/g,' ').replace(/&nbsp;/g,' ').replace(/&amp;/g,'&').replace(/\s+/g,' ').trim()}
  async function apiBrowserFetch(req,res){if(!requireFeature(res,6))return;try{const b=await readBody(req);const u=await validateExternalUrl(b.url);const r=await fetchWithTimeout(u.toString(),{headers:{'User-Agent':'LocalAI-Appliance/1.6'}},15000);const raw=await r.text();const ct=r.headers.get('content-type')||'';const title=/<title[^>]*>([\s\S]*?)<\/title>/i.exec(raw)?.[1]?.replace(/\s+/g,' ').trim()||u.hostname;const content=ct.includes('html')?stripHtml(raw):raw;recordActivity('browser','Fetched web page',u.toString(),{status:r.status});json(res,200,{url:u.toString(),status:r.status,title,contentType:ct,text:content.slice(0,40000),truncated:content.length>40000})}catch(e){storageError(res,e,400)}}
  async function apiHttpCheck(req,res){if(!requireFeature(res,6))return;try{const b=await readBody(req);const u=await validateExternalUrl(b.url);const started=Date.now();const r=await fetchWithTimeout(u.toString(),{method:String(b.method||'GET').toUpperCase()==='HEAD'?'HEAD':'GET'},10000);json(res,200,{url:u.toString(),status:r.status,ok:r.ok,latencyMs:Date.now()-started,contentType:r.headers.get('content-type')||''})}catch(e){storageError(res,e,400)}}
  async function apiComputerBatch(req,res){if(!requireFeature(res,6))return;try{const b=await readBody(req,5*1024*1024);if(b.approved!==true)return json(res,409,{error:'Explicit approval is required',approvalRequired:true});const ops=Array.isArray(b.operations)?b.operations.slice(0,30):[];const results=[];for(const op of ops){try{if(op.type==='mkdir'){fs.mkdirSync(safeWorkspacePath(op.path),{recursive:true});results.push({type:op.type,path:op.path,ok:true})}else if(op.type==='write'){const full=safeWorkspacePath(op.path);fs.mkdirSync(path.dirname(full),{recursive:true});let backup=null;if(fs.existsSync(full)){backup=`${full}.localai-${Date.now()}.bak`;fs.copyFileSync(full,backup)}fs.writeFileSync(full,String(op.content||''),'utf8');results.push({type:op.type,path:op.path,ok:true,backup:backup?workspaceRel(backup):null})}else if(op.type==='copy'){const src=safeWorkspacePath(op.from),dst=safeWorkspacePath(op.to);fs.mkdirSync(path.dirname(dst),{recursive:true});fs.copyFileSync(src,dst);results.push({type:op.type,from:op.from,to:op.to,ok:true})}else{results.push({type:op.type,ok:false,error:'Unsupported operation'})}}catch(e){results.push({type:op.type,path:op.path,ok:false,error:String(e.message||e)})}}recordActivity('computer','Approved computer action batch',`${results.filter(x=>x.ok).length}/${results.length} operations completed`,{});json(res,200,{results})}catch(e){storageError(res,e,400)}}
  function findGitRoot(start){
    let cur=safeWorkspacePath(start||'');
    for(let i=0;i<8;i++){if(fs.existsSync(path.join(cur,'.git')))return cur;const parent=path.dirname(cur);if(parent===cur||!parent.startsWith(path.resolve(WORKSPACE_ROOT)))break;cur=parent}
    return null;
  }
  async function apiRepoInspect(req,res,urlObj){
    if(!requireFeature(res,10))return;
    try{const rel=urlObj.searchParams.get('path')||'';const root=findGitRoot(rel);if(!root)return json(res,200,{isRepo:false,path:rel});
      const gitDir=path.join(root,'.git');let head='';try{head=fs.readFileSync(path.join(gitDir,'HEAD'),'utf8').trim()}catch{}
      let branch=head.startsWith('ref: refs/heads/')?head.slice('ref: refs/heads/'.length):'(detached)';
      let commit='';if(head.startsWith('ref:')){try{commit=fs.readFileSync(path.join(gitDir,head.slice(5)),'utf8').trim()}catch{}}else commit=head;
      json(res,200,{isRepo:true,path:workspaceRel(root),branch,commit:commit.slice(0,12)});
    }catch(e){storageError(res,e,400)}
  }
  // Child processes run model- or user-supplied commands; never hand them the appliance's secrets.
  const SECRET_ENV=/TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|PRIVATE_?KEY|CREDENTIAL/i;
  function childEnv(extra={}){const env={};for(const [k,v] of Object.entries(process.env))if(!SECRET_ENV.test(k))env[k]=v;return {...env,...extra}}
  function allowedCommand(cmd){return ['node','npm','npx','git','python3','pytest'].includes(cmd)}
  async function apiWorkbenchCommand(req,res){
    if(!requireFeature(res,10))return;
    try{const b=await readBody(req);if(b.approved!==true)return json(res,409,{error:'Explicit approval is required',approvalRequired:true});
      const cmd=String(b.command||'').trim();if(!allowedCommand(cmd))return json(res,400,{error:'Command is not allow-listed'});
      const args=Array.isArray(b.args)?b.args.map(x=>String(x)).slice(0,30):[];const cwd=safeWorkspacePath(b.cwd||'');
      const result=await new Promise((resolve,reject)=>{const child=spawn(cmd,args,{cwd,env:childEnv({CI:'1'}),shell:false});let stdout='',stderr='';const timer=setTimeout(()=>{child.kill('SIGKILL');reject(new Error('Command timed out'))},120000);child.stdout.on('data',d=>stdout+=d.toString());child.stderr.on('data',d=>stderr+=d.toString());child.on('error',reject);child.on('close',code=>{clearTimeout(timer);resolve({code,stdout:stdout.slice(-60000),stderr:stderr.slice(-60000)})})});
      recordActivity('workbench','Approved command executed',`${cmd} ${args.join(' ')}`.trim(),{cwd:b.cwd||'',code:result.code});json(res,200,result);
    }catch(e){storageError(res,e,400)}
  }
  return { apiBrowserFetch, apiComputerBatch, apiHttpCheck, apiRepoInspect, apiWorkbenchCommand, apiWorkbenchDiff, apiWorkbenchRead, apiWorkbenchSearch, apiWorkbenchTree, apiWorkbenchWrite, childEnv, safeWorkspacePath, simpleDiff, workspaceRel };
}

module.exports = { createWorkbench };
