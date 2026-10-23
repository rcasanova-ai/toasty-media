# Moxie behavioral intelligence

Moxie finds the moments worth clipping by looking at what was said **and what happened**: the words, the voice, the picture and
how people responded to each other. It runs entirely in the browser. Nothing is uploaded and no paid API is used.

The engine lives in `js/behavior/` and is independent of the Clips page (`js/clips-app.js`), so another product can reuse it.

## What problem it fixes

`js/clip-detector.js` scores a transcript line only when it contains a phrase from a keyword list and drops anything under 45.
A real 30 segment transcript with none of those phrases returned "No standout moments found". The detector is still used for
live bookmarks in the Studio, where there is no finished transcript to read. It is **not** used by Analyze with Moxie.

Regression: `scripts/behavior-moments-test.mjs` (the keyword detector finds nothing in 30 plain segments, Moxie returns clips) and
`scripts/moxie-clips-browser-test.mjs` (the same flow in Chrome from upload to a playable MP4).

## Flow

```
Select recording -> Analyze with Moxie -> Review clips -> Apply style -> Export
```

`analyzeRecording()` (`js/behavior/engine.js`) does, in order, each step optional and each failure reported rather than fatal:

1. Decode the audio locally (16 kHz mono).
2. If there is no transcript, transcribe with Whisper (`whisper-tiny.en`, transformers.js) in the browser.
3. Sample the video and measure movement; track faces, hands and posture with MediaPipe if it loads.
4. Voice analysis against this recording's own baseline (in a Web Worker, falling back to the main thread).
5. Language analysis (meaning, structure, topics).
6. Interaction analysis (what happened between people).
7. Choose, bound, rank and explain moments.

## Modules

| File | Role |
| --- | --- |
| `timeline.js` | `BehaviorTimeline`: one clock, nine tracks (transcript, audio, face, gesture, motion, turns, interaction, language, boundaries), capabilities, and a guard that refuses to serialise anything that looks like a face template. |
| `text.js` | Sentence units with timing, tokens, local lexical embedder. |
| `embeddings.js` | Lazy sentence-embedding model (`Xenova/all-MiniLM-L6-v2`, quantized, about 23 MB) with a declared lexical fallback. |
| `language.js` | Per-sentence significance, stories, questions and answers, topic changes. |
| `vocal.js`, `vocal-worker.js`, `vocal-client.js` | Intensity, pitch, pitch variation, pace, pauses, laughter, overlap, energy shifts, pitch-based turn estimate. |
| `visual.js` | Pure feature and event functions, MediaPipe loader, video sampler. |
| `interaction.js` | Challenge and response, interruptions, rapid exchange, shared laughter, visible reactions, pattern changes, build-up, meaningful pauses, surprising exchanges, resolution. |
| `moments.js` | Candidate windows, multimodal scoring, ranking, boundaries, evidence, explanation, recommended format and template. |
| `engine.js` | Orchestration, progress, cancellation, injectable dependencies. |

## What is semantic and what is not

This is the honest accounting. It is also shown on screen in "What Moxie used".

* **Meaning (model).** With the sentence-embedding model loaded (`semantic.kind = "minilm"`), each sentence is compared with
  prototype statements for opinion, insight, story, humour, surprise, advice and disagreement, and topic changes come from
  embedding drift. This is real semantic similarity, but similarity to a handful of prototypes is not full understanding.
* **Structure (no model).** Information density relative to the recording, specificity, stance, contrast, explanation, a
  time-ordered first-person past-tense account (story), questions and their answers, and how quotable a line is. These are
  discourse heuristics. They need no trigger phrase: every sentence is scored, and a clip needs only to be more significant than
  the rest of the recording. A small set of function words is used as one feature among many, never as a gate.
* **Fallback.** If the model cannot load, topic changes come from shared vocabulary only (`semantic.kind = "lexical"`) and the
  result, the notes and the screen say so. The keyword detector is never silently substituted.
* **Missing transcript.** If Whisper cannot load and no transcript was given, the analysis uses voice and picture only. Confidence
  is capped (no high confidence, score at most 60) and the explanation says no transcript was available.

Tier meanings: **Strong moment** needs a score of at least 52 and corroboration from a second kind of evidence (voice, picture or
interaction) in addition to the words. **Good moment** is 40 or more. **Best available passage** is everything else; if nothing
better exists the clips are returned labelled that way instead of an empty list.

## Observable signals only

