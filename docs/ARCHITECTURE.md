# Toasty Media Architecture

## Brand Structure

Toasty Media is the public umbrella brand for shows, editorial packages, and production workflows. Toasty Studio is a product descriptor under Toasty Media for browser-based interview and podcast production. Toasty Talks remains available as a show or series name, not the parent brand.

Canonical brand assets live in `shared/brand/`:

- `shared/brand/toasty-media/` for primary Toasty Media logos, cheatsheets, colors, and approved imagery.
- `shared/brand/toasty-talks/` for legacy or series-level Toasty Talks assets.

The shared assets are referenced by both the public site and Studio. They should not be copied into each surface unless a build system later requires generated derivatives.

## Public Site

The public website foundation is static and dependency-light:

- `site/index.html` is the first maintainable homepage for `toasty.media`.
- `site/ricardo/index.html` is the canonical redesigned Ricardo profile.
- `ricardo/index.html` preserves the legacy `/ricardo/` production path as a redirect.
- `articles/`, `eloquencebonus/`, root PDFs, and `thank-you.html` preserve useful production URLs under Git management.
- `css/brand.css` contains shared brand tokens and base UI primitives.
- `css/site.css` contains public website layout.
- The repository root `index.html` redirects to `site/` for simple static hosting compatibility.

The homepage currently establishes identity, concise media positioning, featured series slots, a future-proof workflow section, and a public link into Toasty Studio. Future pages can be added under `site/` without changing the Studio internals.

## Studio

Toasty Studio is a static browser app:

- `studio/director.html` is the host/director console.
- `studio/guest.html` is the no-account guest onboarding flow.
- `css/studio.css` contains Studio-specific layout and responsive styling.
- `js/director.js` owns director page state and UI bindings.
- `js/guest.js` owns guest device preview, setup, and join state.
- `js/video-engine.js` isolates VDO.Ninja-specific URL and iframe API logic.
- `js/soundboard.js` isolates sound cue behavior.
- `js/recording.js` owns browser-local isolated recording behavior.

The Studio is designed so Toasty Media owns the workflow and replaceable engines sit behind adapters.

## Video Engine Adapter

Current real-time transport is hosted VDO.Ninja, embedded through iframes. VDO.Ninja is not forked or self-hosted in this phase.

Authoritative references checked during implementation:

- VDO.Ninja iframe embedding and `postMessage` API: https://docs.vdo.ninja/guides/iframe-api-documentation
- VDO.Ninja iframe API basics and commands such as `mic`, `camera`, `mute`, `volume`, and `getDetailedState`: https://docs.vdo.ninja/guides/iframe-api-documentation/iframe-api-basics
- Director permissions through `director=roomname`: https://docs.vdo.ninja/guides/iframe-api-documentation/iframe-api-for-directors
- Background/effects parameters: https://docs.vdo.ninja/advanced-settings/video-parameters/effects
- Virtual background image lists: https://docs.vdo.ninja/advanced-settings/video-parameters/and-imagelist

Other Studio code calls internal methods such as `setMicrophone`, `setCamera`, `setScreenShare`, `setGuestMicrophone`, `setGuestCamera`, `setGuestScreenShare`, and `mountGuestFrame`. It should not construct VDO.Ninja URLs directly.

The current two-person call path uses hosted VDO.Ninja room participant iframes:

- Host: generated alphanumeric room ID plus a host `push` stream.
- Guest: invite URL with the same room ID plus a generated guest `push` stream.
- Host and guest use the native VDO.Ninja room UI inside the iframe for WebRTC transport, echo handling, and cross-browser device negotiation.
- Toasty Studio controls send `postMessage` commands to the relevant iframe for mic, camera, screen share, state checks, and hangup.
- The director screen separates host self-preview from program output. Host self-preview is the VDO.Ninja publishing iframe with the minimum source setup: `room`, `push`, `label`, `showlabels`, and `api`. Program output is a VDO.Ninja `room` + `scene=0` iframe; VDO documents `scene=0` as auto-adding all room videos.
- Room IDs and stream IDs are generated as alphanumeric strings because VDO.Ninja documents room IDs as alphanumeric and stream IDs as safest when alphanumeric.

