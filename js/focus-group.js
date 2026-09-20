export function createFocusGroupContext(overrides={}) {
  return {
    id: overrides.id || `fg-${Date.now().toString(36)}`,
    title: overrides.title || "Focus Group",
    objective: overrides.objective || "",
    researchQuestions: overrides.researchQuestions || [],
    cohort: overrides.cohort || {},
    concepts: overrides.concepts || [],
    clientNotes: overrides.clientNotes || "",
    privacy: overrides.privacy || "client_confidential",
    createdAt: overrides.createdAt || new Date().toISOString()
  };
}

export function defaultFocusGroupAgenda(context={}) {
  const questions = Array.isArray(context.researchQuestions) ? context.researchQuestions : [];
  return [
    { title:"Welcome + consent", estimatedMinutes:3, preparedQuestions:["Confirm recording/transcription consent.","Explain there are no right answers."] },
    { title:"Warm-up", estimatedMinutes:5, preparedQuestions:["Tell us briefly about how this topic fits into your life.","What do you currently use or do instead?"] },
    { title:"Core questions", estimatedMinutes:10, preparedQuestions:questions.length?questions:["What is your first reaction?","What feels useful or confusing?","What would stop you from using this?"] },
    { title:"Concept reactions", estimatedMinutes:8, preparedQuestions:["What stands out most?","What feels credible?","What feels wrong or missing?","Which option would you choose and why?"] },
    { title:"Wrap-up", estimatedMinutes:4, preparedQuestions:["What is the one thing you would change?","What did we not ask that matters?"] }
  ];
}

