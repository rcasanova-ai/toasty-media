import assert from "node:assert/strict";
import {scoreDirectionalFit,scoreMutualFit} from "../js/peeps-fit-engine.mjs";

const emerging={
  subject:{
    id:"emerging-host",
    topics:["robotics","embodied ai"],
    currentTopics:["embodied agents"],
    audiences:["technical founders","robotics researchers"],
    guestTopics:["robotics","ai infrastructure"],
    formats:["podcast"],
    geographies:["southeast asia"],
    signals:{socialActivity:.9,engagementQuality:.85,guestQuality:.8,trajectory:.95,freshness:.95,evidenceStrength:.8}
  },
  recipient:{
    id:"high-demand-peep",
    interests:["robotics","embodied ai","ai infrastructure"],
    preferredAudiences:["technical founders","robotics researchers"],
    preferredFormats:["podcast"],
    preferredGeographies:["southeast asia"],
    excludedTopics:["crypto"],
    requiredTopics:["robotics"],
    minEvidenceStrength:.6,
    minInteractionFit:.65
  },
  interaction:{topics:["robotics","embodied ai"],format:"podcast",audience:["technical founders"],geography:["southeast asia"],intent:"interview",requestedMinutes:20,urgency:.9,intentAlignment:.95,compensationFit:1}
};

const good=scoreDirectionalFit(emerging);
assert.equal(good.eligible,true);
assert.ok(good.score>=75);
assert.equal(good.hardConflicts.length,0);
assert.ok(good.reasons.includes("high_current_momentum"));

const cryptoGlitter=structuredClone(emerging);
cryptoGlitter.subject.topics=["crypto","defi"];
cryptoGlitter.subject.currentTopics=["memecoins"];
cryptoGlitter.subject.guestTopics=["crypto"];
cryptoGlitter.interaction.topics=["crypto"];
const blocked=scoreDirectionalFit(cryptoGlitter);
assert.equal(blocked.eligible,false);
assert.ok(blocked.hardConflicts.includes("excluded_topic"));
assert.equal(blocked.components.preferenceCompatibility,0);

const oneWay=scoreMutualFit({
  aToB:emerging,
  bToA:{
    subject:{id:"high-demand-peep",topics:["robotics"],signals:{socialActivity:.4,engagementQuality:.9,guestQuality:.9,trajectory:.5,freshness:.6,evidenceStrength:.95}},
    recipient:{id:"emerging-host",interests:["robotics"],preferredFormats:["podcast"],excludedTopics:["venture capital"],minInteractionFit:.55},
    interaction:{topics:["robotics"],format:"podcast",requestedMinutes:20,intentAlignment:.9,compensationFit:1}
  }
});
assert.equal(oneWay.eligible,true);
assert.ok(oneWay.mutualScore>0);

const badReverse=structuredClone(oneWay);
void badReverse;

const longMeeting=structuredClone(emerging);
longMeeting.interaction.requestedMinutes=120;
const costly=scoreDirectionalFit(longMeeting);
assert.ok(costly.score<good.score);
assert.ok(costly.reasons.includes("high_time_cost"));

console.log("Peeps contextual fit engine tests passed.");
