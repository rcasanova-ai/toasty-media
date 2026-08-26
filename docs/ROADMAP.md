# Toasty Media Roadmap

## Phase 1: Site Foundation And Host/Guest Call

- Organize the repository as a Toasty Media web and Studio monorepo.
- Establish `site/` as the maintainable public website foundation.
- Establish `studio/director.html` and `studio/guest.html`.
- Use hosted VDO.Ninja through `js/video-engine.js`.
- Support disposable room IDs and guest invite links.
- Provide guest device preview, background choice, and join state.
- Provide host and guest controls, soundboard, real local recording proof, and session end.
- Preserve honest fallback states for browser permission and recording support failures.

## Phase 2: Reliable Local Isolated Recording

- Improve the proven browser-local recording path.
- Add start/stop coordination between host and guest.
- Record isolated audio and video where browser/device support allows it.
- Store and reconcile session metadata beside media outputs.
- Add recovery behavior for dropped tracks.
- Detect and guide around device contention when VDO.Ninja and MediaRecorder compete for the same camera or microphone.

## Phase 3: Google Drive Automatic Storage

- Implement OAuth and least-privilege Drive access.
- Create episode folders automatically.
- Upload raw assets safely.
- Verify upload integrity before allowing local cleanup.
- Keep local recordings temporary by design.

## Phase 4: FFmpeg Automatic Post-Production

- Add an FFmpeg processing adapter.
- Sync tracks.
- Normalize audio.
- Generate full video and audio-only podcast exports.
- Add optional intro, outro, and Toasty Media branding.
- Prepare clip-ready exports.

## Phase 5: Transcription And Social Clips

- Add a local/open-source Whisper transcription adapter.
- Produce full transcript, speaker-attributed transcript where practical, subtitles, plain text, and Markdown.
- Generate clip candidates from transcript and media timestamps.

## Phase 6: YouTube And Publishing Workflow

- Prepare full episode upload packages.
- Prepare podcast audio packages.
- Prepare social clip packages.
- Require explicit approval before publishing.
- Add status tracking and retry behavior.

## Phase 7: AI Content Extraction And Media Automation

- Generate episode summaries.
- Extract key quotes.
- Draft articles and LinkedIn posts.
- Suggest titles and show notes.
- Generate short-form social copy.
- Keep AI outputs in the Toasty Media workflow layer, separate from video transport and processing engines.