## Background System

Guest onboarding supports:

- No background
- Background blur
- Warm newsroom preset
- Research library preset
- Fireside stage preset

The guest page provides a local visual preview before joining. VDO.Ninja blur maps to `effects=3` and is requested when the guest joins. Toasty Media preset backgrounds are preview-only in the hosted VDO.Ninja MVP because production-grade virtual background replacement requires hosted image URLs through VDO.Ninja `imagelist`, browser/device support, and realistic cross-browser QA. Custom uploaded backgrounds should later be staged through validated temporary object storage before being passed to the video engine.

## Soundboard

The MVP soundboard is modular and intentionally small:

- Intro
- Outro
- Short stinger
- Applause/reaction
- Custom slot placeholder
- Volume control

`js/soundboard.js` currently synthesizes simple cues with the Web Audio API so the foundation works without bundled audio assets. It can later load approved audio files from `assets/audio/` without touching director page logic.

The soundboard is local to the host browser in this phase. Hosted VDO.Ninja iframes do not expose a simple parent-page path for injecting Web Audio output into the live WebRTC mix. For now, cues are useful for host monitoring and can be incorporated into recording/post-production later through FFmpeg or through a future virtual audio device / WebRTC-owned mixer path.

## Chunk-Safe Recording And Personal Recording Mode

Recording no longer has to hold a session in browser memory. Every MediaRecorder timeslice is persisted and uploaded as it is produced, so a crash or refresh at minute 89 loses at most the last couple of seconds.

Pipeline:

- `js/recording-uploader.js` — `ChunkUploader` writes each chunk to a durable queue (IndexedDB, `MemoryChunkStore` in tests) before any network attempt, uploads with retry/backoff and SHA-256 integrity, and deletes a chunk from the queue only after the server acknowledges it. `recoverInterruptedRecording()` finishes a recording whose page died.
- `scripts/render-production-server.mjs` ("Chunk-safe recording store") — stores chunks on the render host's filesystem next to the SQLite DB (`TOASTY_RECORDINGS_DIR`, default `<dir of TOASTY_AUTH_DB>/recordings`; no new vendor). Layout: `<owner>/<session_id>/<recording_id>/<participant_id>/<track_id>/<seq>.chunk` plus `manifest.json`. The filesystem is the source of truth for which chunks exist.
- API (all authenticated, CSRF, owner-scoped): `POST /api/recordings` (create; idempotent resume by `recordingId`), `POST /api/recordings/:session/:recording/tracks` (register another track), `POST .../chunks/:participant/:track/:seq` (idempotent, `?sha256=`), `POST .../complete` (202, async finalize), `GET .../:session/:recording` (manifest plus live sequence view), `GET /api/recordings?sessionId=`, `GET .../files/:participant/:track[?kind=source]`.
- Finalization is asynchronous (single-slot FFmpeg queue): chunks are byte-concatenated to `source.webm`, then transcoded to `final.mp4` (video tracks) or `final.m4a` (audio-only tracks). A recording whose uploader disappeared is completed automatically after `TOASTY_RECORDING_ABANDON_MS` (default 10 minutes) from whatever arrived, and interrupted finalizations resume after a server restart. A gap in the sequence yields `state: "partial"` rather than a silent success.

Manifest (`schemaVersion: 2`): recording state, start/stop timestamps, duration, markers, a `metadata.timeline` of scene/layout/asset/ticker changes, and per track: `type`, `role` (`composed` | `isolated`), `participantId`, `mimeType`, `codecs`, `hasVideo`/`hasAudio`, video geometry, `startedAtMs` and `offsetMs` (sync against recording start), `sequence` (count, lastSeq, contiguousThrough, missingSeqs, bytes), and `final` (status, file, bytes). Track types already defined: `program`, `camera`, `microphone`, `audio-mix`, `screen`, `camera-secondary`, `phone-camera`, `uploaded-video`, `remote-guest`. A new source is a new track on the same calls; no schema change.

