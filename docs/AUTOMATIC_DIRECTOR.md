# Automatic Director (Make My Video)

Moxie is the editor. The user is the director. On the Toasty Clips page (`studio/clips.html`), **Make My Video** takes a recording,
a style and an optional plain-English instruction and produces a finished, measured video. No timeline, no keyframes, no
captions to sync by hand. Everything runs in the browser on the user's computer; the video is never uploaded, there is no paid
API, no generative video and no third-party editing platform.

## Flow

```
1 Recording  ->  2 Style (+ format)  ->  3 Instruction (optional)  ->  4 Make My Video  ->  5 Preview  ->  6 Export
                                                                           ^                    |
                                                                           +---- "Less zooming" +  (revisions)
```

Manual Clips (trim, templates, per-clip styling, batch export) is unchanged and sits underneath as optional tools.

## What it reuses (nothing is duplicated)

| Existing piece | Used for |
|---|---|
| `js/behavior/engine.js` (`analyzeRecording`) | transcript, ranked moments, vocal emphasis events, face/pose/motion, speaker turns |
| `js/clip-detector.js` `scoreLine` | value of a stretch of speech when the engine has no unit score |
| `js/clip-instructions.js` | titles, lower thirds and the output format in plain English |
| `js/clip-renderer.js` | the capture machinery: `loadVideo`, `pickRenderMime`, the background-safe ticker, MediaRecorder MP4/WebM |
| `js/clip-mixer.js` + `clip-mixer-worklet.js` | voice leveling, gentle compression, peak limiter, music ducking (a third input was added for sound accents) |
| `js/clip-loudness.js`, `js/loudness-plan.js` | measure the source, find the gain for -16 LUFS, measure the exported file, correct once if off |
| `js/clip-music.js` | the synthesized music beds (upbeat, chill, cinematic) |
| `js/clip-draw.js` | the intro and end cards, `roundRect`, `wrapLines`, fonts |
| `js/clips-app.js` | the source, the analysis and the options (exposed to the new panel as `window.__toastyClipsApi`) |

Additions to existing files are small and additive: `ClipMixer.process()` takes an optional `fx` bus, the worklet reads a third input,
the renderer exports `makeTicker`/`once`, the draw module exports its helpers, `analyzeRecording()` also returns `picture`
(face positions per sample, no landmarks) and `clips-app.js` exposes a handle and an awaitable analysis.

## The engine (`js/director/`, no UI)

```
speech.js       where the voice is (adaptive voice activity detection on the decoded audio)
words.js        transcript words timed over the voiced stretches of each line
emphasis.js     which words deserve emphasis, key phrases, figures ("73%"), spoken steps ("first, second, third")
framing.js      who to frame (the face whose mouth moves while the voice is active), crop windows, zoom limits that never cut a face
styles.js       the three styles as data, and the revision knobs
plan.js         the planner: recording + analysis + style -> one JSON edit plan, with a decision log
revise.js       plain English -> changes to the settings (supported list, honest "cannot do")
broll.js        optional B-roll from the user's own files, only where a spoken word matches a tag
frame-state.js  (plan, time) -> what is on screen; pure, deterministic
sfx.js          synthesized sound accents (whoosh, impact, boom, pop, tick, swell)
draw.js         paints a frame state: video crop, grade, transitions, kinetic type, callouts, arrows, diagrams, lower thirds, accents
render.js       executes a plan: two-player shot switching, mixer, MediaRecorder, loudness verification
index.js        openSession / makeEdit / reviseEdit / renderEdit
```

`js/make-video.js` + `css/make-video.css` are the page. `js/director/` imports nothing from the page.

## The edit plan

`buildPlan()` is pure and seeded: the same inputs give the identical plan (a test asserts byte equality). The plan is one JSON
object (`schema: "toasty.director.plan/1"`, downloadable from the page) holding:

- `segments`: source range, output range, why the cut is there (`gap`, `turn`, `reframe`, `topic`), the camera (scale, focus, drift, punch-ins) and the speaker
- `cuts`: per cut, `hard` or a transition (`fade`, `dissolve`, `wipe`, `push`, `flash`) with duration and reason
- `words` (output time, with emphasis score and reasons), `captions` (chunks), `typography` (key phrases, word by word on the spoken timing), `graphics` (lower third, stat callout + arrow, step diagram, corner accents, brand bug), `broll`
- `intro`, `outro`, `audio` (-16 LUFS target, music bed, ducking, sound accents with times and levels), `look` (grade, theme)
- `decisions`: every choice with the rule that made it and the evidence (timestamps, scores, event types)
- `skipped`: effects that were not placed and why (density, minimum gap)
- `stats`, `warnings`

`render.js` executes exactly this plan. There is no second description of the edit.

## What Moxie decides, from what evidence

| Decision | Evidence and rule |
|---|---|
| Which parts to use | ranked moments (transcript meaning, vocal, picture, interaction) when the recording is much longer than the target; otherwise the whole recording, tightened |
| Dead air | pauses longer than the style's threshold are cut down to a short beat; a visible reaction (smile, brow raise, laughter) inside a pause is held instead |
| Cuts | at speaker turns and, in long shots, at sentence starts; jump cuts alternate the scale so they read as deliberate |
| Beat-aware cuts | in High Energy and Cinematic, jump cuts move within the silence around them to land on the music's beat (reported as "x of y aligned") |
| Emphasis | rare words, numbers, absolutes, contrast, negation, proper nouns, significance of the sentence, and the voice itself (intensity rise, pitch jump, slowing) |
| Punch-in zoom | on the strongest emphasized words and visible reactions; smooth; capped so a face is never cut off |
| Key phrase | the most significant sentence of a stretch, each word appearing as it is spoken |
| Statistics callout | only numbers actually in the transcript, quoted verbatim |
| Framing | the face whose mouth moves while the voice is active; with two faces and no clear speaker the frame stays between them, or follows one with a stated low confidence |
| Transitions | at jumps in the story and after long removed pauses; most cuts stay hard |
| Sound accents | on transitions, strong emphasis and callouts; moved off spoken words or lowered under speech |
| Lower third | only a name that is in the recording's own speaker labels, or one the user typed |

