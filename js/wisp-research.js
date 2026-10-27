var wispArea=location.pathname.indexOf('/studio')===0?'studio':location.pathname.indexOf('/peeps')===0?'peeps':'media';window.WispResearchConfig={site:'toasty-'+wispArea,page:wispArea==='media'?(location.pathname==='/'?'home':'public'):wispArea,notice:'/wisp-privacy.html'};
/* Wisp Research client. Content-free, asynchronous, consent-first collection.
 * Site config is bundled locally. Capabilities are scoped to one origin/project,
 * expire after 24h, and are never private ingestion credentials. Withdrawal stops
 * capture synchronously and revokes/deletes the session on the Research API.
 * No URLs, DOM text, forms, account ids, sensors, or cross-site visitor ids leave here.
 */
(function (w,d) {
 'use strict';
 var c=w.WispResearchConfig;
 if(!c || w.WispResearch) return;
 var base='https://santaticrm.com/research-api/v1/wisp/';
 var notice='wisp-20261028', key='wisp.research.'+c.site, tokenKey=key+'.session';
 var token='', generation=0, starting=null, controller=null, viewed=false;
 function privacy(){return navigator.globalPrivacyControl===true || navigator.doNotTrack==='1' || w.doNotTrack==='1';}
 function read(store,k){try{return store.getItem(k);}catch(_){return null;}}
 function write(store,k,v){try{if(v===null)store.removeItem(k);else store.setItem(k,v);}catch(_){}}
 function consent(){
  if(privacy())return false;
  try {return c.consent ? c.consent()===true : read(localStorage,key)==='granted';}catch(_){return false;}
 }
 function request(path,body,t,signal){return fetch(base+path,{method:'POST',mode:'cors',credentials:'omit',referrerPolicy:'no-referrer',keepalive:path==='withdraw',signal:signal,headers:Object.assign({'Content-Type':'application/json'},t?{'Authorization':'Bearer '+t}:{}),body:JSON.stringify(Object.assign({site_id:c.site},body))});}
 function revoke(t){if(t)request('withdraw',{},t).catch(function(){/* Token expires; next preference change retries current token. */});}
 function stop(){
  generation++; starting=null; viewed=false;
  if(controller)controller.abort(); controller=null;
  var old=token || read(sessionStorage,tokenKey);token='';
  write(sessionStorage,tokenKey,null);revoke(old);
 }
 function ensure(){
  if(!consent())return Promise.resolve('');
  if(token)return Promise.resolve(token);
  if(starting)return starting;
  var gen=generation;
  starting=request('consent',{analytics:true,notice_version:notice}).then(function(r){if(!r.ok)throw Error('consent refused');return r.json();}).then(function(p){
   if(gen!==generation || !consent()){revoke(p.token);return '';}
   token=p.token;write(sessionStorage,tokenKey,token);starting=null;return token;
  }).catch(function(){if(gen===generation)starting=null;return '';});
  return starting;
 }
 function random(){var bytes=new Uint8Array(16);crypto.getRandomValues(bytes);return Array.from(bytes,function(x){return x.toString(16).padStart(2,'0');}).join('');}
 function track(event,target){
  if(!consent())return Promise.resolve(false);
  var gen=generation;
  return ensure().then(function(t){
   if(!t || gen!==generation || !consent())return false;
   var payload={event:event,page:c.page,event_id:random()};if(target)payload.target=target;
   controller=controller || new AbortController();
   return request('events',payload,t,controller.signal).then(function(r){if(r.status===401){token='';write(sessionStorage,tokenKey,null);}return r.ok;}).catch(function(){return false;});
  });
 }
 function sync(){
  if(!consent()){stop();return;}
  if(!viewed){viewed=true;track('page_view');}
 }
 function preferences(){
  if(c.open){c.open();return;}
  var panel=d.getElementById('wisp-research-choice');if(panel){panel.hidden=false;panel.querySelector('button').focus();}
 }
 // Explicitly optional research consent for products with no existing analytics controls.
 function ui(){
  if(c.consent)return;
  var panel=d.createElement('aside');panel.id='wisp-research-choice';panel.setAttribute('aria-label','Optional usage analytics');
  panel.style.cssText='position:fixed;bottom:16px;left:16px;right:16px;max-width:720px;padding:18px;background:#fff;color:#18202c;border:1px solid #8993a0;border-radius:12px;z-index:10001;box-shadow:0 8px 24px #0003;font:14px/1.5 system-ui';
  var text=d.createElement('p');text.textContent='Allow optional Wisp usage analytics? Approved page views and button interactions go to Santati Research for product improvement, kept for up to 30 days. No page content, messages, answers, recordings or account identifiers are collected. You can withdraw and delete this browser session’s events in Analytics preferences.';panel.appendChild(text);
  [['Allow analytics','granted'],['Essential only','declined']].forEach(function(a){var b=d.createElement('button');b.type='button';b.textContent=a[0];b.style.cssText='padding:10px;margin:4px;border:1px solid #8993a0;border-radius:6px;background:#fff;color:#18202c;cursor:pointer';b.onclick=function(){write(localStorage,key,a[1]);panel.hidden=true;sync();};panel.appendChild(b);});
  var link=d.createElement('a');link.href=c.notice;link.textContent='Privacy and deletion';link.style.cssText='color:#234d8a;margin:8px';panel.appendChild(link);d.body.appendChild(panel);
  panel.hidden=privacy() || read(localStorage,key)!==null;
  var prefs=d.createElement('button');prefs.type='button';prefs.textContent='Analytics preferences';prefs.style.cssText='position:fixed;bottom:2px;right:8px;z-index:10000;background:#fff;color:#18202c;border:1px solid #8993a0;border-radius:5px;padding:5px;font:12px system-ui';prefs.onclick=preferences;d.body.appendChild(prefs);
 }
 function init(){
  // Reuse the current tab's capability; it never identifies an account/person.
  token=read(sessionStorage,tokenKey)||'';
  ui();sync();
  d.addEventListener('click',function(e){
   var el=e.target && e.target.closest ? e.target.closest('[data-wisp-cta], [data-wisp-research]') : null;
   if(el)track('cta_click','primary_cta');
  });
  (c.events||[]).forEach(function(ev){d.addEventListener(ev,sync);w.addEventListener(ev,sync);});
  w.addEventListener('storage',function(){sync();});
  w.addEventListener('pageshow',sync);
 }
 w.WispResearch=Object.freeze({track:track,sync:sync,openPreferences:preferences,withdraw:function(){if(!c.consent)write(localStorage,key,'declined');stop();}});
 if(d.readyState==='loading')d.addEventListener('DOMContentLoaded',init);else init();
})(window,document);
