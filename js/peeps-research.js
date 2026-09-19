const KEY='toasty_peeps_demand_events_v1';

export const SESSION_TYPES=[
  {id:'focus-group',label:'Focus group'},
  {id:'expert-panel',label:'Expert panel'},
  {id:'research-interview',label:'Research interviews'},
  {id:'customer-conversation',label:'Customer conversations'},
  {id:'product-test',label:'Product / concept test'}
];

export function recordDemandEvent(payload={}){
  const list=loadDemandEvents();
  const event={
    id:crypto?.randomUUID?.()||String(Date.now()),
    createdAt:new Date().toISOString(),
    sessionType:payload.sessionType||'focus-group',
    participants:Number(payload.participants||0)||null,
    geography:(payload.geography||'').trim(),
    ageRange:(payload.ageRange||'').trim(),
    context:(payload.context||'').trim(),
    brief:(payload.brief||'').trim(),
    clientPrivate:true
  };
  list.unshift(event);
  localStorage.setItem(KEY,JSON.stringify(list.slice(0,100)));
  return event;
}
export function loadDemandEvents(){
  try{return JSON.parse(localStorage.getItem(KEY)||'[]')}catch{return[]}
}
export function summarizeDemand(events=loadDemandEvents()){
  const counts=new Map();
  const add=(label,kind)=>{if(!label)return;const key=kind+'|'+label.toLowerCase();const row=counts.get(key)||{label,kind,count:0};row.count++;counts.set(key,row)};
  events.forEach(e=>{
    add(SESSION_TYPES.find(x=>x.id===e.sessionType)?.label||e.sessionType,'Session');
    add(e.geography,'Geography');
    add(e.ageRange,'Age');
    (e.context||'').split(/[,;\n]/).map(x=>x.trim()).filter(Boolean).forEach(x=>add(x,'Context'));
  });
  return [...counts.values()].sort((a,b)=>b.count-a.count||a.label.localeCompare(b.label));
}
export function bindResearchBrief(){
  const form=document.querySelector('#researchBrief');
  if(!form)return;
  const type=new URLSearchParams(location.search).get('type');
  if(type && form.elements.sessionType) form.elements.sessionType.value=type;
  form.addEventListener('submit',e=>{
    e.preventDefault();
    recordDemandEvent({
      sessionType:form.elements.sessionType.value,
      participants:form.elements.participants.value,
      geography:form.elements.geography.value,
      ageRange:form.elements.ageRange.value,
      context:form.elements.context.value,
      brief:form.elements.brief.value
    });
    location.href='./search-progress.html';
  });
}
document.addEventListener('DOMContentLoaded',bindResearchBrief);
