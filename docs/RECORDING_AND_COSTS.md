# Studio recording architecture and cost drivers

## Local-first recording (what is on the producer's machine, what is on Toasty's servers)

| Step | Where it happens | Server involved? |
|---|---|---|
| Capture (camera + mic + presented screen, composed on a 16:9 canvas; or the Program Output tab when guests are on screen) | Producer's browser | No |
| Encode — `MediaRecorder`, **6 Mbps video / 160 kbps audio**, H.264/AAC **MP4 directly** where the browser supports it (Chrome/Edge 126+, Safari), otherwise WebM | Producer's browser | No |
| Chunks held as browser Blobs; a ~10 s checkpoint slice is written to IndexedDB (crash recovery) | Producer's browser | No |
| Stop → the recording **is** the finished file (MP4 path) and is stored once in IndexedDB | Producer's browser | No |
| Play / Download MP4 / Download source | Producer's browser (Blob URL) | No |
| Live transcript (Chrome `SpeechRecognition`) and transcript export (TXT/JSON) | Producer's browser | No |
| **Optional** server MP4 conversion — only for browsers that can only record WebM | Render host | Yes (upload, CPU, download) |

Local recording and download are **never** subject to plan upload/conversion caps. The only server limit on recordings is
the optional WebM→MP4 conversion (`GET /api/recordings/limits`), and the browser does not even attempt an upload the server
would refuse: the complete WebM stays on the device and is offered as the download.

## Where costs actually arise

Measured on an 11-core Apple-silicon Mac with worst-case (full-frame noise) 1280×720 content; typical talking-head content is
several times cheaper. Production host specs/bandwidth pricing are not in the repository and must be read from the host
(`nproc`, `free -m`, provider plan) before any pricing decision.

| Driver | Where | Measured / derived |
|---|---|---|
| **Presence heartbeat (guests, hosts, Program Output)** | `POST /api/presence/announce` every 2 s per participant; Program Output polls every 5 s. Each announce spawns the Python DB helper **4 times** (`session_get_by_room`, `get_organization`, `presence_upsert`, `session_touch`) | ~80 ms CPU per spawn; **232 ms per announce → ≈7 CPU-seconds per participant-minute** (a 3-person session + Program Output ≈ 21 s/min ≈ 35% of one core, continuously). This is the dominant per-guest infrastructure cost. |
| Server MP4 conversion (WebM fallback only) | `ffmpeg` libx264 veryfast, one at a time | ≈ 50 CPU-s per recorded minute worst case (≈ 21 s wall on 11 cores); upload = file size, download = MP4 size (6 Mbps ≈ 45 MB/min up, ≈ 55 MB/min down) |
| Go Live (external RTMP) | One libx264 encode of Program per broadcast; `-c copy` relay per destination | ≈ 66 CPU-s per live minute worst case at 1080p/6 Mbps (≈ 1 core per active broadcast); relays ≈ 0.1 CPU-s/min each; egress = 6 Mbps × destinations ≈ 2.7 GB/hour per destination |
| Push-to-talk to Moxie | `/api/transcribe` (whisper.cpp), ≤30 s clips, 1 at a time | small; CPU per utterance |
| Peeps automatic transcription of a finalized Jam recording | whisper.cpp on the converted MP4 | proportional to recording length (only for Jam sessions) |
| Moxie / AI | BYOK — the customer's API key | none to Toasty |
| Guest audio/video media | **VDO.Ninja** (hosted WebRTC; peer-to-peer, VDO's own signalling/TURN) | **No Toasty relay/media server exists.** Cost falls on host/guest upstream bandwidth (each guest stream is received by the host tab and by the Program Output tab), and on VDO.Ninja's free infrastructure. |
| Live transcription | Chrome `SpeechRecognition` in the browser | none to Toasty |
