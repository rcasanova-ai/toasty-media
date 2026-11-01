/* Public website GA4, only after the visitor opts in to existing analytics consent.
   No tracking in Studio or Peeps, and no tag loaded on refusal or GPC/DNT. */
(function(w,d){
  "use strict";
  var id="G-Z69LXFZ2SC", key="wisp.research.toasty-media", loaded=false;
  function allowed(){
    if(navigator.globalPrivacyControl===true||navigator.doNotTrack==="1"||w.doNotTrack==="1")return false;
    try{return localStorage.getItem(key)==="granted";}catch(_){return false;}
  }
  function sync(){
    if(!allowed()){
      if(loaded&&typeof w.gtag==="function")w.gtag("consent","update",{analytics_storage:"denied",ad_storage:"denied",ad_user_data:"denied",ad_personalization:"denied"});
      return;
    }
    if(loaded){w.gtag("consent","update",{analytics_storage:"granted"});return;}
    loaded=true;
    w.dataLayer=w.dataLayer||[];
    w.gtag=function(){w.dataLayer.push(arguments);};
    w.gtag("consent","default",{analytics_storage:"denied",ad_storage:"denied",ad_user_data:"denied",ad_personalization:"denied"});
    w.gtag("js",new Date());
    w.gtag("consent","update",{analytics_storage:"granted"});
    w.gtag("config",id,{send_page_view:true,allow_google_signals:false,allow_ad_personalization_signals:false});
    var s=d.createElement("script");s.async=true;s.src="https://www.googletagmanager.com/gtag/js?id="+encodeURIComponent(id);d.head.appendChild(s);
  }
  w.addEventListener("toasty:analytics-consent",sync);
  w.addEventListener("storage",function(e){if(e.key===key)sync();});
  if(d.readyState==="loading")d.addEventListener("DOMContentLoaded",sync);else sync();
})(window,document);
