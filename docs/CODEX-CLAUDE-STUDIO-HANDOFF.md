# CODEX / CLAUDE STUDIO HANDOFF

This document is the continuation brief for the Visual Production Completion + Marathon architecture PR. Do not treat scaffolding as done. Do not merge. Do not deploy. Do not claim real-device verification.

## 1. Current architecture

```
HOST DEVICE                         GUEST DEVICE                      PROGRAM OUTPUT (any device)
camera + mic                        camera + mic                      no window.opener required
optional ScreenShareSource          optional ScreenShareSource
        │                                   │                                  │
        │  VDO push (camera id = roomId+h)  │  VDO push (guest stream id)      │
        │  VDO push (screen id = roomId+s…) │  VDO push (screen id = roomId+s…)│
        ▼                                   ▼                                  ▼
 RoomPresence heartbeat (identity, screenShare, audioActivity, transcriptEvent)
        │                                   │                                  │
        └──────── canonical program state (Host publisher) ────────────────────┘
                           │
                           ▼
                   ProgramComposition  ←  ActiveSpeakerController (metadata only)
                           │
                           ▼
                   Program Renderer (Preview = Output)
                           │
              ProgramAudioMixer (first-party streams + ProgramAudioBus)
                           │
              MasterRecorder (composed if possible, else tab-capture fallback)
```

VDO.Ninja is transport only. BroadcastChannel is same-browser acceleration only. Presence/control is the cross-device plane.

## 2. Known-good baseline

