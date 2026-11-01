import { studioApiEndpoint } from "./studio-api.js";
const form=document.querySelector("#eloquenceInterestForm");
if(form){
 const status=document.querySelector("#elStatus"),start=Date.now();
 form.addEventListener("submit",async event=>{
  event.preventDefault();if(!form.reportValidity())return;
  const data=new FormData(form),button=form.querySelector('button[type="submit"]');
  button.disabled=true;status.textContent="Sending your request…";
  try{
   const response=await fetch(studioApiEndpoint()+"/api/organizations/personal-contact",{
     method:"POST",headers:{"Content-Type":"application/json","X-Toasty-CSRF":"1"},
     body:JSON.stringify({name:data.get("name"),email:data.get("email"),subject:"Eloquence Protocol early access",message:"Early access request. Goal: "+String(data.get("goal")||"Not specified"),consent:data.get("consent")==="on",website:data.get("website"),elapsedMs:Date.now()-start})
   });
   const result=await response.json().catch(()=>({}));
   if(!response.ok||result.ok!==true)throw Error(result.error||"Unable to send request.");
   status.textContent="Your early access request has been sent.";form.reset();
  }catch(error){status.textContent=error.message||"Unable to send request.";}
  finally{button.disabled=false;}
 });
}