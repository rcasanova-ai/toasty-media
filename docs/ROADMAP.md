# Toasty Media Roadmap

## Immediate Product Milestone: Hackathon Focus Group Demo

**Goal:** run a real 30-minute focus group for another hackathon team with **1 host + 5 participants**, from recruitment through finished research deliverables.

This milestone is the priority path because it proves the complete Toasty system: Peeps recruits the right humans, Studio runs the conversation, Hottie helps the moderator, Dubs compound participant context, Dough supports compensation, and post-production turns the session into useful research assets.

### Gate 1: Six-Person Live Session Reliability

Current Studio composition is capped at 4 total participants (1 host + 3 guests). Raise the product-supported target to **6 total participants: 1 host + 5 guests**.

Required:
- Expand guest seat and participant composition limits from 3 guests to 5 guests.
- Add deterministic layouts for 5 and 6 total participants.
- Ensure each participant can see the host and the other participants without hidden hard caps.
- Confirm all six participants can hear one another.
- Preserve stable participant ordering as people join, leave and reconnect.
- Keep host/producer guest controls functional for all five guests.
- Verify mobile + desktop combinations.
- Test reconnects, camera toggles, microphone toggles and guest removal.
- Verify Program Output handles 6-person sessions without silently dropping participants.
- Add explicit 6-person QA coverage to `docs/STUDIO_QA.md`.

**Exit criteria:** one host and five guests complete a 30-minute session on separate real devices with stable audio/video and no participant disappearing from the host or participant views.

### Gate 2: Focus Group Session Mode

Turn focus groups into a first-class Studio/Peeps workflow rather than a generic meeting.

Required:
- Carry the Peeps research brief and cohort definition into Studio.
- Display participant name plus only the approved context the moderator needs.
- Give the host a focus-group run-of-show: introduction, warm-up, core questions, probes, concept reactions, wrap-up.
- Support participant consent/capture policy before recording/transcription.
- Link the Studio session back to the Peeps Jam and cohort.
- Keep client-private research content isolated from reusable participant profile data.
- Allow participants to claim/enrich their Dub after the session.

**Exit criteria:** a host can open a recruited Peeps cohort directly in Studio and run the session without manually reconstructing the research brief or participant context.

### Gate 3: Hottie as a Real Focus Group Moderator Copilot

Hottie must become useful during a live group, not merely a command box.

Required:
- Feed Hottie the research objective, run-of-show and approved participant context before the session.
- Ingest live transcript with speaker identity.
- Detect unanswered research questions.
- Identify when multiple participants show the same confusion or reaction.
- Surface contradictions and minority opinions worth probing.
- Suggest follow-up questions privately to the host.
- Correct factual mistakes or participant background details privately.
- Track time and warn when the session is drifting.
- Flag participants who have not spoken enough.
- Let the host ask natural questions such as:
  - “What have we not covered?”
  - “Who disagreed with that?”
  - “What should I ask next?”
  - “Which concept is landing best?”
- Never expose private Hottie prompts to participants unless the host explicitly sends something to Program.

**Exit criteria:** during a real focus group, Hottie produces multiple relevant moderator prompts that materially improve the conversation without disrupting it.

### Gate 4: Reliable Capture and Recording

A focus group is useless if the evidence is incomplete.

Required:
- Record the complete session reliably.
- Capture speaker-attributed transcript.
- Preserve timestamps for every transcript segment.
- Store participant/session metadata alongside the recording.
- Decide and implement the reliable recording architecture for multi-person sessions rather than relying on the current host-only/local proof.
- Recover gracefully from a participant reconnect.
- Verify recording completeness before post-production starts.
- Store assets in the session/Jam structure.

**Exit criteria:** the entire six-person session can be replayed and every useful transcript statement can be traced to speaker + timestamp.

### Gate 5: Focus Group Intelligence Pack

The client should receive research output, not just a video file.

Required:
- Generate:
  - executive summary
  - top findings
  - major points of confusion
  - positive/negative reactions
  - recurring themes
  - minority/contrarian views
  - participant-by-participant observations where permitted
  - notable quotes
  - recommended product/message changes
  - unanswered questions
