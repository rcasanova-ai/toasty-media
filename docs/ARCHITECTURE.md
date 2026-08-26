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
- The director screen separates host self-preview from program output. Host self-preview is the VDO.Ninja publishing iframe with `showpreview`, `fullscreen`, and `cleanoutput` so the host sees their camera immediately after granting permission without duplicate parent-page camera capture. Program output is a VDO.Ninja `room` + `scene=0` iframe; VDO documents `scene=0` as auto-adding all room videos.
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

## Recording

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
