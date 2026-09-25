#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT=join(dirname(fileURLToPath(import.meta.url)),"..");
const PORT=4226;
const BASE=`http://127.0.0.1:${PORT}`;
const scratch=mkdtempSync(join(tmpdir(),"toasty-platform-admin-"));
const dbPath=join(scratch,"toasty.sqlite");
const helper=join(ROOT,"scripts","toasty-auth-db.py");
function assert(v,m){if(!v)throw new Error("FAILED: "+m);console.log("ok - "+m);}
function cookieFrom(r){return (r.headers.get("set-cookie")||"").split(";")[0];}
async function req(path,{method="GET",cookie,body}={}){
  const headers={"x-toasty-csrf":"1"}; if(cookie)headers.cookie=cookie; if(body!==undefined)headers["content-type"]="application/json";
  const r=await fetch(BASE+path,{method,headers,body:body!==undefined?JSON.stringify(body):undefined});
  let data={}; try{data=await r.json();}catch{}
  return {status:r.status,data,cookie:cookieFrom(r)||cookie};
}
async function waitHealth(){for(let i=0;i<60;i++){try{if((await fetch(BASE+"/health")).ok)return;}catch{} await new Promise(r=>setTimeout(r,100));}throw new Error("server did not start");}
function scalar(sql){const r=spawnSync("python3",["-c",`import sqlite3,sys
c=sqlite3.connect(${JSON.stringify(dbPath)})
r=c.execute(sys.argv[1]).fetchone()
print(r[0] if r else "")`,sql],{encoding:"utf8"});if(r.status!==0)throw new Error(r.stderr);return r.stdout.trim();}

const server=spawn("node",[join(ROOT,"scripts","render-production-server.mjs")],{
  env:{...process.env,TOASTY_RENDER_PORT:String(PORT),TOASTY_AUTH_DB:dbPath,TOASTY_AUTH_DB_HELPER:helper,TOASTY_SESSION_SECRET:"platform-admin-test",DEEPSEEK_API_KEY:"founder-test-key",RESEND_API_KEY:""},
  stdio:["ignore","pipe","pipe"]
});
let output="";server.stdout.on("data",c=>output+=c);server.stderr.on("data",c=>output+=c);

