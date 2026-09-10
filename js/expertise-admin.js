const MODULE_KEY='toastyStudioModules';
const DEFAULT_MODULES={live:true,ai:true,expertise:true};

function getModules(){
  try{return {...DEFAULT_MODULES,...JSON.parse(localStorage.getItem(MODULE_KEY)||'{}')}}catch{return {...DEFAULT_MODULES}}
}
function saveModules(next){localStorage.setItem(MODULE_KEY,JSON.stringify(next));}
function moduleCard(id,title,copy){
  const enabled=getModules()[id]!==false;
  return `<article class="xp-admin-panel"><div class="xp-section-head" style="margin-top:0"><div><p class="xp-kicker">Client module</p><h2>${title}</h2></div><label style="display:flex;align-items:center;gap:10px;font-weight:700"><input type="checkbox" data-module-toggle="${id}" ${enabled?'checked':''}> ${enabled?'On':'Off'}</label></div><p>${copy}</p></article>`;
}
function modulesView(){return `<div class="xp-admin-grid">${moduleCard('live','Live / Podcast Studio','Live rooms, guest invites, scenes, recording controls and production session tools.')}${moduleCard('ai','AI Production','Idea-to-production workflow, uploads, digital-double production context and AI-assisted media creation.')}${moduleCard('expertise','Expertise','Find, screen and prepare the right people for podcasts, panels, research, advisory and other conversations.')}</div><section class="xp-admin-panel" style="margin-top:18px"><h3>Client workspace</h3><p>These switches control which modules appear in Toasty Studio for the client. Branding is handled separately as Toasty or a white-label workspace.</p><a class="xp-btn xp-btn-small" href="../studio/">Open client Studio</a></section>`}
function table(name,headers,rows){return `<section class="xp-admin-panel"><div class="xp-section-head" style="margin-top:0"><div><p class="xp-kicker">Operations</p><h2>${name}</h2></div></div><table class="xp-admin-table"><thead><tr>${headers.map(h=>`<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.map(r=>`<tr>${r.map(c=>`<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table></section>`}
const views={
  modules:{title:'Client modules',html:modulesView},
  experts:{title:'Expertise',html:()=>table('Expert network',['Name','Area','Readiness','Status'],[['Sarah M.','Sports','94%','Published'],['Dr. N. Patel','Life sciences','88%','Review'],['Alex P.','AI infrastructure','91%','Published'],['Maria L.','Nonprofit','72%','Building']])},
  requests:{title:'Requests',html:()=>table('Active requests',['Brief','Use case','Candidates','Stage'],[['Canadian soccer growth','Podcast','24','Shortlist'],['Bangkok AI infrastructure','Conference','31','Inviting'],['Stem-cell manufacturing','Research','18','Screening']])},
  outreach:{title:'Outreach',html:()=>table('Expert outreach',['Person','Why surfaced','Stage','Next action'],[['Jane Reynolds','Canadian soccer executive','Contacted','Follow up'],['Prof. Arun S.','AI compute research','Sourced','Invite'],['Michael Chen','Data center cooling','Claimed','Evidence upload']])},
  analytics:{title:'Analytics',html:()=>`<div class="xp-admin-kpis"><article><small>Search to shortlist</small><strong>31%</strong></article><article><small>Invite acceptance</small><strong>46%</strong></article><article><small>Avg. time to shortlist</small><strong>6m</strong></article><article><small>Published doubles</small><strong>61</strong></article></div>`}
};
const content=document.querySelector('#adminContent'),title=document.querySelector('#adminTitle');
function bindModuleToggles(){document.querySelectorAll('[data-module-toggle]').forEach(input=>input.addEventListener('change',()=>{const next=getModules();next[input.dataset.moduleToggle]=input.checked;saveModules(next);render('modules')}));}
function render(key){const v=views[key]||views.modules;title.textContent=v.title;content.innerHTML=v.html();document.querySelectorAll('[data-admin-view]').forEach(b=>b.classList.toggle('active',b.dataset.adminView===key));if(key==='modules')bindModuleToggles();}
document.querySelectorAll('[data-admin-view]').forEach(b=>b.addEventListener('click',()=>render(b.dataset.adminView)));
render('modules');