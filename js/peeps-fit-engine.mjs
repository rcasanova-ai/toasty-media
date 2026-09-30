// Peeps contextual interaction-fit engine.
// Scores whether one person is worth another person's scarce time for a specific interaction.
// This is intentionally contextual, directional, explainable, and deterministic.
// There is no permanent/global "Peeps score".

const clamp=(n,min=0,max=1)=>Math.max(min,Math.min(max,Number.isFinite(n)?n:0));
const avg=(xs)=>xs.length?xs.reduce((a,b)=>a+b,0)/xs.length:0;
const norm=(v)=>typeof v==="number"?clamp(v):0;
const uniq=(xs)=>[...new Set((xs||[]).map(x=>String(x).trim().toLowerCase()).filter(Boolean))];
const overlap=(a,b)=>{
  const aa=uniq(a), bb=new Set(uniq(b));
  if(!aa.length||!bb.size)return 0;
  return aa.filter(x=>bb.has(x)).length/Math.max(1,Math.min(aa.length,bb.size));
};
const anyOverlap=(a,b)=>overlap(a,b)>0;

export const DEFAULT_WEIGHTS=Object.freeze({
  relevance:0.24,
  evidence:0.16,
  timing:0.14,
  networkValue:0.12,
  intentFit:0.14,
  preferenceCompatibility:0.20
});

export function normalizePeepsFitInput(input={}){
  return {
    subject:{
      id:input.subject?.id||null,
      topics:uniq(input.subject?.topics),
      currentTopics:uniq(input.subject?.currentTopics),
      audiences:uniq(input.subject?.audiences),
      guestTopics:uniq(input.subject?.guestTopics),
      formats:uniq(input.subject?.formats),
      geographies:uniq(input.subject?.geographies),
      signals:{
        socialActivity:norm(input.subject?.signals?.socialActivity),
        engagementQuality:norm(input.subject?.signals?.engagementQuality),
        guestQuality:norm(input.subject?.signals?.guestQuality),
        trajectory:norm(input.subject?.signals?.trajectory),
        freshness:norm(input.subject?.signals?.freshness),
        evidenceStrength:norm(input.subject?.signals?.evidenceStrength)
      }
    },
    recipient:{
      id:input.recipient?.id||null,
      interests:uniq(input.recipient?.interests),
      preferredAudiences:uniq(input.recipient?.preferredAudiences),
      preferredFormats:uniq(input.recipient?.preferredFormats),
      preferredGeographies:uniq(input.recipient?.preferredGeographies),
      excludedTopics:uniq(input.recipient?.excludedTopics),
      excludedFormats:uniq(input.recipient?.excludedFormats),
      requiredTopics:uniq(input.recipient?.requiredTopics),
      minEvidenceStrength:norm(input.recipient?.minEvidenceStrength),
      minInteractionFit:norm(input.recipient?.minInteractionFit)
    },
    interaction:{
      topics:uniq(input.interaction?.topics),
      format:String(input.interaction?.format||"").trim().toLowerCase(),
      audience:uniq(input.interaction?.audience),
      geography:uniq(input.interaction?.geography),
      intent:String(input.interaction?.intent||"").trim().toLowerCase(),
      requestedMinutes:Math.max(0,Number(input.interaction?.requestedMinutes||0)),
      urgency:norm(input.interaction?.urgency),
      compensationFit:norm(input.interaction?.compensationFit ?? 1),
      intentAlignment:norm(input.interaction?.intentAlignment ?? 0.5)
    }
  };
}

