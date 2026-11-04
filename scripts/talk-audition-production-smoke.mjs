import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";

const dbPath=process.env.TOASTY_AUTH_DB||"/var/lib/toasty/toasty.sqlite";
const helper=process.env.TOASTY_AUTH_DB_HELPER||"/opt/toasty-render/scripts/toasty-auth-db.py";
const secret=process.env.TOASTY_SESSION_SECRET||process.env.TOASTY_RENDER_TOKEN||"";
const port=Number(process.env.TOASTY_RENDER_PORT||4174), base=`http://127.0.0.1:${port}`;
const email="rcasanova+toastyauditionqa20261031@yegsoccer.com";
if(!helper||!secret)throw new Error("Production auth helper/session signing is unavailable.");
function db(action,values={}){return new Promise((resolve,reject)=>{const child=spawn("python3",[helper],{stdio:["pipe","pipe","pipe"]});let out="",err="";child.stdout.on("data",c=>out+=c);child.stderr.on("data",c=>err+=c);child.on("close",code=>{if(code)return reject(new Error(err||`DB helper exited ${code}`));try{resolve(JSON.parse(out));}catch(error){reject(error);}});child.stdin.end(JSON.stringify({action,dbPath,...values}));});}
async function sqlOne(statement,param){const code=`import sqlite3,sys,json\nc=sqlite3.connect(sys.argv[1]);c.row_factory=sqlite3.Row\nr=c.execute(sys.argv[2],(sys.argv[3],)).fetchone();print(json.dumps(dict(r) if r else None))`;return new Promise((resolve,reject)=>{const child=spawn("python3",["-c",code,dbPath,statement,param],{stdio:["ignore","pipe","pipe"]});let out="",err="";child.stdout.on("data",c=>out+=c);child.stderr.on("data",c=>err+=c);child.on("close",code=>code?reject(new Error(err)):resolve(JSON.parse(out)));});}
const request=async(path,{method="GET",cookie,body,raw,type="application/json"}={})=>{const headers={Origin:"https://toasty.media","X-Toasty-CSRF":"1"};if(cookie)headers.Cookie=cookie;if(body!==undefined||raw)headers["Content-Type"]=type;const response=await fetch(base+path,{method,headers,body:raw||body===undefined?raw:JSON.stringify(body)});let data={};try{data=await response.json();}catch{}return{response,data};};
const app=await sqlOne("SELECT id FROM talk_auditions WHERE email=? AND deleted_at IS NULL",email);if(!app)throw new Error("Synthetic production application was not found.");
const admin=await sqlOne("SELECT id,name,email,status,password_version FROM users WHERE platform_role='platform_admin' AND status='active' AND email_verified_at IS NOT NULL AND ?='' ORDER BY created_at LIMIT 1","");
if(!admin)throw new Error("No verified platform administrator exists.");
const payload=Buffer.from(JSON.stringify({id:admin.id,name:admin.name,email:admin.email,status:admin.status,passwordVersion:Number(admin.password_version)||1,expires:Math.floor(Date.now()/1000)+900})).toString("base64url");
const cookie=`toasty_session=${payload}.${createHmac("sha256",secret).update(payload).digest("base64url")}`;
const root="/api/organizations/platform-admin/talk-auditions";
let result=await request(root,{cookie});if(result.response.status!==200||!result.data.entries?.some(e=>e.id===app.id))throw new Error("Admin list did not return the synthetic application.");
result=await request(`${root}/${app.id}/invite`,{method:"POST",cookie,body:{}});if(result.response.status!==200||!result.data.inviteUrl||result.data.emailDelivery!=="sent")throw new Error(`Production invitation failed (${result.response.status}/${result.data.emailDelivery||"unknown"}).`);
const token=new URL(result.data.inviteUrl).searchParams.get("token");
result=await request(`/api/organizations/talk-auditions/invite/${token}`);if(result.response.status!==200||result.data.state!=="valid")throw new Error("Invitation lookup failed.");
result=await request(`/api/organizations/talk-auditions/invite/${token}/submit`,{method:"POST",raw:Buffer.from([0x1a,0x45,0xdf,0xa3,0x42,0x86,0x81,0x01]),type:"video/webm"});if(result.response.status!==201)throw new Error(`Recording submission failed (${result.response.status}).`);
result=await request(`${root}/${app.id}/recording`,{cookie});if(result.response.status!==200||result.response.headers.get("cache-control")!=="private, no-store")throw new Error("Private admin recording review failed.");
result=await request(`${root}/${app.id}/status`,{method:"POST",cookie,body:{status:"SHORTLISTED"}});if(result.response.status!==200)throw new Error("Admin status transition failed.");
result=await request(`${root}/${app.id}/delete`,{method:"POST",cookie,body:{}});if(result.response.status!==200)throw new Error("Privacy deletion failed.");
const deleted=await sqlOne("SELECT status FROM talk_auditions WHERE id=?",app.id);if(deleted?.status!=="DELETED")throw new Error("Deleted audit row was not retained.");
console.log("Production audition smoke passed: admin list, sent invitation, token, upload, private review, status and privacy deletion.");
