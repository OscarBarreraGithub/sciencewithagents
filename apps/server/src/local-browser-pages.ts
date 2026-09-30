import { createHash } from 'node:crypto';
import type { BrowserDraftTransfer as Transfer } from '@dock/shared';
export { browserDraftTransferSchema } from '@dock/shared';
const literal = (value: unknown) =>
  JSON.stringify(value)
    .replaceAll('<', '\\u003c')
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029');
const prefix = 'dock:local-access:';

/** Transient, no-cache pages. No provider requests, archive writes or action replay. */
export function localPage(title: string, text: string, script: string, formAction = "'none'") {
  const hash = createHash('sha256').update(script).digest('base64');
  return {
    csp: `default-src 'none'; script-src 'sha256-${hash}'; style-src 'unsafe-inline'; connect-src 'self'; form-action ${formAction}; base-uri 'none'; frame-ancestors 'none'`,
    html: `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="referrer" content="origin"><title>${title} · sciencewithagents</title><style>
      *{box-sizing:border-box}body{margin:0;background:#f6f8f7;color:#222b3c;font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;padding:clamp(18px,6vw,70px)}main{max-width:520px;margin:5vh auto;background:white;border:1px solid #dfe5e8;border-radius:24px;padding:clamp(22px,5vw,38px)}small{color:#5966e4}h1{font-size:clamp(26px,5vw,34px);line-height:1.2;letter-spacing:-.04em;margin:18px 0}p{color:#657084}button,a.action{font:inherit;border:1px solid #dce0ea;background:#eef0ff;color:#26306d;padding:12px 17px;border-radius:12px;cursor:pointer;text-decoration:none;display:inline-block;margin:6px 8px 6px 0}button:focus-visible,a:focus-visible{outline:3px solid #5966e4;outline-offset:3px}[hidden]{display:none!important}.error{color:#a43437}a{color:#394bc3}textarea{width:100%;min-height:170px;font:inherit}
      </style><main><small>sciencewithagents.</small><h1>${title}</h1><p id="state" role="status">${text}</p><div id="actions"></div></main><script>${script}</script></html>`,
  };
}
const helpers = String.raw`
const state=document.getElementById('state'),actions=document.getElementById('actions');
function button(label,fn){const b=document.createElement('button');b.type='button';b.textContent=label;b.onclick=fn;actions.append(b);return b;}
function link(label,href){const a=document.createElement('a');a.className='action';a.textContent=label;a.href=href;actions.append(a);return a;}
function fail(message){state.className='error';state.setAttribute('role','alert');state.textContent=message;}
function post(target,fields){const f=document.createElement('form');f.method='POST';f.action=target+(location.hash.startsWith('#/')?location.hash:'');for(const [name,value] of Object.entries(fields)){const i=document.createElement('input');i.type='hidden';i.name=name;i.value=value;f.append(i);}document.body.append(f);f.submit();}
function download(value){const blob=new Blob([JSON.stringify(value,null,2)],{type:'application/json'});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download='sciencewithagents-retained-browser-drafts.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),30000);}
`;

export function restorePage(source: string, recover: boolean, legacyOrigin: string) {
  const script =
    helpers +
    `\nconst source=${literal(source)},recover=${literal(recover)},marker=${literal(`${prefix}migrated:${legacyOrigin}`)};` +
    String.raw`
let busy=false,waiting=false;
const workspace=()=>'/'+(location.hash.startsWith('#/')?location.hash:'');
async function connect(){
 if(busy)return;busy=true;waiting=false;actions.replaceChildren();state.className='';state.setAttribute('role','status');state.textContent='Connecting this browser and checking its retained drafts…';
 try{
  const migrated=!recover && localStorage.getItem(marker)==='1';
  const response=await fetch(migrated?'/api/local-access/status':'/api/local-access/migrate',migrated?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({source,recover})});
  if(!response.ok){
   if(response.status===401){waiting=true;fail('Open the installed sciencewithagents app on this computer. Return to this tab and it will reconnect automatically. Your drafts are still here.');link('Open desktop app','sciencewithagents://open');button('Check connection',connect);return;}
   throw Error('The browser could not reconnect. Your retained drafts have not been changed.');
  }
  if(migrated){location.replace(workspace());return;}
  const value=await response.json();post(value.target,{ticket:value.ticket});
 }catch(error){fail(error.message||'Your browser storage is unavailable. Existing drafts have not been removed.');button('Try again',connect);}
 finally{busy=false;}
}
window.addEventListener('focus',()=>{if(waiting)connect();});
document.addEventListener('visibilitychange',()=>{if(waiting&&!document.hidden)connect();});
connect();`;
  return localPage(
    'Reconnect your workspace',
    'Your work stays on this computer.',
    script,
    legacyOrigin,
  );
}

