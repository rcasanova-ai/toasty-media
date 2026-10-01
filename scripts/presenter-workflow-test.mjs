#!/usr/bin/env node
import {
  PresenterPhase,
  createPresenterJob,
  presenterPreflight,
  assertPresenterRemoteAllowed,
  lockPresenterNarration,
  registerPaidPresenterCandidate,
  buildPresenterTimeline,
  markPresenterVerified,
  canDeliverPresenter
} from "./presenter-workflow.mjs";

function assert(condition, message) {
  if (!condition) throw new Error(`FAILED: ${message}`);
  console.log(`  ok - ${message}`);
}

function expectThrow(fn, text, message) {
  let threw = false;
  try { fn(); } catch (error) {
    threw = String(error.message).includes(text);
  }
  assert(threw, message);
}

console.log("presenter workflow");

const job = createPresenterJob({
  id: "pv-test",
  script: "Hello from Toasty.",
  presenterImage: "asset://presenter.png",
  rightsConfirmed: true,
  adultPresenterConfirmed: true
});

let preflight = presenterPreflight(job);
assert(!preflight.ok, "manual image review blocks generation");

job.manualReview.imageViewed = true;
job.manualReview.singleClearFace = true;
job.manualReview.imageHasNoUnwantedText = true;

preflight = presenterPreflight(job);
assert(preflight.ok, "local workflow becomes ready after image review");
assert(!preflight.remoteReady, "remote upload remains separately blocked");
expectThrow(
  () => assertPresenterRemoteAllowed(job),
  "remote-upload-not-approved",
  "remote provider call is gated by explicit approval"
);

job.input.remoteUploadApproved = true;
assert(assertPresenterRemoteAllowed(job), "remote provider call allowed after approval");

lockPresenterNarration(job, {
  scriptHash: "sha256:test",
  audioAsset: "asset://narration.wav",
  durationSeconds: 42.5,
  asrVerified: true
});
assert(job.phase === PresenterPhase.NARRATION_LOCKED, "verified narration becomes master clock");

registerPaidPresenterCandidate(job, { accepted: false, provider: "test-provider", requestId: "1" });
registerPaidPresenterCandidate(job, { accepted: false, provider: "test-provider", requestId: "2" });
registerPaidPresenterCandidate(job, { accepted: true, provider: "test-provider", requestId: "3" });
expectThrow(
  () => registerPaidPresenterCandidate(job, { accepted: false }),
  "ceiling reached",
  "paid retry ceiling prevents runaway spend"
);

const timeline = buildPresenterTimeline(job, {
  presenterAsset: "asset://presenter.mp4",
  captionsAsset: "asset://captions.vtt"
});
assert(timeline.masterClock === "narration", "timeline is narration-driven");
assert(timeline.tracks.presenter.muteSourceAudio === true, "generated presenter source audio is muted");
assert(timeline.durationSeconds === 42.5, "timeline inherits locked narration duration");

markPresenterVerified(job, {
  decodeVerified: true,
  visualReviewed: true,
  lipSyncAccepted: true,
  identityAccepted: true,
  audioAccepted: true,
  contactSheetAsset: "asset://contact-sheet.jpg"
});
assert(canDeliverPresenter(job), "delivery requires completed technical and visual QA");

console.log("ALL PASSED - native Toasty presenter workflow invariants hold.");
