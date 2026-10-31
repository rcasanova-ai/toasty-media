#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT=join(dirname(fileURLToPath(import.meta.url)),"..");
const PORT=4283, BASE=`http://127.0.0.1:${PORT}`;
const scratch=mkdtempSync(join(tmpdir(),"toasty-audition-")), dbPath=join(scratch,"db.sqlite"), recordings=join(scratch,"recordings");
const assert=(v,m)=>{if(!v)throw new Error("FAILED: "+m);console.log("ok - "+m);};
let output="";
const server=spawn("node",[join(ROOT,"scripts/render-production-server.mjs")],{env:{...process.env,TOASTY_RENDER_PORT:String(PORT),TOASTY_AUTH_DB:dbPath,TOASTY_AUTH_DB_HELPER:join(ROOT,"scripts/toasty-auth-db.py"),TOASTY_SESSION_SECRET:"audition-test",TOASTY_TALK_AUDITION_RECORDINGS_DIR:recordings,RESEND_API_KEY:"",TOASTY_DISABLE_MATEO_BOOTSTRAP:"1",TOASTY_DISABLE_VOYAGEURS_BOOTSTRAP:"1"},stdio:["ignore","pipe","pipe"]});
server.stdout.on("data",c=>output+=c);server.stderr.on("data",c=>output+=c);process.on("exit",()=>server.kill("SIGKILL"));
async function api(path,{method="GET",cookie,body,raw,contentType="application/json",origin="http://localhost:4173",csrf=true}={}){const h={origin,"x-forwarded-for":"10.55.0."+Math.floor(Math.random()*200+1)};if(csrf)h["x-toasty-csrf"]="1";if(cookie)h.cookie=cookie;if(body!==undefined||raw)h["content-type"]=contentType;const r=await fetch(BASE+path,{method,headers:h,body:raw||body===undefined?raw:JSON.stringify(body)});const text=await r.text();let data={};try{data=JSON.parse(text);}catch{data={text};}return{status:r.status,data,text,cookie:(r.headers.get("set-cookie")||"").split(";")[0]||cookie,headers:r.headers};}
function sql(statement,params=[]){const code=`import sqlite3,sys,json\nc=sqlite3.connect(sys.argv[1]);cur=c.execute(sys.argv[2],json.loads(sys.argv[3]));c.commit();print(json.dumps(cur.fetchall()))`;const r=spawnSync("python3",["-c",code,dbPath,statement,JSON.stringify(params)],{encoding:"utf8"});if(r.status)throw new Error(r.stderr);return JSON.parse(r.stdout);}
const good=(over={})=>({name:"Ari Applicant",email:"ari@example.com",location:"Bangkok",about:"Curious storyteller",topic:"Why cities need better sidewalks",links:"https://example.com",adult:true,release:true,privacy:true,website:"",elapsedMs:5000,...over});

async function main(){for(let i=0;i<80;i++){try{if((await fetch(BASE+"/health")).ok)break;}catch{}await new Promise(r=>setTimeout(r,100));}
  const admin=await api("/auth/register",{method:"POST",body:{name:"Founder",email:"founder@example.com",password:"password10chars"}});
  sql("UPDATE users SET email_verified_at='2026-10-31T00:00:00+00:00' WHERE email='founder@example.com'");
  const ordinary=await api("/auth/register",{method:"POST",body:{name:"Viewer",email:"viewer@example.com",password:"password10chars"}});
  const joined=await api("/api/organizations/talk-auditions",{method:"POST",body:good()});
  assert(joined.status===200&&sql("SELECT COUNT(*) FROM talk_auditions")[0][0]===1,"application is saved, not opened in mailto");
  const row=sql("SELECT id,release_version,privacy_version,confirmation_email_status,admin_email_status FROM talk_auditions")[0];
  assert(row[1].includes("release")&&row[2].includes("privacy")&&row[3]==="simulated"&&row[4]==="simulated","versioned consent and honest applicant/admin email outcomes are recorded");
  const dup=await api("/api/organizations/talk-auditions",{method:"POST",body:good({name:"Different"})});
  assert(dup.text===joined.text&&sql("SELECT COUNT(*) FROM talk_auditions")[0][0]===1,"duplicate email gets a uniform response and no duplicate record");
  assert((await api("/api/organizations/talk-auditions",{method:"POST",body:good({email:"bad2@example.com",release:false})})).status===400,"recording release is required");
  assert((await api("/api/organizations/talk-auditions",{method:"POST",body:good({email:"bot@example.com",website:"spam"})})).status===200&&sql("SELECT COUNT(*) FROM talk_auditions WHERE email='bot@example.com'")[0][0]===0,"bot trap stores nothing");
  const adminPath="/api/organizations/platform-admin/talk-auditions";
  assert((await api(adminPath)).status===401&&[401,403].includes((await api(adminPath,{cookie:ordinary.cookie})).status),"auditions are private to platform admins");
  const list=await api(adminPath,{cookie:admin.cookie});
  assert(list.status===200&&list.data.total===1&&list.data.notificationRecipients===1,"admin list works and resolves a verified administrator recipient");
  const invite=await api(`${adminPath}/${row[0]}/invite`,{method:"POST",cookie:admin.cookie,body:{}});
  const token=new URL(invite.data.inviteUrl).searchParams.get("token");
  assert(invite.status===200&&token&&invite.data.emailDelivery==="simulated"&&sql("SELECT token_hash FROM talk_audition_invites")[0][0]!==token,"admin issues an emailed, expiring invitation and only its hash is stored");
  const publicInvite=`/api/organizations/talk-auditions/invite/${token}`;
  assert((await api(publicInvite)).data.state==="valid"&&!(await api(publicInvite)).text.includes("ari@example.com"),"token lookup is valid without exposing contact details");
  const fakeVideo=Buffer.from([0x1a,0x45,0xdf,0xa3,0x42,0x86,0x81,0x01]);
  const submitted=await api(`${publicInvite}/submit`,{method:"POST",raw:fakeVideo,contentType:"video/webm"});
  assert(submitted.status===201&&sql("SELECT status,recording_bytes,recording_path IS NOT NULL FROM talk_auditions")[0].join(",")==="SUBMITTED,8,1","private recording upload is persisted with metadata");
  assert((await api(`${publicInvite}/submit`,{method:"POST",raw:fakeVideo,contentType:"video/webm"})).status===410,"recording invitation is single-use");
  const recording=await api(`${adminPath}/${row[0]}/recording`,{cookie:admin.cookie});
  assert(recording.status===200&&recording.headers.get("cache-control")==="private, no-store"&&recording.text.length>0,"admin can review the private no-store recording");
  assert([401,403].includes((await api(`${adminPath}/${row[0]}/recording`,{cookie:ordinary.cookie})).status),"ordinary users cannot read recordings");
  const status=await api(`${adminPath}/${row[0]}/status`,{method:"POST",cookie:admin.cookie,body:{status:"SHORTLISTED"}});
  assert(status.status===200&&sql("SELECT status FROM talk_auditions")[0][0]==="SHORTLISTED","admin can manage casting status");
  const del=await api(`${adminPath}/${row[0]}/delete`,{method:"POST",cookie:admin.cookie,body:{}});
  assert(del.status===200&&sql("SELECT status,email,recording_path FROM talk_auditions")[0][0]==="DELETED"&&sql("SELECT recording_path FROM talk_auditions")[0][0]===null,"privacy deletion anonymizes the application and removes the recording reference");
  console.log("ALL PASSED — application, verified notifications, expiring invitation, recording, admin review and privacy deletion.");
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e.stack||e);console.error(output.slice(-3000));process.exit(1);});