export function exportPage(ticket: string, destination: string) {
  const script =
    helpers +
    `\nconst ticket=${literal(ticket)},destination=${literal(destination)};` +
    String.raw`
let saved;
function collect(storage){const values=[];for(let n=0;n<storage.length;n++){const key=storage.key(n);if(key&&key.startsWith('dock:')&&!key.startsWith('dock:local-access:'))values.push([key,storage.getItem(key)]);}return values;}
function transfer(){
 actions.replaceChildren();state.className='';state.textContent='Keeping your drafts and pending requests. Nothing will be sent to an agent.';
 try{
  saved={version:1,local:collect(localStorage),session:collect(sessionStorage)};
  const text=JSON.stringify(saved);
  if(new Blob([text]).size>2*1024*1024)throw Error('These retained drafts are too large to move automatically. Download a recovery copy before continuing. The original drafts remain at this address.');
  post(destination+'/api/local-access/import',{ticket,drafts:text});
 }catch(error){fail(error.message||'This browser could not read its drafts. They have not been removed.');if(saved)button('Download retained drafts',()=>download(saved));button('Try again',transfer);link('Open workspace',destination+'/');}
}
transfer();`;
  return localPage(
    'Keeping your drafts',
    'Moving this tab to its private local address.',
    script,
    destination,
  );
}

export function importPage(payload: Transfer, source: string, recover: boolean) {
  const script =
    helpers +
    `\nconst saved=${literal(payload)},source=${literal(source)},recover=${literal(recover)},prefix=${literal(prefix)};` +
    String.raw`
const marker=prefix+'migrated:'+source;
const conflicts=[];
const workspace='/'+(location.hash.startsWith('#/')?location.hash:'');
try{
 const already=localStorage.getItem(marker)==='1';
 for(const [kind,values] of [['local',saved.local],['session',saved.session]]){
  const storage=kind==='local'?localStorage:sessionStorage;
  for(const [key,value] of values){
   const previous=storage.getItem(key);
   if(previous===value)continue;
   // Local keys may have been intentionally cleared after a previous migration.
   // Do not resurrect old pending requests when reconnecting another old tab.
   if((kind==='local'&&already)||previous!==null){if(recover||!already||kind==='session')conflicts.push({kind,key,value});continue;}
   storage.setItem(key,value);
  }
 }
 if(conflicts.length){
  localStorage.setItem(prefix+'retained:'+crypto.randomUUID(),JSON.stringify({version:1,source,createdAt:new Date().toISOString(),entries:conflicts}));
 }
 localStorage.setItem(marker,'1');
 if(!conflicts.length)location.replace(workspace);
 else{
  state.textContent='Your existing drafts stay in place. Some retained versions differ, so a separate browser recovery copy is saved. No pending request was resent.';
  button('Download retained versions',()=>download({version:1,source,entries:conflicts}));
  link('Review retained drafts','/#/recovery');link('Open workspace',workspace);
 }
}catch(error){
 fail('This browser could not store every retained draft. Nothing was removed from the old address. Download a recovery copy before continuing.');
 button('Download retained drafts',()=>download(saved));link('Open workspace',workspace);
}
`;
  return localPage(
    'Your drafts are retained',
    'Checking saved versions before opening your workspace.',
    script,
  );
}
