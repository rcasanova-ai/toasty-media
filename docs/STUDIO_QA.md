# Toasty Studio Manual QA

Use a disposable room generated from `studio/director.html`. Do not deploy production for QA.

## Chrome Host And Chrome Guest

- Open director page in Chrome.
- Copy guest invite.
- Open guest invite in a separate Chrome profile, incognito window, or second device.
- Confirm both sides can see and hear each other.
- Confirm host mute/unmute changes host audio.
- Confirm host camera on/off changes host video.
- Confirm guest mute/unmute changes guest audio.
- Confirm guest camera on/off changes guest video.
- Confirm screen share start/stop from host.
- Confirm screen share start/stop from guest.
- Confirm end session/leave disconnects the relevant iframe.

## Chrome Host And Safari Guest

- Repeat the join flow with host in Chrome and guest in Safari if practical.
- Confirm camera and microphone prompts appear.
- Confirm blur/background behavior separately, since Safari support can differ.
- Confirm recording support. If unsupported, verify the UI reports unsupported browser capability.

## Same-Machine Separate-Browser Test

- Use Chrome for host and Safari or another Chrome profile for guest.
- Use headphones to avoid acoustic echo.
- Confirm both browsers can access camera/microphone. Some devices may allow only one camera owner at a time.
- Confirm recording start behavior on both sides.

## Separate-Device Test

- Host on desktop Chrome.
- Guest on a laptop or phone using the copied invite.
- Confirm audio and video both ways.
- Confirm guest disconnect is reflected on host status where VDO.Ninja sends the event.
- Rejoin the guest URL and confirm the room recovers.

## Backgrounds

- Before joining, choose no background and confirm preview is normal.
- Choose blur and confirm preview changes locally; join and confirm VDO.Ninja blur is requested.
- Choose each Toasty preset and confirm preview changes locally.
- Confirm preset replacement is treated as preview-only in this hosted VDO.Ninja MVP.

## Soundboard

- Play intro, outro, stinger, applause, and custom placeholder.
- Move master volume and confirm local cue volume changes.
- Confirm cues are local host audio only and are not injected into the live VDO.Ninja mix in this phase.

## Recording

- In Chrome, click Start recording on host.
- Grant camera and microphone permissions.
- Confirm recording timer starts only after recording starts.
- Click Stop recording.
- If prompted for a folder, choose a test folder and confirm files are written:

```text
session/
  session.json
  host/
    audio.webm
    video.webm
```

- Repeat on guest and confirm:

```text
session/
  session.json
  guest-1/
    audio.webm
    video.webm
```

- In browsers without File System Access API, confirm fallback downloads occur.

## Failure States

- Deny camera permission and confirm the guest setup reports a permission failure.
- Deny microphone permission and confirm the guest setup reports a permission failure.
- Start recording in an unsupported browser and confirm unsupported capability messaging.
- Unplug or disable a camera/microphone and confirm recording start failure is reported.
- Close the guest tab and confirm the host receives a disconnect status when VDO.Ninja emits it.
- Click End session/Leave and confirm the iframe closes or disconnects.
