# Presenter Video Pipeline

Toasty Studio now has a provider-neutral presenter-video workflow derived from the MIT-licensed `cclank/lanshu-create-ai-presenter-video` project.

## Product contract

Input:

* One authorized adult presenter image.
* A finished script or topic.
* Optional authorized voice sample.
* Explicit approval before any remote provider receives the presenter image.
* Explicit voice-clone approval when a voice sample is used for cloning.

Pipeline:

```
intake
  -> manual image review
  -> preflight
  -> lock narration + ASR verification
  -> low-cost presenter pilot
  -> full presenter generation
  -> narration-driven deterministic edit
  -> captions/callouts/supporting media
  -> decode + visual + lip-sync + identity + audio QA
  -> master/share delivery
```

The locked narration is the master clock. Generated presenter video is muted in the final composition. Captions and scene timing are derived only after narration is locked.

## Cost safety

Remote generation is blocked until explicit remote-upload approval exists. Voice cloning additionally requires a supplied voice sample and explicit approval. Paid presenter candidates stop after three rejected attempts.

This should plug into Studio's existing render/finalization stack rather than creating a parallel renderer.

## Provider adapters

The workflow deliberately does not depend on HeyGen, FAL, Kling, Wan, MiniMax, ElevenLabs, OpenAI, or any other provider. A provider adapter should return normalized assets/request IDs while the workflow owns consent, sequencing, retry limits and QA.

Likely adapter surfaces:

```js
generateNarration({ script, voice, job })
generatePresenterPilot({ image, narration, job })
generatePresenterFull({ image, narration, acceptedPilot, job })
transcribeWithTimestamps({ audio, job })
finalizePresenterVideo({ timeline, job })
```

This keeps Toasty free to switch between self-hosted, open-source, BYOK and paid providers.

## Source

Adapted from:

* `cclank/lanshu-create-ai-presenter-video`
* MIT license
* Preserved/ported implementation reference: `NousResearch/hermes-agent/optional-skills/creative/ai-presenter-video`

See `docs/THIRD_PARTY_NOTICES.md`.
