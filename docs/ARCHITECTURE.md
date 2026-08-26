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

The Studio is designed so Toasty Media owns the workflow and replaceable engines sit behind adapters.

## Video Engine Adapter

Current real-time transport is hosted VDO.Ninja, embedded through iframes. VDO.Ninja is not forked or self-hosted in this phase.

Authoritative references checked during implementation:

- VDO.Ninja iframe embedding and `postMessage` API: https://docs.vdo.ninja/guides/iframe-api-documentation
- VDO.Ninja iframe API basics and commands such as `mic`, `camera`, `mute`, `volume`, and `getDetailedState`: https://docs.vdo.ninja/guides/iframe-api-documentation/iframe-api-basics
- Director permissions through `director=roomname`: https://docs.vdo.ninja/guides/iframe-api-documentation/iframe-api-for-directors
- Background/effects parameters: https://docs.vdo.ninja/advanced-settings/video-parameters/effects
- Virtual background image lists: https://docs.vdo.ninja/advanced-settings/video-parameters/and-imagelist

Other Studio code calls internal methods such as `setMicrophone`, `setCamera`, `setScreenShare`, `requestRecording`, and `mountGuestFrame`. It should not construct VDO.Ninja URLs directly.

## Background System

Guest onboarding supports:

- No background
- Background blur
- Warm newsroom preset
- Research library preset
- Fireside stage preset

The guest page provides a local visual preview before joining. VDO.Ninja blur maps to `effects=3`. Placeholder virtual background presets map to `effects=5` structurally, but final production-grade transmitted background images require CORS-hosted image URLs through VDO.Ninja `imagelist` or a future self-owned media pipeline. Custom uploaded backgrounds should later be staged through validated temporary object storage before being passed to the video engine.

## Soundboard

The MVP soundboard is modular and intentionally small:

- Intro
- Outro
- Short stinger
- Applause/reaction
- Custom slot placeholder
- Volume control

`js/soundboard.js` currently synthesizes simple cues with the Web Audio API so the foundation works without bundled audio assets. It can later load approved audio files from `assets/audio/` without touching director page logic.

## Recording

Phase 1 exposes a recording request control and visible timer, but reliable local isolated recording is not complete yet.

Prepared recording model:

- Host track
- Guest track
- Audio track data
- Video track data where required
- Session metadata
- Recording event log

Technical gate: hosted cross-origin VDO.Ninja iframes do not give Toasty Studio direct access to isolated host and guest media tracks. The current `requestRecording` adapter sends a VDO.Ninja recording command and tracks UI state honestly. Phase 2 must prove a reliable local isolated capture path before the product claims recording is complete.

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