- Tie every important finding back to transcript evidence/timestamps.
- Clearly separate model interpretation from direct participant statements.
- Preserve the client's ownership/privacy boundary around research findings.

**Exit criteria:** the hackathon team can use the generated intelligence pack in its own product decisions and demo without manually reviewing the full recording.

### Gate 6: Consistent Post-Production Assets

The finished package should look produced, not improvised.

Required:
- Produce a branded full-session recording.
- Generate a clean audio export.
- Generate transcript + subtitle files.
- Generate 3–5 useful clips with correct speaker labels.
- Generate quote cards / still assets where appropriate.
- Apply the selected Toasty/white-label brand consistently.
- Keep intro, outro, lower thirds, typography and visual framing consistent across outputs.
- Generate a simple client delivery page/package containing recording, clips, transcript and intelligence pack.
- Make the same session produce the same asset structure every time.

**Exit criteria:** one action creates a complete, branded focus-group delivery package without hand-editing each individual asset.

### Gate 7: Hackathon Live Pilot

Run the actual proof with another hackathon team.

Target format:
- 1 external hackathon project.
- 1 clear research question.
- 5 recruited participants matching a defined cohort.
- 1 Toasty host/moderator.
- 30-minute session.
- Free for the pilot team.
- Real participants; no simulated feedback.

Pilot deliverables:
- Cohort brief.
- Participant consent records.
- Session recording.
- Transcript.
- Hottie moderator activity.
- Focus Group Intelligence Pack.
- Highlight clips.
- Participant payouts/compensation record if applicable.
- Claim-Dub invitation for each participant.
- Short testimonial from the hackathon team if the research was useful.

**Demo story:** “This team gave Toasty a product and a target demographic. Toasty found the people, put them in a room, helped run the conversation, paid them, and returned evidence-backed product insight.”

---

## Phase 1: Site Foundation And Host/Guest Call

- Organize the repository as a Toasty Media web and Studio monorepo.
- Establish `site/` as the maintainable public website foundation.
- Establish `studio/director.html` and `studio/guest.html`.
- Use hosted VDO.Ninja through `js/video-engine.js`.
- Support disposable room IDs and guest invite links.
- Provide guest device preview, background choice, and join state.
- Provide host and guest controls, soundboard, real local recording proof, and session end.
- Preserve honest fallback states for browser permission and recording support failures.

## Phase 2: Reliable Multi-Participant Recording

- Replace the original two-person/local-recording assumption with the architecture selected in Gate 4.
- Coordinate recording across multi-participant sessions.
- Preserve isolated audio/video where practical.
- Store and reconcile session metadata beside media outputs.
- Add recovery behavior for dropped tracks.
- Detect and guide around device contention.

## Phase 3: Google Drive Automatic Storage

- Implement OAuth and least-privilege Drive access.
- Create session folders automatically.
- Upload raw assets safely.
- Verify upload integrity before allowing local cleanup.
- Keep local recordings temporary by design.

## Phase 4: FFmpeg Automatic Post-Production

- Add an FFmpeg processing adapter.
- Sync tracks.
- Normalize audio.
- Generate full video and audio-only exports.
- Add intro, outro and selected branding.
- Generate clip-ready exports.
- Make Focus Group delivery packages a supported recipe.

## Phase 5: Transcription And Evidence

- Add reliable speaker-attributed transcription.
- Produce full transcript, subtitles, plain text and Markdown.
- Preserve timestamps and participant identity.
- Generate clip candidates and research evidence references from transcript/media timestamps.

## Phase 6: Publishing And Delivery

- Prepare full-session and clip packages.
- Provide client delivery pages/packages.
- Keep public publishing optional and approval-based.
- Add status tracking and retry behavior.

## Phase 7: AI Content And Research Automation

- Generate episode/session summaries.
- Extract key quotes.
- Produce Focus Group Intelligence Packs.
- Draft articles and social assets when the session is public-content oriented.
- Keep AI outputs in the Toasty workflow layer, separate from video transport and processing engines.