async function main(){
  await waitHealth();

  const founder=await req("/auth/register",{method:"POST",body:{name:"Founder",email:"founder@example.com",password:"password10chars"}});
  assert(founder.status===201,"founder registers");
  const founderSession=await req("/auth/session",{cookie:founder.cookie});
  assert(founderSession.data.user?.isPlatformAdmin===true,"earliest organization owner bootstraps as platform admin");
  assert(founderSession.data.user?.platformRole==="platform_admin","platform role is exposed to the authenticated UI");
  assert(scalar("SELECT COUNT(*) FROM users WHERE platform_role='platform_admin'")==="1","exactly one platform admin is bootstrapped");

  const status=await req("/api/organizations/platform-admin/status",{cookie:founder.cookie});
  assert(status.status===200,"platform admin can read operator status");
  assert(status.data.providers?.deepseek?.configured===true,"server DeepSeek key is visible as configured without exposing the key");
  assert(status.data.founderAiFallback===true,"founder DeepSeek path is enabled");

  const second=await req("/auth/register",{method:"POST",body:{name:"Customer",email:"customer@example.com",password:"password10chars"}});
  assert(second.status===201,"second user registers");
  const secondSession=await req("/auth/session",{cookie:second.cookie});
  assert(secondSession.data.user?.isPlatformAdmin===false,"later customers are not platform admins");
  const forbidden=await req("/api/organizations/platform-admin/status",{cookie:second.cookie});
  assert(forbidden.status===403,"normal customer cannot access platform admin APIs");

  const orgs=await req("/api/organizations/platform-admin/organizations",{cookie:founder.cookie});
  assert(orgs.status===200 && orgs.data.organizations.length===2,"platform admin can list all organizations");
  const customerOrg=orgs.data.organizations.find(o=>o.ownerUserId===second.data.user.id);
  assert(Boolean(customerOrg),"customer organization is visible to operator");

  const setPlan=await req(`/api/organizations/platform-admin/organizations/${customerOrg.id}/plan`,{method:"POST",cookie:founder.cookie,body:{plan:"pro",subscriptionStatus:"active"}});
  assert(setPlan.status===200 && setPlan.data.organization.plan==="pro","platform admin can change an organization plan");
  const reset=await req(`/api/organizations/platform-admin/organizations/${customerOrg.id}/reset-usage`,{method:"POST",cookie:founder.cookie,body:{}});
  assert(reset.status===200,"platform admin can reset organization usage");


  const detail=await req(`/api/organizations/platform-admin/organizations/${customerOrg.id}/detail`,{cookie:founder.cookie});
  assert(detail.status===200 && detail.data.organization.id===customerOrg.id,"platform admin can inspect a full customer organization");
  assert(Array.isArray(detail.data.members) && detail.data.members[0]?.userEmail==="customer@example.com","detail includes customer members without exposing secrets");
  const detailForbidden=await req(`/api/organizations/platform-admin/organizations/${customerOrg.id}/detail`,{cookie:second.cookie});
  assert(detailForbidden.status===403,"normal customer cannot use platform organization detail API");

  const basics=await req(`/api/organizations/platform-admin/organizations/${customerOrg.id}/basics`,{method:"POST",cookie:founder.cookie,body:{name:"Customer Updated",slug:"customer-updated"}});
  assert(basics.status===200 && basics.data.organization.name==="Customer Updated","platform admin can edit customer organization identity");

  const settings=await req(`/api/organizations/platform-admin/organizations/${customerOrg.id}/settings`,{method:"POST",cookie:founder.cookie,body:{websiteUrl:"https://example.com",timezone:"Asia/Bangkok",defaultCTA:{label:"Book"}}});
  assert(settings.status===200 && settings.data.settings.websiteUrl==="https://example.com","platform admin can edit customer organization settings");

  const onboardingReset=await req(`/api/organizations/platform-admin/organizations/${customerOrg.id}/onboarding`,{method:"POST",cookie:founder.cookie,body:{completed:false}});
  assert(onboardingReset.status===200 && !onboardingReset.data.settings.onboardingCompletedAt,"platform admin can reset onboarding");
  const onboardingDone=await req(`/api/organizations/platform-admin/organizations/${customerOrg.id}/onboarding`,{method:"POST",cookie:founder.cookie,body:{completed:true}});
  assert(onboardingDone.status===200 && onboardingDone.data.settings.onboardingCompletedAt,"platform admin can mark onboarding complete");

  const billing=await req(`/api/organizations/platform-admin/organizations/${customerOrg.id}/billing-account`,{method:"POST",cookie:founder.cookie,body:{billingEmail:"billing@example.com",currency:"usd",preferredPaymentMethod:"manual"}});
  assert(billing.status===200 && billing.data.billingAccount.billingEmail==="billing@example.com","platform admin can edit billing account metadata");

  const brand=await req(`/api/organizations/platform-admin/organizations/${customerOrg.id}/brand-profile`,{method:"POST",cookie:founder.cookie,body:{name:"Customer Brand",baseThemeId:"toasty",overrides:{accent:"#fff"}}});
  assert(brand.status===200 && brand.data.brandProfile.organizationId===customerOrg.id,"platform admin can create customer brand profiles");
  const activeBrand=await req(`/api/organizations/platform-admin/organizations/${customerOrg.id}/basics`,{method:"POST",cookie:founder.cookie,body:{activeBrandProfileId:brand.data.brandProfile.id}});
  assert(activeBrand.status===200 && activeBrand.data.organization.activeBrandProfileId===brand.data.brandProfile.id,"platform admin can set active brand profile");

  const aiSave=await req(`/api/organizations/platform-admin/organizations/${customerOrg.id}/ai-provider-save`,{method:"POST",cookie:founder.cookie,body:{provider:"deepseek",apiKey:"customer-deepseek-key"}});
  assert(aiSave.status===200 && aiSave.data.credential.keyLast4==="-key","platform admin can save customer BYOK without returning plaintext");
  assert(JSON.stringify(aiSave.data).includes("customer-deepseek-key")===false,"BYOK plaintext is never returned from platform admin");
  const aiRevoke=await req(`/api/organizations/platform-admin/organizations/${customerOrg.id}/ai-providers/deepseek/revoke`,{method:"POST",cookie:founder.cookie,body:{}});
  assert(aiRevoke.status===200,"platform admin can revoke customer BYOK");
  const aiActivate=await req(`/api/organizations/platform-admin/organizations/${customerOrg.id}/ai-providers/deepseek/activate`,{method:"POST",cookie:founder.cookie,body:{}});
  assert(aiActivate.status===200,"platform admin can reactivate customer BYOK");

  const invite=await req(`/api/organizations/platform-admin/organizations/${customerOrg.id}/member-invite`,{method:"POST",cookie:founder.cookie,body:{email:"newmember@example.com",role:"admin"}});
  assert(invite.status===201,"platform admin can invite a member into any organization");
  assert(scalar("SELECT COUNT(*) FROM organization_invites WHERE email='newmember@example.com'")==="1","platform invite is persisted");

  const customerSession=await req("/api/sessions",{method:"POST",cookie:second.cookie,body:{roomId:"customer-live",organizationId:customerOrg.id,title:"Customer live"}});
  assert(customerSession.status===200,"customer can create its own session before operator intervention");
  const ended=await req(`/api/organizations/platform-admin/organizations/${customerOrg.id}/sessions/${customerSession.data.session.id}/end`,{method:"POST",cookie:founder.cookie,body:{}});
  assert(ended.status===200 && ended.data.session.status==="ENDED","platform admin can end a customer session");

  const suspend=await req(`/api/organizations/platform-admin/organizations/${customerOrg.id}/member-status`,{method:"POST",cookie:founder.cookie,body:{userId:second.data.user.id,status:"suspended"}});
  assert(suspend.status===200 && suspend.data.user.status==="suspended","platform admin can suspend a customer account");
  const suspendedSession=await req("/auth/session",{cookie:second.cookie});
  assert(suspendedSession.data.authenticated===false,"suspending a customer invalidates account access on the next request");
  const reactivate=await req(`/api/organizations/platform-admin/organizations/${customerOrg.id}/member-status`,{method:"POST",cookie:founder.cookie,body:{userId:second.data.user.id,status:"active"}});
  assert(reactivate.status===200 && reactivate.data.user.status==="active","platform admin can reactivate a customer account");

  const selfSuspend=await req(`/api/organizations/platform-admin/organizations/${orgs.data.organizations.find(o=>o.ownerUserId===founder.data.user.id).id}/member-status`,{method:"POST",cookie:founder.cookie,body:{userId:founder.data.user.id,status:"suspended"}});
  assert(selfSuspend.status===400,"platform admin cannot accidentally suspend the platform-admin account");

  const founderOrgs=orgs.data.organizations.find(o=>o.ownerUserId===founder.data.user.id);
  const s1=await req("/api/sessions",{method:"POST",cookie:founder.cookie,body:{roomId:"founder-one",organizationId:founderOrgs.id,title:"QA one"}});
  const s2=await req("/api/sessions",{method:"POST",cookie:founder.cookie,body:{roomId:"founder-two",organizationId:founderOrgs.id,title:"QA two"}});
  assert(s1.status===200 && s2.status===200,"platform admin bypasses cheap session-creation/concurrency QA limits");

  console.log("ALL PASSED - platform admin founder controls.");
}
main().then(()=>{server.kill();rmSync(scratch,{recursive:true,force:true});process.exit(0);}).catch(e=>{console.error(e);console.error(output);server.kill();rmSync(scratch,{recursive:true,force:true});process.exit(1);});
