# Studio audio pipeline

What happens to a voice between the microphone and the downloaded MP4, where it was being degraded, what was changed, how to
measure it, and what is still unverified. Everything here was measured with real Chrome and real files unless it says otherwise.

## 1. The path, and every place the audio is touched

```
SOLO (no guests)                                      WITH GUESTS
────────────────────────────────────────────          ───────────────────────────────────────────────────────────
mic ─ getUserMedia (Toasty: mono 48 kHz,              guest mic ─ getUserMedia INSIDE the vdo.ninja iframe
      echo cancel + noise suppression, no AGC)               (VDO's own constraints, NOT Toasty's)
  │                                                          │  Opus 256 kbps, WebRTC, peer to peer
  ├─ meters / activity / live transcript                     ▼
  ▼                                                   Program Output tab: one VDO frame per participant
stable mic track (Web Audio, gain 1, mono)                      │  browser mixes them (plain sum, no limiter)
  │                                                          ▼
canvas capture stream (video + that track)            getDisplayMedia tab capture ─ safety limiter (-2 dBFS, display capture only)
  ▼                                                          ▼
MediaRecorder  H.264 + AAC 160 kbps → MP4  ───────────── MediaRecorder  H.264 + AAC 160 kbps → MP4
  ▼                                                          ▼
IndexedDB (checkpoint slices every ~10 s) → final file → Download / Library
                    optional: Download Enhanced Audio (WAV, local)   ·   scripts/audio-enhance.mjs (MP4, local)
WebM-only browsers: optional server conversion (libx264 + AAC 160k) — never used when the browser records MP4 itself
```

Processing points: (1) the browser's own echo cancellation / noise suppression at the microphone, (2) the Opus encode for
WebRTC, (3) the decode and the browser's mix at Program Output, (4) the AAC encode in MediaRecorder, (5) optional server
transcode. Toasty adds no EQ, compressor or gain stage anywhere; the only DSP Toasty owns is the transparent safety limiter on
the Program Output capture (§3) and the optional enhancement (§5), which writes a separate file.

## 2. Root causes found

| # | Finding | Evidence |
|---|---|---|
| 1 | **VDO's `proaudio=1` turned echo cancellation, noise suppression and AGC off inside the iframe that actually captures and publishes guest and host voices.** Toasty's "clean mic" settings only ever applied to its own preview, never to the voice that is published and recorded. The same URL published 44.1 kHz stereo from a mono mic. | VDO `main.js`: `stereo` 1/3/4/5 sets all three flags false. Measured by reading `track.getSettings()` inside the VDO frame (`scripts/audio-vdo-transport-test.mjs`): old URL `echoCancellation=false noiseSuppression=false channels=2 rate=44100`. |
| 2 | **Guests on speakers get no echo cancellation** (consequence of 1). Cannot be reproduced without a real speaker and room, see §8. | Follows from the settings above. |
| 3 | **The Host's guest list was always empty on the current VDO.Ninja build**, so no guest ever got a seat: the hidden director frame was mounted with a blank `&view`, which VDO documents as "request no streams to watch". | Reproduced with VDO alone and inside Studio: director with `view=` sees 0 peers; without it, 1. Fixed with `novideo=1&noaudio=1` (joins every peer, negotiates no media: 0 inbound bytes measured). |
| 4 | **The guest's live microphone switcher selected the wrong device** (and threw for the first one): VDO's `changeAudioDevice` takes a 1-based position among audio inputs, the code passed a 0-based index into the all-kinds list. | Probed against vdo.ninja: positions 1..3 map to devices 0..2. |
| 5 | **The Host could not change microphone after joining, and a microphone that disappeared mid-recording silently recorded silence** (the recorder was fed a clone of the one mic track). | Code path; reproduced by the scenario test. |
| 6 | **Two loud talkers can clip the recording.** Program Output's mix is a plain sum, and nothing sat in front of the AAC encoder. | Real speech from two Chrome processes through VDO: each arrives at about -3 dBFS, the sum reaches +0.6 dBFS and clips. Controlled test (sum 1.4x full scale): 102,226 clipped samples unguarded, 0 guarded. |

Checked and **not** a problem: the MediaRecorder AAC encode (loudness within 0.2 LU of its input, waveform correlation to the input
unchanged), WebRTC loopback quality (0 % loss, 2 ms jitter, 0 % concealment), going offline for 6 s mid-recording (local
recording is unaffected), recording length against the wall clock, audio/video start offset in the container (0 ms).

## 3. What changed

