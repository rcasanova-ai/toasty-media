// Native Toasty Studio presenter-video workflow.
// Adapted from cclank/lanshu-create-ai-presenter-video (MIT).
//
// This module owns workflow/state/consent invariants only. Provider calls remain
// behind adapters so Studio can use cheap/open/local services without lock-in.

export const PresenterPhase = Object.freeze({
  INTAKE: "intake",
  PREFLIGHT: "preflight",
  NARRATION_LOCKED: "narration-locked",
  PILOT: "pilot",
  PRESENTER_GENERATED: "presenter-generated",
  EDITED: "edited",
  VERIFIED: "verified",
  DELIVERED: "delivered"
});

export const PRESENTER_DEFAULTS = Object.freeze({
  aspect: "9:16",
  width: 1080,
  height: 1920,
  fps: 30,
  targetDurationSeconds: 60,
  paidCandidateRetryCeiling: 3
});

export function createPresenterJob({
  id,
  script = "",
  topic = "",
  presenterImage,
  voiceSample = null,
  aspect = PRESENTER_DEFAULTS.aspect,
  width = PRESENTER_DEFAULTS.width,
  height = PRESENTER_DEFAULTS.height,
  fps = PRESENTER_DEFAULTS.fps,
  targetDurationSeconds = PRESENTER_DEFAULTS.targetDurationSeconds,
  rightsConfirmed = false,
  adultPresenterConfirmed = false,
  remoteUploadApproved = false,
  voiceCloneApproved = false
} = {}) {
  if (!id) throw new Error("presenter job id is required");
  if (!presenterImage) throw new Error("presenter image is required");
  if (!script && !topic) throw new Error("script or topic is required");

  return {
    id,
    kind: "presenter-video",
    version: 1,
    phase: PresenterPhase.INTAKE,
    createdAt: new Date().toISOString(),
    input: {
      script,
      topic,
      presenterImage,
      voiceSample,
      aspect,
      width,
      height,
      fps,
      targetDurationSeconds,
      rightsConfirmed: Boolean(rightsConfirmed),
      adultPresenterConfirmed: Boolean(adultPresenterConfirmed),
      remoteUploadApproved: Boolean(remoteUploadApproved),
      voiceCloneApproved: Boolean(voiceCloneApproved)
    },
    manualReview: {
      imageViewed: false,
      singleClearFace: false,
      imageHasNoUnwantedText: false
    },
    narration: {
      status: "pending",
      scriptHash: null,
      audioAsset: null,
      durationSeconds: null,
      asrVerified: false
    },
    presenter: {
      pilotStatus: "pending",
      generationStatus: "pending",
      acceptedProvider: null,
      acceptedRequestId: null,
      paidCandidateAttempts: 0
    },
    edit: {
      timeline: null,
      status: "pending"
    },
    qa: {
      decodeVerified: false,
      visualReviewed: false,
      lipSyncAccepted: false,
      identityAccepted: false,
      audioAccepted: false,
      contactSheetAsset: null
    },
    output: {
      masterAsset: null,
      shareAsset: null,
      deliveryReportAsset: null
    }
  };
}

export function presenterPreflight(job, { remote = false, voiceClone = false } = {}) {
  const errors = [];
  const remoteBlockers = [];

  if (!job?.input?.presenterImage) errors.push("presenter-image-required");
  if (!job?.input?.script && !job?.input?.topic) errors.push("script-or-topic-required");
  if (!job?.input?.rightsConfirmed) errors.push("image-rights-not-confirmed");
  if (!job?.input?.adultPresenterConfirmed) errors.push("adult-presenter-not-confirmed");
  if (!job?.manualReview?.imageViewed) errors.push("image-not-reviewed");
  if (!job?.manualReview?.singleClearFace) errors.push("single-clear-face-not-confirmed");
  if (!job?.manualReview?.imageHasNoUnwantedText) errors.push("image-text-review-not-complete");

  if (!job?.input?.remoteUploadApproved) remoteBlockers.push("remote-upload-not-approved");
  if (voiceClone && !job?.input?.voiceSample) remoteBlockers.push("voice-sample-required");
  if (voiceClone && !job?.input?.voiceCloneApproved) remoteBlockers.push("voice-clone-not-approved");

  return {
    ok: errors.length === 0,
    remoteReady: errors.length === 0 && remoteBlockers.length === 0,
    errors,
    remoteBlockers,
    requestedRemoteOperation: Boolean(remote),
    requestedVoiceClone: Boolean(voiceClone)
  };
}