Faces: smile (mouth corners raised), raised eyebrows, mouth opened wide, head turn, head nod, leaning in or back, movement across
the frame. Hands: hand movement (gesture intensity). Posture: shoulder shift, leaning. Picture: sudden movement, stillness.
Nothing infers a feeling, and a test checks that explanations never name one.

Face position is reported as a slot (left to right) so a reaction can be framed, never as an identity. Hand and pose results are
reduced to speed and position. Landmarks, blendshape vectors and embeddings are discarded as soon as the scalar features are
computed and are never stored or exported; `BehaviorTimeline.toJSON()` throws if any field or numeric vector looks like one.

Sampling: about 900 frames at most, one every 0.5 to 4 seconds. Quick nods need 0.6 s sampling or finer, so on recordings longer
than about 7.5 minutes the analysis adds a note that short nods and gestures can be missed.

## Scoring

Per candidate window, each 0 to 1: semantic significance, vocal emphasis, visible reactions, gestures, interaction dynamics,
narrative completeness, clip suitability. Modalities that were not analysed are removed and the rest re-weighted, so audio-only,
single person, faceless and quiet recordings all work. Voice, picture and gesture evidence is multiplied by a context factor from
meaning or interaction (0.35 to 1), so loudness or fidgeting without anything said or answered cannot make a clip. Repeats of the
same kind of event in one clip count once. Windows never span more than 10 seconds of silence. Vocal measures are relative to the
recording ("9 dB above this recording's usual level"), never absolute.

Every suggestion carries: start, end, title, category, score, tier, per-modality components, the evidence (timeline event ids with
times and wording), an explanation built only from that evidence, and a recommended aspect ratio, template, caption style and
crop focus. `scripts/behavior-moments-test.mjs` asserts that each piece of evidence is a detected event inside the clip and that
the explanation mentions only evidence that exists.

## Privacy, consent and reuse

* Everything runs locally; only the model files are downloaded (jsDelivr, Hugging Face, Google Cloud Storage), then cached by the browser.
* The user can turn off the downloadable models and the picture analysis on the Clips page (`toasty.moxie.prefs`).
* The behavior timeline can be downloaded as JSON. It holds derived scalars and text only.
* For Santati or any other product: import `analyzeRecording` / `analyzeTimeline` and pass your own `deps` (`decodeAudio`,
  `transcribe`, `sampleVideo`, `vocalRunner`). The engine has no knowledge of Toasty Studio storage, accounts or recordings.
  Consent and the separation of recording data between products stay the caller's responsibility: the engine reads only what it is
  handed, keeps no state between runs and sends nothing anywhere.

## Performance and limits

* Models load lazily on first use; transformers.js and MediaPipe cache model files in the browser.
* Voice analysis runs in a Web Worker (main-thread fallback yields between 20 s blocks). Embedding runs in batches of 16 with a
  yield between batches. Frame sampling awaits each seek. A 60 minute transcript with 930 sentences and 12,000 candidate windows is
  scored in about 1.5 s in Node.
* Cancel stops at the next stage or batch and returns nothing half-finished.
* Files over 700 MB are refused for in-browser decoding (existing limit). Whisper tiny is slow on long recordings, so very long
  files should arrive with a transcript (Studio recordings do).
* Not done: speaker diarization beyond a pitch-based two-voice estimate (marked as estimated), face tracking when sampling is
  coarse, and non-English transcription (`whisper-tiny.en`).

## Tests

| Test | Covers |
| --- | --- |
| `behavior-timeline-test` | one clock, queries, capabilities, no-biometrics guard |
| `behavior-vocal-test` | intensity, pitch, pace, pauses, laughter, quiet recordings, turn estimate, cancel |
| `behavior-visual-test` | features and events from synthetic MediaPipe-like data, tracker failure |
| `behavior-language-test` | significance without triggers, stories, Q and A, topics, model failure |
| `behavior-moments-test` | the original failure, audio-only, single speaker, two people, no faces, quiet, loud but empty, missing signals, 60 minute recording, evidence grounding |
| `behavior-engine-test` | automatic transcription, each model failing, cancellation at every stage, reuse |
| `moxie-clips-browser-test` (Chrome) | upload, 30 segment regression, preview, edit, template and transition, batch export in three aspect ratios, playable MP4, audio/video sync, refresh, cancel, audio-only, blocked model |
| `moxie-models-browser-test` (Chrome, network) | the real language model, MediaPipe trackers and Whisper load and run |