export function scoreDirectionalFit(rawInput,options={}){
  const input=normalizePeepsFitInput(rawInput);
  const w={...DEFAULT_WEIGHTS,...(options.weights||{})};
  const subject=input.subject, recipient=input.recipient, interaction=input.interaction;

  const topicalUniverse=[...subject.topics,...subject.currentTopics,...interaction.topics];
  const hardConflicts=[];
  if(anyOverlap(topicalUniverse,recipient.excludedTopics)) hardConflicts.push("excluded_topic");
  if(interaction.format && recipient.excludedFormats.includes(interaction.format)) hardConflicts.push("excluded_format");
  if(recipient.requiredTopics.length && !anyOverlap(topicalUniverse,recipient.requiredTopics)) hardConflicts.push("required_topic_missing");

  const relevance=clamp(
    overlap(topicalUniverse,recipient.interests)*0.55+
    overlap(subject.audiences,recipient.preferredAudiences)*0.20+
    overlap(subject.guestTopics,recipient.interests)*0.15+
    overlap(interaction.audience,recipient.preferredAudiences)*0.10
  );

  const evidence=clamp(
    subject.signals.evidenceStrength*0.65+
    subject.signals.engagementQuality*0.20+
    subject.signals.guestQuality*0.15
  );

  const timing=clamp(
    subject.signals.freshness*0.55+
    subject.signals.socialActivity*0.20+
    subject.signals.trajectory*0.15+
    interaction.urgency*0.10
  );

  const networkValue=clamp(
    subject.signals.guestQuality*0.45+
    subject.signals.engagementQuality*0.35+
    overlap(subject.guestTopics,recipient.interests)*0.20
  );

  const formatFit=!interaction.format?0.5:
    recipient.preferredFormats.length?Number(recipient.preferredFormats.includes(interaction.format)):0.5;
  const geoFit=recipient.preferredGeographies.length?
    Math.max(overlap(subject.geographies,recipient.preferredGeographies),overlap(interaction.geography,recipient.preferredGeographies)):0.5;
  const intentFit=clamp(
    interaction.intentAlignment*0.50+
    formatFit*0.20+
    geoFit*0.10+
    interaction.compensationFit*0.20
  );

  let preferenceCompatibility=1;
  if(hardConflicts.length) preferenceCompatibility=0;
  else {
    const preferredTopicFit=recipient.interests.length?overlap(topicalUniverse,recipient.interests):0.5;
    const requiredTopicFit=recipient.requiredTopics.length?Number(anyOverlap(topicalUniverse,recipient.requiredTopics)):1;
    const evidenceFloor=recipient.minEvidenceStrength?clamp(evidence/recipient.minEvidenceStrength):1;
    preferenceCompatibility=clamp(preferredTopicFit*0.45+requiredTopicFit*0.20+formatFit*0.15+evidenceFloor*0.20);
  }

  const timeCost=interaction.requestedMinutes?
    clamp(1-(Math.max(0,interaction.requestedMinutes-20)/100),0.35,1):1;

  const components={relevance,evidence,timing,networkValue,intentFit,preferenceCompatibility,timeCost};
  const weighted=
    relevance*w.relevance+
    evidence*w.evidence+
    timing*w.timing+
    networkValue*w.networkValue+
    intentFit*w.intentFit+
    preferenceCompatibility*w.preferenceCompatibility;

  const score=Math.round(clamp(weighted*timeCost)*100);
  const threshold=Math.round((recipient.minInteractionFit||0)*100);
  const eligible=!hardConflicts.length && score>=threshold;

  const reasons=[];
  if(relevance>=0.7)reasons.push("strong_topic_or_audience_overlap");
  if(timing>=0.7)reasons.push("high_current_momentum");
  if(evidence>=0.7)reasons.push("strong_evidence");
  if(networkValue>=0.7)reasons.push("relevant_network_or_guest_quality");
  if(preferenceCompatibility>=0.8)reasons.push("preferences_match");
  if(timeCost<0.8)reasons.push("high_time_cost");
  if(hardConflicts.length)reasons.push(...hardConflicts);

  return {
    score,
    eligible,
    threshold,
    direction:{from:subject.id,to:recipient.id},
    hardConflicts,
    components:Object.fromEntries(Object.entries(components).map(([k,v])=>[k,Math.round(v*100)])),
    reasons,
    explanation:buildExplanation({score,eligible,hardConflicts,components})
  };
}

function buildExplanation({score,eligible,hardConflicts,components}){
  if(hardConflicts.includes("excluded_topic")) return "Low fit because the subject or proposed interaction overlaps an explicitly excluded topic.";
  if(hardConflicts.includes("excluded_format")) return "Low fit because the proposed format is explicitly excluded.";
  if(hardConflicts.includes("required_topic_missing")) return "Low fit because a required topic is missing.";
  const strengths=[];
  if(components.relevance>=0.7) strengths.push("high relevance");
  if(components.timing>=0.7) strengths.push("strong current momentum");
  if(components.evidence>=0.7) strengths.push("strong evidence");
  if(components.networkValue>=0.7) strengths.push("relevant network quality");
  if(components.preferenceCompatibility>=0.8) strengths.push("strong preference compatibility");
  const basis=strengths.length?strengths.join(", "):"mixed signals";
  return `${score}% contextual fit based on ${basis}.${eligible?" Meets this recipient's threshold.":" Does not meet this recipient's threshold."}`;
}

export function scoreMutualFit({aToB,bToA},options={}){
  const left=scoreDirectionalFit(aToB,options);
  const right=scoreDirectionalFit(bToA,options);
  const blocked=!left.eligible||!right.eligible;
  const mutualScore=blocked?Math.min(left.score,right.score):Math.round(Math.sqrt(left.score*right.score));
  return {
    mutualScore,
    eligible:!blocked,
    aToB:left,
    bToA:right,
    explanation:blocked
      ? "This interaction is not mutually eligible because at least one side's preferences or threshold are not satisfied."
      : `${mutualScore}% mutual fit. Both sides clear their contextual thresholds.`
  };
}
