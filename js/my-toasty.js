import {studioRequest} from "./studio-api.js";
const $=id=>document.getElementById(id);
function set(id,value){$(id).textContent=value;}
async function load(){
 try{
  const session=await studioRequest("/auth/session",{method:"GET"});
  if(!session?.authenticated){set("accountGreeting","Sign in with your Toasty account to see your available products.");set("studioAccess","Sign in required");set("peepsAccess","Sign in required");return;}
  const user=session.user||{};
  set("accountGreeting","Signed in"+(user.name?" as "+user.name:user.email?" as "+user.email:"")+".");
  $("accountSignIn").hidden=true;$("accountSignOut").hidden=false;
  if(user.isPlatformAdmin)$("accountAdmin").hidden=false;
  if(session.peepsAccess==="active"){
   set("peepsAccess",session.peepsEvaluation===true?"Evaluation access":"Access enabled");
   $("peepsOpen").href="../peeps/app/";$("peepsOpen").textContent="Open Peeps";
  }else{set("peepsAccess","Not enabled");$("peepsOpen").href="../peeps/waitlist/";$("peepsOpen").textContent="Join Peeps waitlist";}
  try{
    const organizations=await studioRequest("/api/organizations",{method:"GET"});
    const options=organizations.organizations||[];
    if(options.length){
      set("studioAccess","Workspace available");
      $("studioOpen").href="../studio/dashboard.html";$("studioOpen").textContent="Open Studio";
    }else{set("studioAccess","No workspace yet");$("studioOpen").href="../studio/sessions.html";$("studioOpen").textContent="Studio account";}
  }catch{set("studioAccess","Status unavailable");$("studioOpen").href="../studio/sessions.html";$("studioOpen").textContent="Check Studio access";}
 }catch{set("accountGreeting","Account status could not be loaded. Please try signing in.");set("studioAccess","Unavailable");set("peepsAccess","Unavailable");}
}
$("accountSignOut").addEventListener("click",async()=>{const btn=$("accountSignOut");btn.disabled=true;try{await studioRequest("/auth/logout",{method:"POST",body:"{}"});window.location.reload();}catch{set("accountGreeting","Could not sign out. Please retry.");btn.disabled=false;}});
load();