Personal Recording Mode (`studio/record.html`, `js/record-page.js`, `js/personal-recording.js`): one getUserMedia feeds three tracks — the composed `program` (first-party canvas via `js/program-compositor.js`: same skins, layout geometry, name plate, asset cards, ticker and End Card as live Program Output, with the mic and optional program audio mixed in), the isolated `camera` (video only) and the isolated `microphone` (audio only), the latter two through `LocalIsolatedRecorder` in streaming mode (`chunkSinks`). Pass `?room=<roomId>` and the compositor follows the same canonical program state a producer or Moxie publishes (`compositorStateFromProgram`).

Boundary: isolated recording of VDO.Ninja guests is not attempted by capturing cross-origin iframe media. Guests will record and upload their own tracks from their own browser against this same API (next milestone).

## Local Recording (Phase 1)

Phase 1 now implements the first reliable recording proof possible without owning the WebRTC stack: browser-local isolated recording for each participant.

Prepared recording model:

- Host audio and video, recorded locally in the host browser.
- Guest audio and video, recorded locally in the guest browser.
- Session metadata written with each participant package.
- Future upload and reconciliation metadata for Google Drive.

Implementation:

- `js/recording.js` uses `navigator.mediaDevices.getUserMedia` and `MediaRecorder`.
- It records separate audio-only and video-only streams where the browser supports it.
- In Chromium browsers with File System Access API support, stopping a recording prompts for a directory and writes:

```text
session/
  session.json
  host/
    audio.webm
    video.webm
```

or:

```text
session/
  session.json
  guest-1/
    audio.webm
    video.webm
```

- In browsers without File System Access API support, it falls back to downloading separate JSON/audio/video files.

Limitations:

- Hosted cross-origin VDO.Ninja iframes do not give Toasty Studio direct access to isolated remote tracks.
- Each participant must start and stop their own local recording in this proof.
- Browser camera/microphone exclusivity varies. Some browsers/devices may not allow VDO.Ninja and the parent page recorder to capture the same camera/microphone at the same time.
- Safari MediaRecorder and File System Access support are less reliable than current Chrome.
- Local files are not automatically uploaded or reconciled yet.

## Google Drive Storage

Automatic Google Drive storage is planned around verified uploads, not permanent local media storage.

Folder model:

```text
Toasty Media/
Global AI Leadership Series/
Episode 001 - Guest Name/
Raw/
Processed/
Clips/
Audio/
Transcript/
Artwork/
```

Intended workflow:

1. Record locally.
2. Upload safely to Google Drive.
3. Verify upload integrity.
4. Treat local recordings as temporary.
5. Allow local cleanup only after verified upload.

OAuth and upload are not implemented in Phase 1.

## FFmpeg Layer

Future post-production should use FFmpeg as a replaceable processing engine, not browser timeline editing.

The eventual automated recipe:

- Sync isolated tracks.
- Normalize audio.
- Combine layout.
- Add intro and outro.
- Add branding or logo treatment when selected.
- Export full video.
- Export audio-only podcast.
- Prepare social clips.

The user-facing target is one explicit `Process Episode` action.

## Whisper Layer

Future transcription should use a locally runnable or open-source Whisper implementation.

Planned outputs:

- Full transcript
- Speaker-attributed transcript where practical
- Subtitle file
- Plain text transcript
- Markdown transcript

Transcription is not a dependency for basic call or recording reliability.

## AI Media Pipeline

Future AI outputs belong to the Toasty Media workflow layer, not the video engine:

- Episode summary
- Key quotes
- Book or research excerpts
- Article draft
- LinkedIn content
- Short-form social copy
- Clip suggestions
- Titles
- Show notes

These should run after recording, upload verification, and transcript availability.

## Publishing

YouTube and podcast publishing are not implemented yet. Future publishing should support approval-based or one-click workflows for:

- Full episode to YouTube
- Podcast audio
- Social clips

Publishing must require explicit user approval initially.

## Replaceable Engines

External engines are infrastructure, not the product architecture:

- VDO.Ninja: real-time video transport for now.
- FFmpeg: future media processing.
- Whisper: future transcription.
- Google Drive: future storage target.

Adapters should keep these assumptions from spreading through Toasty Studio.
