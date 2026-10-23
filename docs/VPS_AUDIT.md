# What the server does for Studio, and what no longer needs it

Read from the repository (`docs/DEPLOYMENT.md`, `scripts/nginx-render.conf.example`, `scripts/render-production-server.mjs`,
`scripts/toasty-broadcast.service`, `docs/RECORDING_AND_COSTS.md`). The production host itself (CPU, RAM, provider plan, what else
runs on it) is not in the repository and was not inspected, so nothing below says what it costs. Costs measured per action are in
`RECORDING_AND_COSTS.md`.

## The machines

| Host | What runs | Source |
|---|---|---|
| `toasty.media` (LiteSpeed, static) | The Studio pages, `js/`, `css/`. Deployed by `deploy-production.yml`. No video work. | DEPLOYMENT.md |
| `render.toasty.media` (nginx to Node on 127.0.0.1:4174) | `scripts/render-production-server.mjs` + `scripts/toasty-auth-db.py` (SQLite). Explicit nginx path allowlist. | DEPLOYMENT.md, nginx-render.conf.example |
| RTMP broadcast unit | `scripts/broadcast-server.mjs` (systemd `toasty-broadcast`, `/opt/toasty-media`). Go Live to X and others. | toasty-broadcast.service |
| VDO.Ninja (third party) | Signalling, TURN and the WebRTC transport for guests. No Toasty media server exists. | RECORDING_AND_COSTS.md |

## What the render host serves, and whether Studio needs it

| Route group | What it does | Needed for | Could it run locally? |
|---|---|---|---|
| `/auth/*`, `/api/sessions*`, `/api/organizations*`, `/api/invites/*`, billing, `/webhooks/stripe` | Accounts, sessions, plans, invites, payments | Sign-in, the session list, guest invite validity, limits | No. Identity and payments are server problems |
| `/api/presence/*` | Heartbeats: who is in the room, names, mute state, transcript events from guests | **Guest detection and names**, active speaker, program state between devices | Not without another signalling path. It is the dominant measured cost (about 7 CPU-s per participant-minute) |
| `/api/recordings/jobs`, `/limits`, `/finalize` | **Server WebM to MP4 conversion** (`libx264 veryfast`, AAC 160k) | Only browsers that cannot record MP4 themselves (Firefox). Chrome, Edge and Safari record H.264/AAC MP4 directly and never call it | See below |
| `/api/transcribe` | whisper.cpp on short push-to-talk clips for Moxie | Talk to Moxie by voice when the browser's speech recognition is not enough | Yes for batch work: see "Moved off the server" |
| Peeps / Jams / dubs / campaign routes | The Peeps product | Peeps, not Studio | n/a |
| `/render` | ffmpeg render endpoint (`FFMPEG_TIMEOUT_MS` 120 s) for the creator tools | Legacy Creator rendering | Replaced for clips by the local renderer (below) |
| Broadcast service | libx264 encode of Program for RTMP, `-c copy` relays | Go Live to external platforms only | No. A browser cannot push RTMP |

## Moved off the server in this change

* **Clip rendering, templates, music, ducking, enhancement, transitions, vertical and square export: 100 % in the browser**
  (`js/clip-renderer.js`). No upload, no `/render`, no ffmpeg, no queue. The only network use is the public CDN download of the
  optional transcription model (below), and only when the user presses the button.
* **Transcription of uploads and recordings for clip finding: in the browser**, with an open Whisper model
  (`js/clip-transcribe.js`). First use downloads about 40 MB, then it runs on the user's CPU: 34 s of speech took 3.5 s. The
  recording is never sent anywhere. Studio recordings already carry their live transcript, so most clips need no transcription.
* **Clip detection (laughter, silence, reactions, opinions, banter, "Moxie, clip that"): in the browser**, live and in batch.
  No Moxie API key, no server call.
* Earlier in this work: audio enhancement as a download and the loudness and clipping measurement are local too.

## Still on the server, and why

1. **WebM to MP4 conversion** serves WebM-only browsers (Firefox). Removing it needs a verified in-browser converter
   (ffmpeg.wasm or a WebCodecs muxer) that survives hour-long files in a tab; neither was built or tested, so the endpoint stays.
   It is already optional, size-capped, one job at a time, and never used for Chrome, Edge or Safari recordings.
2. **Presence** is how a Host learns a guest exists and who they are. VDO.Ninja's own guest list is a second source
   (the director frame fixed in PR 234), but names, roles and mute acknowledgements come from presence.
3. **Accounts, sessions, limits, invites, payments** are inherently server side.
4. **Go Live (RTMP)** is the only feature that needs a server-side video encode.

## Is the VPS needed at all?

For recording, downloading, clip finding, clip styling and clip export: **no**, those run in the browser against IndexedDB. For
signing in, inviting guests, the presence roster, optional WebM conversion and Go Live: **yes**. It cannot be turned off today, and
nothing here was removed from it: removing infrastructure before an equivalent is verified is exactly what this audit avoids.

## Ongoing costs that remain

The render host and its bandwidth (per-guest presence polling is the largest measured driver), the broadcast host while anyone is
live (about one core per active broadcast at 1080p), VDO.Ninja's free public service (a dependency, not a cost: its availability is
outside Toasty's control), and the customer's own AI key for Moxie. No paid video, music or transcription service is used by clips.