- Merged main: `20bb3907ec8714c0d51ecfdcd56af5de3f6c991f` (PR #25 Broadcast Visual Production)
- Real-device accepted: Host + Guest → Program Output → actual video → branded duo composition
- BUILD before this run: `2026.09.20-visprod`
- BUILD this run: `2026.09.20-marathon`
- Branch: `cursor/studio-marathon-architecture-12e4`
- Do not regress the 2-person Program Output path.

## 3. Built in this marathon

| Priority | What | Classification |
|---|---|---|
| P1 Cross-device Host screen share | Canonical `ScreenShareSource`. Host `mountScreenPublisher` second VDO push. Presence `transportSourceId`. PO binds via `mountParticipantView` without opener. Guest uses the same model. Native stop, late join, restore composition, camera preserved. | **BUILT + WIRED**. AUTOMATED TESTED (architecture). **NEEDS REAL DEVICE TEST**. |
| P2 Real active speaker | `ActiveSpeakerController` attack/hold/hysteresis/silence. Host AnalyserNode on `_hostPreviewStream`. Guest AnalyserNode on already-granted audio tracks + VDO detailedState parser. Presence metadata only. Balanced ignores nomination. Spotlight overrides. Clear Spotlight restores prior mode. | **BUILT + WIRED**. AUTOMATED TESTED (controller). **NEEDS REAL DEVICE TEST**. Guest WebRTC levels are best-effort. |
| P3 Program Audio mixer | `ProgramAudioMixer` / `ProgramAudioSource` / state. Wraps existing `ProgramAudioBus`. Native streams connect. Remote VDO voices marked `transportLimited: vdo-cross-origin` — **not faked**. PO listener uses mixer for bus + native host. | **BUILT + WIRED** for first-party + bus. **BLOCKED BY BROWSER/TRANSPORT** for remote VDO track extraction. |
| P4 Soundboard | Unchanged PLAY_AUDIO → ProgramController → ProgramAudioBus → mixer → PO. Missing Cholo still missing. | **WIRED** through mixer. No new toys. |
| P5 MasterRecorder V2 | `MasterRecorder` prefers composed video+mixer audio. Honest fail → existing tab-capture `MasterProgramRecorder`. | **BUILT**. Composed path **BLOCKED** by cross-origin VDO iframes. Fallback **WIRED**. **NEEDS REAL DEVICE TEST**. |
| P6 Multi-participant STT | `TranscriptEvent` + `ParticipantTranscriptionUplink`. Guest local Web Speech stamped with Guest identity. Host ingest of guest `transcriptEvent` via presence. Guest “Toasty, find…” does not execute. | **BUILT + WIRED**. Chrome Web Speech **cannot bind a MediaStream** → **BLOCKED BY BROWSER** for true per-track STT. Attribution is deterministic by browser identity. Demo/seeded path still exists and **must not reach production**. |
| P7 Hottie show loop | `hottie-show-runner.js` proposes SET_SPOTLIGHT / SURFACE_CHAT / RETURN_TO_PARTICIPANTS / focus-group probes. ProgramController gained SURFACE_CHAT, POST_CHAT, SHOW_RESEARCH, RETURN_TO_PARTICIPANTS. | **BUILT**. Proposals **WIRED** into LiveProducer checkpoint. Approval policy still required for public post. **NEEDS INTEGRATION REPAIR** (feed UX, autonomy auto-exec). |
| P8 Audience chat | `AudienceMessage` + adapters + Hottie public identity. Existing AudienceStore still used. | **BUILT**. TOASTY adapter **WIRED**. YouTube/X/Telegram adapters **SCAFFOLDED ONLY**. |
| P9 Session artifacts | `SessionArtifact` schema + store + default plan including FULL_EPISODE / SUMMARY / FOCUS_GROUP_INSIGHTS. | **BUILT**. Persistence/workers **SCAFFOLDED ONLY**. |
| P10 Focus Group | `attachFocusGroupToSession` uses LiveSession, ProgramComposition, TranscriptStore, Hottie, artifacts. | **BUILT + WIRED** as attach API. No separate AV stack. **NEEDS INTEGRATION REPAIR** with `studio/focus-group-demo.html`. |
| P11 Destinations / sources | `ProgramDestinationRouter`, `ParticipantSource`, `ScreenShareSource`. | **BUILT**. Third-party live push **SCAFFOLDED ONLY** (fails closed, not faked). |
| P12 Production timeline | `ProductionTimeline` events recorded for join/share/spotlight/chat/recording/Hottie proposal. | **BUILT + PARTIALLY WIRED**. Not every historical call site emits yet. **NEEDS INTEGRATION REPAIR**. |

## 4. Unfinished wires

1. Host Program Preview of remote screen uses VDO `&view=` of the screen push (no local `getDisplayMedia`). Confirm the publisher can view its own push on real hardware.
2. Guest activity: video tracks released at join; audio tracks kept. If a phone fails VDO audio because the parent still holds the mic, drop the analyser and rely on VDO detailedState only — do **not** call getUserMedia again.
3. `noteAudioLevel` maps Guest presence id → seat.id (VDO transport id). Confirm Active Speaker featured slot matches `composeProgram` participantIds (`seat.id`, not `guest-…` presence id).
4. Hottie proposals are private feed entries; Producer approval → `ProgramController.execute` is not a full UI loop yet.
5. Master recording still requires selecting the Program Output tab unless/until a server compositor exists.
6. Guest STT uses Web Speech default mic (browser API). Do not claim stream-bound STT.
7. `focus-group-demo.html` is not yet routed through `attachFocusGroupToSession`.
8. Artifact store is in-memory on LiveSession; not a durable backend table.
9. Destination adapters for YouTube/X/LinkedIn/Telegram/RTMP are fail-closed stubs.
10. `live-session.js` still imports `nominateActiveSpeaker` even though the controller wraps it — harmless, can clean.

## 5. Tests

Run from `toasty-media`:

```
node scripts/studio-marathon-architecture-test.mjs
node scripts/broadcast-visual-production-test.mjs
node scripts/program-composition-test.mjs
node scripts/presence-3way-test.mjs
node scripts/session-control-test.mjs
node scripts/media-diagnostics-test.mjs
node scripts/publisher-state-test.mjs
```

Plus other frozen suites listed in §12 of the original completion spec.

Any failure after this handoff belongs in this section. Do not delete a failing architectural assertion to “make CI green” if it encodes a real requirement.

## 6. Browser constraints

- Cross-origin VDO iframes: parent JS cannot read remote MediaStreams or iframe pixels.
- `element.captureStream()` will not include VDO video. Canvas compositor would be a second, incomplete picture — forbidden as “the master”.
- Chrome Web Speech API does not accept a supplied MediaStream.
- Exclusive-camera phones cannot keep a native preview **and** complete VDO camera push. Video tracks are released at Guest join.
- `AudioContext` is per-tab. Director monitor ≠ Program Audio. PO tab-capture is still the working audience+master audio path for VDO speech + bus.
- `getDisplayMedia` for Host screen was **not** used as the cross-device transport (would double-prompt with VDO `screenshare=1`). Transport is the separate VDO screen publisher, same as Guest.

## 7. Transport constraints

- VDO `{screenshare:true}` on the camera iframe **replaces** the camera. Never call `setScreenShare` / `setGuestScreenShare` on camera publishers.
- Screen push ids are `createScreenStreamId(roomId)` → `${roomId}s…`. Host guest-list filter already skips `${roomId}s`.
- Camera ids stay `${roomId}h` (Host) and `createGuestStreamId` (Guest).
- window.opener `__toastyProgramSources` is Host-camera (and optional local screen stream) optimization only.
- Presence TTL still applies; late PO join reads `program.screenShare` + roster `screenShare`.

## 8. Demo / seed / fallback paths that must NOT reach production

- `DemoTranscriptionProvider` / `HOTTIE_LIVE_PRODUCER_SCRIPT` / `DEMO_TRANSCRIPT_SCRIPT`
- `DemoAudienceFeed` / `DEMO_AUDIENCE_SCRIPT`
- `session.demoMode` seeded inputs
- Missing catalogue item `cholo-whistle-01` (`missing: true`) — do not synthesize
- Tab-capture master is a **fallback**, not the destination architecture
- Heuristic AI producer / force-heuristic drawer
- Any “Guest speech in ProgramAudioMixer.masterStream()” claim while sources are `transportLimited`

## 9. Files / modules owning each capability

| Capability | Owner |
|---|---|
| ScreenShareSource | `js/screen-share-source.js` |
| Host share publish | `js/live-session.js` `startScreenShare` / `stopScreenShare` + `#lvHostScreenTransport` |
| Guest share publish | `js/guest.js` `startGuestScreenShare` |
| VDO screen iframe | `js/video-engine.js` `mountScreenPublisher` |
| Presence share + activity + transcript | `js/room-presence.js`, `scripts/toasty-auth-db.py`, `scripts/render-production-server.mjs` |
| ProgramComposition | `js/program-composition.js` |
| Program Renderer + source health | `js/program-renderer.js` |
| Active speaker | `js/active-speaker.js` |
| Audio activity meters | `js/audio-activity.js` |
| Program audio bus | `js/program-audio.js` |
| Program audio mixer | `js/program-audio-mixer.js` |
| Soundboard | `js/soundboard.js` → ProgramController PLAY_AUDIO |
| Master recording | `js/master-recorder.js` + existing `js/program-recording.js` |
| TranscriptEvent | `js/transcript-event.js` + `js/transcription.js` + `js/show-context.js` |
| Hottie loop | `js/hottie-show-runner.js` + `js/live-producer.js` + `js/production-controller.js` |
| Audience | `js/audience-message.js` + `js/audience.js` |
| Artifacts | `js/session-artifact.js` |
| Focus group attach | `js/focus-group-studio.js` + `js/focus-group.js` |
| Destinations | `js/program-destination.js` |
| Timeline | `js/production-timeline.js` |
| Diagnostics | `js/media-diagnostics.js` (dynamic import only) |
| BUILD_ID | `js/build-info.js` |

## 10. Required real-device acceptance (human only)

Topology: Mac Host + phone Guest + second-browser Program Output.

BASELINE
1. Host + Guest cameras appear on Program Output.
2. Existing duo remains pristine.

CROSS-DEVICE SCREEN SHARE
3. Host shares a window/tab via Toasty Share.
4. Program Output on the other device receives it (no opener).
5. Host camera remains alive.
6–8. Screen Full / Screen + Speaker / Screen + Strip.
9. Stop via Toasty → duo restores, no black tile.
10. Share again.
11. Stop via browser-native Stop sharing → duo restores again.

ACTIVE SPEAKER
12. Balanced → equal tiles.
13. Active Speaker mode.
14. Host speaks several seconds → Host dominant.
15. Guest speaks several seconds → Guest dominant.
16. Brief interruptions do not thrash.
17. Spotlight Guest, Host speaks, Guest stays Spotlight; clear Spotlight resumes Active Speaker.

DIAGNOSTICS (`?debugMedia=1`)
18. Per-participant video health + audioLevel + speaking.
19. Share source id + honest PLAYING/binding/failed.
20. No raw audio.

Only after this: `VISUAL PRODUCTION BASELINE = FROZEN`.

## 11. Recommended repair order for Codex/Claude

1. Real-device Host screen share on a second machine (P1). If PO is black, inspect screen push id in presence vs VDO guest list vs `mountParticipantView`.
2. Confirm Guest activity ids match composition participantIds (P2).
3. If Guest VDO audio fails, stop keeping parent audio tracks; keep VDO-level path only.
4. Wire Hottie proposal buttons to `ProgramController.execute` without DOM mutation (P7).
5. Attach focus-group demo page to `attachFocusGroupToSession` (P10).
6. Persist SessionArtifact + ProductionTimeline on the presence/session backend (P9/P12).
7. Do **not** start Program Audio mixing of VDO tracks in-browser. Next real mixer is server-side (FFmpeg/GStreamer) or a first-party SFU.
8. Do **not** start multi-vendor chat adapters until TOASTY chat is on the presence plane.
9. Do **not** synthesize Cholo Whistle.
10. Do **not** merge or deploy from this agent.

## 12. Master acceptance ledger

| Ultimate Studio requirement | Status |
|---|---|
| professional Program Output | PROTECTED baseline; do not regress |
| Preview = Output | still `composeProgram` + `compositionOptionsFromState` |
| 1/2/3/4+ layouts | frozen |
| broadcast lower thirds | frozen from #25 |
| branding / environmental motifs | frozen from #25 |
| screen share | WIRED cross-device; NEEDS REAL DEVICE TEST |
| Spotlight | WIRED; clear restores mode |
| Active Speaker | WIRED with real meters; NEEDS REAL DEVICE TEST |
| real multi-participant audio | MIXER BUILT; remote VDO BLOCKED in-browser |
| Soundboard in Program Audio | WIRED via bus/mixer |
| master recording | V2 abstraction + tab-capture fallback |
| real multi-speaker STT | EVENT MODEL + guest uplink; Web Speech constraint |
| Hottie conversation awareness | EXISTING + show-runner proposals |
| research / TAKE LIVE | frozen from #25 |
| audience chat | MODEL BUILT; TOASTY wired; vendors scaffolded |
| Hottie public participation | identity enforced; POST_CHAT requires approval |
| production timeline | MODEL + partial wiring |
| recording / post / focus-group artifacts | SCHEMA BUILT; workers not built |
| customer brand lock | untouched |

IMPLEMENTED (architecture). AUTOMATED TESTED (this PR's suites). MERGED: NO. DEPLOYED: NO. REAL-DEVICE VERIFIED: NO.