Moxie never claims to know what anyone felt. It reports events ("smile at 0:41, strength 0.7"), not emotions, and it does not
identify people.

### Effect density limits

Every effect goes through one budget per style: effects per ten seconds, a minimum gap between prominent effects, a cap on the share
of the video that is zoomed, and a cap on simultaneous effects. What does not fit is skipped and logged.

| | Clean Professional | High Energy | Cinematic |
|---|---|---|---|
| default length | 75 s | 45 s | 60 s |
| pauses cut when longer than | 0.75 s (to 0.34 s) | 0.32 s (to 0.12 s) | 1.2 s (to 0.62 s) |
| longest shot | 16 s | 5.2 s | 24 s |
| zoom share of the video / min gap | 20% / 9 s | 45% / 2.6 s | 30% / 12 s |
| effects per 10 s (limit) | 1.6 | 4.2 | 1.3 |
| captions | phrase bar, accent underline on emphasized words | 1-3 uppercase words, pop, accent colour | one serif line, italic emphasis |
| key phrase | label card | slide-in on a highlight bar | pull quote |
| transitions | fade | wipe, push, flash | dissolve |
| graphics | lower third, stat card, step diagram | + arrows, corner accents | lower third, letterbox |
| music / accents | chill, minimal | upbeat, full | cinematic, sparse |
| grade | warm lift, light vignette | warm, saturated | warm, desaturated, strong vignette, letterbox |

## Revisions

`revise.js` is a list of supported instructions, not a language model. Every instruction is answered with what changed or with a plain
statement that it cannot be done. Supported: less/more zooming, no zoom, bigger/smaller/no captions, remove/add music, quieter/louder
music, sound effects on/off, faster/slower, remove pauses, fewer/more/no transitions, simpler/calmer, start with the strongest
statement (moved to the front, not repeated), N seconds / N minutes, N clips, intro/outro on/off, Toasty branding (logo sting, corner logo,
end card), no graphics, no animated text, B-roll on/off, title and lower third text, style words (cinematic, punchy, professional)
and format (vertical, square, landscape), "subtle".

Not supported, and said so: filters, stickers and GIFs, background removal, slow motion, voice-overs and dubbing, removing individual
filler words (transcript timing is per sentence, so a cut inside a word would be a guess), retouching people, translated captions,
posting to other services, generated footage. An unrecognised instruction changes nothing and lists what can be asked.

A revision changes the settings and re-plans from the same analysis and seed, so only what was asked changes. Settings accumulate.

## Audio

Audio is a release requirement. The render uses the same chain as Toasty Clips and the measured-loudness fixes in #237:
80 Hz high-pass, noise expander only when a large boost is needed, a static gain found **before** rendering by running the real DSP
over the kept stretches of the voice, a slow speech leveler, gentle compression, true-peak limiter at -2.5 dBFS, music ducked 14 to 15
dB under the voice, sound accents ducked by half as much. The export is decoded and measured; if it is more than 1.5 LU from -16 LUFS or
peaks above -1 dBTP it is re-rendered once with the error corrected, and the page shows the measured values and any warning.

Silence handling is dead-air removal (above). Synchronization is preserved because audio and picture come from the same media element;
cuts that remove no time keep the same element playing, and shots that jump are prepared on the second element before they are needed.

Sound accents and music are synthesized in the browser (OfflineAudioContext). There is no sample library, so nothing to license.

## Performance and limits

- A render plays in real time (the browser's own encoder): a 60 s video takes about a minute plus the measurement. It is cancelable at any moment.
- The recording is decoded once (16 kHz mono) for voice detection and loudness; Whisper, the sentence-embedding model and the MediaPipe trackers are the
  same optional, once-downloaded models Analyze with Moxie already uses, behind the same checkbox. If they are unavailable the analysis degrades (and says so) and the edit still works.
- Per-frame cost is one canvas draw plus overlays; long recordings are handled by choosing moments first, so the render length is the output length.
- Only one render runs at a time.

## Tests

```
node scripts/director-plan-test.mjs                       # planner, styles, limits, framing, revisions, B-roll (no browser)
node scripts/director-browser-test.mjs                    # real Chrome: UI flow, then renders and measures all styles and formats
QUICK=1 node scripts/director-browser-test.mjs            # three renders instead of nine
```

The browser test needs `playwright-core`, Chrome, ffmpeg. With macOS `say` the fixture is spoken by real text-to-speech voices; elsewhere
a synthetic speech-like programme is used and the report says so. The picture is a flat two-person scene so overlays and crops can be
told from footage; the transcript and face tracker are deterministic stand-ins (no network), everything else runs for real. It verifies,
from the exported files: caption and key-phrase timing, crops and zooms against the plan's camera, speaker-following vertical crops,
transition rendering (blend, wipe edge, flash, never black), graphics, flash/beep sync, loudness and peak, speech intelligibility
under music, music beat grid, sound accent timing, B-roll placement, and that the three styles differ.