export function assertPresenterRemoteAllowed(job, options = {}) {
  const preflight = presenterPreflight(job, { ...options, remote: true });
  if (!preflight.ok || !preflight.remoteReady) {
    const reasons = [...preflight.errors, ...preflight.remoteBlockers].join(", ");
    throw new Error(`presenter remote generation blocked: ${reasons}`);
  }
  return true;
}

export function lockPresenterNarration(job, {
  scriptHash,
  audioAsset,
  durationSeconds,
  asrVerified = false
} = {}) {
  if (!scriptHash) throw new Error("scriptHash is required");
  if (!audioAsset) throw new Error("audioAsset is required");
  if (!(Number(durationSeconds) > 0)) throw new Error("durationSeconds must be positive");
  if (!asrVerified) throw new Error("narration must pass ASR verification before lock");

  job.narration = {
    status: "locked",
    scriptHash,
    audioAsset,
    durationSeconds: Number(durationSeconds),
    asrVerified: true
  };
  job.phase = PresenterPhase.NARRATION_LOCKED;
  return job;
}

export function registerPaidPresenterCandidate(job, { accepted = false, provider = null, requestId = null } = {}) {
  const ceiling = PRESENTER_DEFAULTS.paidCandidateRetryCeiling;
  if (job.presenter.paidCandidateAttempts >= ceiling) {
    throw new Error(`paid presenter candidate ceiling reached (${ceiling})`);
  }
  job.presenter.paidCandidateAttempts += 1;
  if (accepted) {
    job.presenter.acceptedProvider = provider;
    job.presenter.acceptedRequestId = requestId;
    job.presenter.pilotStatus = "accepted";
  } else {
    job.presenter.pilotStatus = "rejected";
  }
  return job.presenter.paidCandidateAttempts;
}

export function buildPresenterTimeline(job, {
  presenterAsset,
  captionsAsset = null,
  supportingMedia = [],
  callouts = []
} = {}) {
  if (job?.narration?.status !== "locked") {
    throw new Error("narration must be locked before building presenter timeline");
  }
  if (!presenterAsset) throw new Error("presenterAsset is required");

  const duration = Number(job.narration.durationSeconds);
  const timeline = {
    masterClock: "narration",
    durationSeconds: duration,
    fps: job.input.fps,
    canvas: {
      width: job.input.width,
      height: job.input.height,
      aspect: job.input.aspect
    },
    tracks: {
      narration: {
        asset: job.narration.audioAsset,
        start: 0,
        end: duration,
        authoritative: true
      },
      presenter: {
        asset: presenterAsset,
        start: 0,
        end: duration,
        muteSourceAudio: true
      },
      captions: captionsAsset ? { asset: captionsAsset, start: 0, end: duration } : null,
      supportingMedia: supportingMedia.map((item) => ({ ...item })),
      callouts: callouts.map((item) => ({ ...item }))
    }
  };

  job.edit.timeline = timeline;
  job.edit.status = "planned";
  job.phase = PresenterPhase.PRESENTER_GENERATED;
  return timeline;
}

export function markPresenterVerified(job, {
  decodeVerified,
  visualReviewed,
  lipSyncAccepted,
  identityAccepted,
  audioAccepted,
  contactSheetAsset = null
} = {}) {
  Object.assign(job.qa, {
    decodeVerified: Boolean(decodeVerified),
    visualReviewed: Boolean(visualReviewed),
    lipSyncAccepted: Boolean(lipSyncAccepted),
    identityAccepted: Boolean(identityAccepted),
    audioAccepted: Boolean(audioAccepted),
    contactSheetAsset
  });

  const complete = job.qa.decodeVerified &&
    job.qa.visualReviewed &&
    job.qa.lipSyncAccepted &&
    job.qa.identityAccepted &&
    job.qa.audioAccepted;

  if (!complete) throw new Error("presenter verification incomplete");
  job.phase = PresenterPhase.VERIFIED;
  return job;
}

export function canDeliverPresenter(job) {
  return job?.phase === PresenterPhase.VERIFIED &&
    Boolean(job?.qa?.decodeVerified) &&
    Boolean(job?.qa?.visualReviewed);
}