* `js/video-engine.js`: publishers (Host and Guest) now pass `aec` / `denoise` / `autogain` explicitly, applied after `proaudio`,
  so the person's chosen processing is what is published (default: echo cancellation on, noise suppression on, AGC off). Director
  control frame fixed (#3). `vdoAudioInputPosition()` fixes the device switch (#4). Exports `buildVdoUrl()` so tests build the
  exact URL a frame loads.
* `js/microphone-capture.js`: configurable processing presets (**Speakers**: echo cancel + noise suppression; **Headphones**:
  noise suppression only; **Studio mic**: none), stored per browser. Echo cancellation is never disabled by default.
* `js/mic-setup-panel.js`, `js/host-mic-panel.js`: microphone selection and a live input-level meter with a clipping warning, in the
  Host pre-join card, the Guest check-in, and a **Mic setup** popover inside the Studio.
* `js/stable-mic-track.js`, `js/program-canvas-capture.js`, `js/live-session.js`: the recorded microphone is one stable Web Audio
  track, so the Host can switch microphone during a take, and a lost microphone is replaced by the default one, without the recorder
  restarting. `LiveSession.switchHostMicrophone()` also moves the published (VDO) microphone.
* `js/streaming-limiter.js`, `js/limiter-worklet.js`, `js/capture-audio-guard.js`, `js/program-recording.js`: a transparent look-ahead
  peak limiter (ceiling -2 dBFS, 5 ms look-ahead, 80 ms release) in front of the encoder for the Program Output tab capture only.
  Untouched audio below the ceiling passes bit-for-bit. **Fails open** in every case (worklet blocked, context suspended, audio thread
  not processing, no Web Audio): the raw capture is recorded. Switch off with `localStorage["toasty.recording.limiter"] = "off"`.
  The recording manifest reports what it did (`audioProcessing`).
* `js/audio-enhance.js`, `js/audio-enhance-export.js`, `scripts/audio-enhance.mjs`: optional enhancement (§5).
* `js/recording.js`: the isolated source tape uses an explicit 160 kbps Opus rate.
* `js/audio-analysis.js`: the measurement code (§4).

## 4. Measuring a recording

```bash
node scripts/audio-analyze.mjs recording.mp4                       # codec, rate, channels, bitrate, peak, clipping, LUFS, range, dropouts, A/V offsets
node scripts/audio-analyze.mjs --verify-loudness recording.mp4     # cross-checks LUFS against ffmpeg's own EBU R128 meter
node scripts/audio-analyze.mjs --stages "raw=raw.wav" "recorded=take.mp4" "exported=final.mp4"   # where did quality change?
```

`--stages` lists findings per stage (clipping, dropouts, loudness shift, peak rise, resampling, channel change) and the delay, gain,
waveform correlation and signal-to-error against the first stage. Loudness agrees with ffmpeg `ebur128` to 0.04 LU. In-page, the same
code (`js/audio-analysis.js`) summarises WebRTC stats (loss, jitter, concealment: `summarizeRtcAudioStats`) and recorder slice gaps.

Real-browser tests (Chrome, a known programme played in as the microphone, recorded by the real Studio):

| Script | What it measures |
|---|---|
| `audio-pipeline-browser-test.mjs` | mic with processing off, Toasty default, the finished MP4, then enhancement: levels, clipping, dropouts, loudness, A/V start, length, constraints Chrome really applied |
| `audio-scenarios-browser-test.mjs` | one take with 6 s offline, two microphone switches, a lost microphone; gaps measured in the file |
| `audio-av-sync-browser-test.mjs` | flash + beep from one clock through the real canvas capture and MediaRecorder; offset in ms |
| `audio-limiter-browser-test.mjs` | the safety limiter: clipping prevented, normal audio untouched, sync cost, fail-open |
| `audio-vdo-transport-test.mjs` | the real VDO publisher and viewer: published constraints, received audio, WebRTC stats (needs internet) |
| `audio-multiparty-browser-test.mjs` | Host and Guest in two Chrome processes: published settings, what Program Output receives, the program mix (needs internet) |

Run with `PLAYWRIGHT_CORE=/path/to/playwright-core/index.mjs HEADLESS=1 node scripts/<name>.mjs`, and `AUDIO_PROGRAMME=speech.wav` to use real
speech instead of the built-in synthetic programme. `.github/workflows/audio-quality.yml` runs them on pull requests.

## 5. Enhancement (optional, never replaces the original)

Chain: 80 Hz high-pass, optional gentle noise reduction (soft expander, depth capped at 15 dB), 2:1 compressor with a soft knee, one
constant gain to -16 LUFS (boost capped at +12 dB so a very quiet room is not amplified into hiss), look-ahead limiter, and for
exports a true-peak check that re-renders with more headroom if the encoded file would exceed -1 dBTP. No spectral subtraction.

* In the Studio, **Advanced > Download Enhanced Audio** makes a separate 16-bit WAV in the browser (nothing uploaded; recordings over
  45 minutes or 350 MB are refused with a message).
* `node scripts/audio-enhance.mjs recording.mp4` writes `recording-enhanced.mp4` for any length: the video stream is copied, only the
  audio is re-encoded, the input is never modified.

## 6. Measured results

Real speech (synthesised voices) plus room noise, Chrome with a fake microphone playing the programme, loopback WebRTC. "Before" is the previous production URL.

| | Before | After |
|---|---|---|
| Guest published track (read inside VDO) | echo cancel off, noise suppression off, **2 ch, 44.1 kHz** | echo cancel on, noise suppression on, AGC off, **1 ch, 48 kHz** |
| Received noise floor (quietest 10 % of 50 ms windows) | -53 dBFS (same as the source: no suppression) | **-73 dBFS** |
| Speech-to-noise gap | 38 dB | **58 dB** |
| Speech level | -15 dBFS | -15 dBFS (unchanged) |
| Synthetic programme, same test | -53 dBFS, 31 dB | -72 dBFS, 49 dB |
| Loud two-talker mix, clipped samples | 102,226 | **0** |
| Loud two-talker mix, decoded peak | +2.65 dBFS | **-1.9 dBFS** |
| Normal-level audio through the guard | | loudness -11.81 LUFS both with and without the guard; limiter never acted |
| Solo Studio recording vs the microphone it recorded | | -18.09 to -17.89 LUFS, peak -2.95 to -2.98 dBFS, 0 clipped, 0 dropouts, AAC 157 kbps mono 48 kHz |
| Recording length | | 38.30 s of 38 s; A/V start offset 0 ms |
| Host guest detection | 0 guests seen | guest seen |
| Optional enhancement of that recording | -17.89 LUFS, range 21.3 LU, std dev 7.1 LU | **-16.01 LUFS, range 14.6 LU, std dev 5.0 LU**, true peak -1.0 dBTP, original untouched |
| Take with 6 s offline, 2 mic switches, 1 lost mic | | one continuous 40.0 s file, longest digital silence 24 ms, 0 clipped |
| 10-minute take | | one 600.2 s file, 0 clipped, 0 dropouts, -18.01 LUFS over the whole take (-18.14 at the start), audio and video the same length, A/V start offset 0 ms |
| A/V sync, canvas path, audio minus video | -26 to -39 ms (audio early, previous direct mic clone) | **+10 ms** (stable track) |
| Guard hop, A/V | | adds about 5 to 60 ms of audio delay between runs (median under 15 ms) |

Chrome's own echo cancellation and noise suppression change the waveform (correlation to the raw mic about 0.5 on speech) while
leaving loudness within 0.3 LU. That is processing working as intended, and why it is configurable.

## 7. Scenarios tested

| Scenario | Status |
|---|---|
| Solo recording | Tested, synthetic and real speech |
| Two-person conversation | Tested through real VDO.Ninja between two Chrome processes: published settings, received audio, WebRTC stats, program mix. **Tab-capture audio not testable headless** (below) |
| Multiple guests (3) | **Not tested** (one guest) |
| Participants speaking simultaneously | Measured on the summed received streams and with the limiter test (sum 1.4x full scale) |
| Laughter and sudden spikes | A full-band noise burst 4 dB below full scale is in the programme; limiter and enhancement tested on bursts |
| Quiet speaker | A -40 dBFS voice in the programme; enhancement boost cap tested |
| Microphone switching | Tested mid-recording, twice, plus a lost microphone (simulated with an `ended` event) |
| Network interruptions | Offline for 6 s mid-recording: local recording unaffected. **Packet loss was not simulated** |
| Long recordings | A 10-minute take measured (drift, dropouts, loudness). Hour-long takes not tested |
| Final MP4 conversion | Browser-encoded MP4 measured (the default path). The server WebM-to-MP4 job (WebM-only browsers) also measured: -18.12 to -17.72 LUFS, same peak, 0 dropouts, A/V start 0 ms, 40.37 s of 40 s, AAC 163 kbps |

## 8. Remaining limitations

* **No human listening test was done.** Everything above is measurement. Do not read "no clipping, correct level, low noise" as
  "sounds professional"; give a real recording a listen.
* **Tab-capture audio cannot be verified headless.** Chrome's fake-device mode replaces display-capture audio with a fake microphone, so
  the audio of a recording made with guests (Program Output tab capture) was not measured end to end. The safety limiter is tested on
  the same stream shape through the real MediaRecorder, but the first real desktop session with a guest should be recorded and run
  through `scripts/audio-analyze.mjs`.
* Echo cancellation against real speakers and rooms, real USB or Bluetooth microphones, and Safari or Firefox were not tested.
* The guard adds a few milliseconds to a few tens of milliseconds of audio delay to the Program Output recording (§6). It is within
  broadcast tolerance, but can be switched off.
* Packet loss and long outages on the guest side are not simulated; WebRTC stats are collected on loopback only.
* The Studio can enhance audio to a WAV; an enhanced MP4 is produced by the command-line tool, not a button.
* Webcam hardware latency (often 50 to 150 ms) is upstream of anything measurable here.
