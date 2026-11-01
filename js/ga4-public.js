/* Public website GA4, only after the visitor opts in to existing analytics consent.
   No tracking in Studio or Peeps, and no tag loaded on refusal or GPC/DNT. */
(function(w,d){
  "use strict";
  var id="G-Z69LXFZ2SC", key="wisp.research.toasty-media", loaded=false, tagState="not loaded";
  var debug=new URLSearchParams(location.search).has("ga_debug");
  function report(){
    if(!debug)return;
    var box=d.getElementById("toasty-ga-debug");
    if(!box){box=d.createElement("aside");box.id="toasty-ga-debug";box.style.cssText="position:fixed;bottom:10px;left:10px;z-index:2147483647;max-width:440px;padding:15px;background:#171717;color:#fff;font:13px/1.5 monospace;border:2px solid #dcb67a;border-radius:8px";d.body.appendChild(box);}
    box.textContent="GA4 "+id+" | consent: "+(allowed()?"granted":"not granted")+" | tag: "+tagState+" | page: "+location.pathname;
  }
  function allowed(){
    // Explicit opt-in permits measurement only; all advertising storage and personalization remain denied.
    try{return localStorage.getItem(key)==="granted";}catch(_){return false;}
  }
  function sync(){
    if(!allowed()){
      report();
      if(loaded&&typeof w.gtag==="function")w.gtag("consent","update",{analytics_storage:"denied",ad_storage:"denied",ad_user_data:"denied",ad_personalization:"denied"});
      return;
    }
    if(loaded){w.gtag("consent","update",{analytics_storage:"granted"});report();return;}
    loaded=true;
    tagState="loading";report();
    w.dataLayer=w.dataLayer||[];
    w.gtag=function(){w.dataLayer.push(arguments);};
    w.gtag("consent","default",{analytics_storage:"denied",ad_storage:"denied",ad_user_data:"denied",ad_personalization:"denied"});
    w.gtag("js",new Date());
    w.gtag("consent","update",{analytics_storage:"granted"});
    w.gtag("config",id,{send_page_view:true,allow_google_signals:false,allow_ad_personalization_signals:false});
    var s=d.createElement("script");s.async=true;s.src="https://www.googletagmanager.com/gtag/js?id="+encodeURIComponent(id);s.onload=function(){tagState="loaded";report();};
    s.onerror=function(){tagState="blocked or unavailable";report();};
    d.head.appendChild(s);
  }
  w.addEventListener("toasty:analytics-consent",sync);
  w.addEventListener("storage",function(e){if(e.key===key)sync();});
  if(d.readyState==="loading")d.addEventListener("DOMContentLoaded",sync);else sync();
  if(debug)w.setTimeout(report,1500);
})(window,document);
