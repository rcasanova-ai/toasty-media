# Live-device Studio test (the one step automation cannot do)

Automated tests cover room/session creation, consent, attendance events, recording registration, transcript upload, Breadcrumbs and receipt updates. They **cannot** open a real camera or microphone, so this is the human check. Needs two devices (or one device and one phone), Chrome, and a camera/mic. About 10 minutes.

1. Run the real-services path ([`JUDGE_WALKTHROUGH.md`](JUDGE_WALKTHROUGH.md)) up to step 8 (Jam booked, guest consent saved). Use production (`https://toasty.media/peeps/app/`, invited account) or the local sandbox.
2. **Requester device:** on the Peeps app request page click **3 · Join Jam →**. The Studio director opens for the booked session. Allow camera/microphone. Confirm you see yourself.
3. **Guest device:** open the guest link, click **Join the session**. In the Jam Lobby allow camera/microphone, tick the consent box, click **Join Jam**, then **Join** in the room. Confirm both people see and hear each other.
4. **Expected evidence (check, don't assume):** on the requester's Peeps app request page (reload) the receipt shows **Participant attended: From participant join events** done. This event is sent by the room when the guest joins.
5. **Recording:** in the Studio director start recording (the host's recording), talk for 30-60 seconds, then stop. Studio shows "Preparing MP4…". Expected: the receipt's *Outcome verified* check turns ✓ DONE and *Evidence & Breadcrumbs* says "Recording: reference on file" with no manual step. If it doesn't, the Studio session id in the recording manifest didn't match the Jam: note the session id.
6. **Transcript:** paste what was said as `Speaker: text` lines (guest's lines must start with the guest's exact name as shown on the receipt), click **Complete Jam & generate Breadcrumbs**. Expected: Breadcrumbs quoting the guest. (Transcription is not automatic: Studio stores no transcript and a mixed recording has no speaker separation.)
7. Record pass/fail for: both-way audio/video, attendance event, recording registered, Breadcrumbs. Anything failing: capture the browser console and the Jam id.

Do not claim steps 2-5 work until a person has run them.