function norm(text=""){return text.toLowerCase().replace(/[^a-z0-9\s'-]/g," ").replace(/\s+/g," ").trim();}
function words(text=""){return norm(text).split(" ").filter(Boolean);}
function unique(arr){return [...new Set(arr)];}

const SIGNALS = {
  confusion:["confusing","confused","unclear","don't understand","dont understand","not sure","what does","hard to","complicated"],
  positive:["like","love","useful","helpful","easy","clear","good","great","would use","works for me"],
  negative:["don't like","dont like","hate","bad","annoying","frustrating","wouldn't use","wouldnt use","not useful","too expensive"],
  trust:["trust","credible","believe","skeptical","sceptical","safe","privacy","secure"],
  price:["price","pricing","cost","expensive","cheap","pay","worth"],
  intent:["would use","would buy","would try","wouldn't use","wouldnt use","probably use","not for me"]
};

function containsSignal(text, phrases){
  const n=norm(text);
  return phrases.some(p=>n.includes(norm(p)));
}

export function analyzeFocusGroupTranscript(lines=[], context={}) {
  const clean = (lines||[]).filter(l=>l?.text?.trim()).map((l,i)=>({
    id:l.id||`line-${i+1}`,
    speaker:l.speaker||"Participant",
    text:l.text.trim(),
    timestamp:l.timestamp||null
  }));
  const speakers=unique(clean.map(l=>l.speaker));
  const bySpeaker=Object.fromEntries(speakers.map(s=>[s,clean.filter(l=>l.speaker===s)]));
  const observations=[];
  for(const [kind,phrases] of Object.entries(SIGNALS)){
    clean.filter(l=>containsSignal(l.text,phrases)).forEach(l=>observations.push({kind,speaker:l.speaker,text:l.text,timestamp:l.timestamp,lineId:l.id}));
  }
  const counts={};
  observations.forEach(o=>counts[o.kind]=(counts[o.kind]||0)+1);

  const participation=speakers.map(s=>({speaker:s,turns:bySpeaker[s].length,words:bySpeaker[s].reduce((n,l)=>n+words(l.text).length,0)}))
    .sort((a,b)=>b.turns-a.turns);

  const quiet=participation.filter(p=>p.turns<=Math.max(1,Math.floor(clean.length/Math.max(1,speakers.length)*0.45)));
  const evidenceQuotes=observations.slice(0,12).map(o=>({speaker:o.speaker,quote:o.text,timestamp:o.timestamp,signal:o.kind}));

  return {
    schema:"toasty.focus-group-analysis.v1",
    generatedAt:new Date().toISOString(),
    session:{id:context.id||null,title:context.title||"Focus Group",objective:context.objective||"",cohort:context.cohort||{}},
    stats:{turns:clean.length,speakers:speakers.length,signalCounts:counts},
    participation,
    quietParticipants:quiet,
    observations,
    evidenceQuotes,
    gaps:buildResearchGaps(clean,context),
    moderatorPrompts:buildModeratorPrompts({clean,context,observations,quiet}),
    summary:buildSummary({clean,speakers,counts,context})
  };
}

function buildResearchGaps(lines,context){
  const corpus=norm(lines.map(l=>l.text).join(" "));
  return (context.researchQuestions||[]).filter(q=>{
    const tokens=words(q).filter(w=>w.length>4);
    return tokens.length && !tokens.some(t=>corpus.includes(t));
  }).map(question=>({question,status:"not-clearly-covered"}));
}

function buildModeratorPrompts({observations,quiet,context}){
  const prompts=[];
  if(quiet.length) prompts.push({type:"participation",text:`Bring in ${quiet.slice(0,2).map(x=>x.speaker).join(" and ")} before moving on.`});
  const confusion=observations.filter(o=>o.kind==="confusion");
  if(confusion.length>=2) prompts.push({type:"probe",text:"Multiple participants sound confused. Ask each to explain what they expected instead."});
  const negatives=observations.filter(o=>o.kind==="negative");
  if(negatives.length) prompts.push({type:"probe",text:`Probe the objection raised by ${negatives[0].speaker}: “${negatives[0].text}”`});
  const positives=observations.filter(o=>o.kind==="positive");
  if(positives.length) prompts.push({type:"probe",text:`Ask what specifically created the positive reaction behind: “${positives[0].text}”`});
  const questions=context.researchQuestions||[];
  if(questions.length) prompts.push({type:"coverage",text:`Before closing, verify the group has answered: ${questions[0]}`});
  return prompts.slice(0,6);
}

function buildSummary({speakers,counts,context}){
  const top=Object.entries(counts).sort((a,b)=>b[1]-a[1]).slice(0,3).map(([k,v])=>`${k} (${v})`);
  return {
    headline: context.objective ? `Focus group evidence for: ${context.objective}` : "Focus group evidence summary",
    participantCount:speakers.length,
    strongestSignals:top,
    note:"This summary is deterministic signal extraction. Model-generated interpretation should remain separately labeled and evidence-linked."
  };
}

export function buildFocusGroupDeliveryPack(lines=[],context={}){
  const analysis=analyzeFocusGroupTranscript(lines,context);
  const agreements=analysis.observations.filter(o=>o.kind==="positive").slice(0,6);
  const disagreements=analysis.observations.filter(o=>o.kind==="negative"||o.kind==="confusion").slice(0,6);
  const opportunities=analysis.observations.filter(o=>o.kind==="positive"||o.kind==="intent").slice(0,6);
  const risks=analysis.observations.filter(o=>o.kind==="negative"||o.kind==="trust"||o.kind==="price").slice(0,6);
  return {
    schema:"toasty.focus-group-delivery.v1",
    generatedAt:new Date().toISOString(),
    clientBoundary:"Client-private session output. Reusable participant profiles are handled separately by consent.",
    executiveSummary:analysis.summary,
    researchObjective:context.objective||"",
    participantOverview:analysis.participation,
    majorThemes:Object.entries(analysis.stats.signalCounts).sort((a,b)=>b[1]-a[1]).map(([signal,count])=>({theme:signal,count,evidence:analysis.observations.filter(o=>o.kind===signal).slice(0,3)})),
    pointsOfAgreement:agreements,
    pointsOfDisagreement:disagreements,
    keyFindings:Object.entries(analysis.stats.signalCounts).sort((a,b)=>b[1]-a[1]).map(([signal,count])=>({finding:`${signal} signal appeared ${count} time${count===1?"":"s"}`, evidence:analysis.observations.filter(o=>o.kind===signal).slice(0,3)})),
    evidence:analysis.evidenceQuotes,
    unansweredQuestions:analysis.gaps,
    productOpportunities:opportunities,
    risksConcerns:risks,
    recommendedFollowUpResearch:analysis.gaps.length?analysis.gaps.map(g=>g.question):analysis.moderatorPrompts.map(p=>p.text),
    topFindings:Object.entries(analysis.stats.signalCounts).sort((a,b)=>b[1]-a[1]).map(([signal,count])=>({signal,count,evidence:analysis.observations.filter(o=>o.kind===signal).slice(0,3)})),
    participantObservations:analysis.participation,
    unansweredQuestions:analysis.gaps,
    moderatorPrompts:analysis.moderatorPrompts,
    notableQuotes:analysis.evidenceQuotes,
    assets:{
      recording:"pending",
      transcript:"available",
      subtitles:"pending",
      clips:[],
      quoteCards:[]
    }
  };
}
