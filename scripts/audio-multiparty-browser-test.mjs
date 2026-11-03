#!/usr/bin/env node
// REAL two-person Studio session: a Host (Studio) and a Guest (separate Chrome process, own microphone programme)
// connect through VDO.Ninja, exactly as in production, and the audio is measured where it can be measured honestly:
//   what each side PUBLISHES (echo cancel / noise suppression / AGC / channels / rate, read inside each VDO frame),
//   WebRTC loss / jitter / concealment at Program Output,
//   the audio each participant ARRIVES as at Program Output (tapped sample-accurately inside each participant's frame),
//   how closely each arrival matches its source programme, and the PROGRAM MIX (the two arrivals summed, which is what
//   the Program Output tab plays and a tab capture records): peak headroom and clipping while both people talk at once.
// The Host also records during the session so the guest flow (record with a guest connected) is exercised end to end, but
// the recording's AUDIO is not asserted: headless Chrome's fake-device mode replaces display-capture audio with a fake
// microphone track, so tab-capture audio can only be verified on a real desktop session (see docs/AUDIO_PIPELINE.md).
// Needs internet (vdo.ninja). Env: HEADLESS=1, PLAYWRIGHT_CORE, CHROME_PATH, KEEP_DIR, REPORT_JSON, SECONDS (default 40)
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { synthProgramme } from "./lib/synth-programme.mjs";
import { analyzeFile, loadMono } from "./lib/audio-file-analysis.mjs";
import { compareSignals, compareStages, summarizeRtcAudioStats, rtcQualityVerdict } from "../js/audio-analysis.js";
import { makeAsserter, loadPlaywright, findChrome, startServers, launchChrome, newStudioPage, createSession, openStudio, joinStudio, stopAndDownload, wavBytes, f32FromB64, BASE, sleep } from "./lib/studio-browser-harness.mjs";

const assert = makeAsserter();
const SECONDS = Number(process.env.SECONDS || 40);
const scratch = process.env.KEEP_DIR ? (mkdirSync(process.env.KEEP_DIR, { recursive: true }), process.env.KEEP_DIR) : mkdtempSync(join(tmpdir(), "toasty-audio-multi-"));
const playwright = await loadPlaywright();
const chromePath = findChrome();
try { await fetch("https://vdo.ninja/", { method: "HEAD", signal: AbortSignal.timeout(8000) }); } catch { console.log("SKIPPED: vdo.ninja is not reachable from here."); process.exit(0); }

const prog = synthProgramme({ seconds: 36 });
const hostWav = join(scratch, "host-programme.wav"), guestWav = join(scratch, "guest-programme.wav");
// HOST_PROGRAMME / GUEST_PROGRAMME: real speech recordings to use instead of the synthetic voices (each becomes 48 kHz mono).
for (const [env, out, synth] of [["HOST_PROGRAMME", hostWav, prog.host], ["GUEST_PROGRAMME", guestWav, prog.guest]]) {
  if (process.env[env]) execFileSync("ffmpeg", ["-v", "error", "-y", "-i", process.env[env], "-ar", "48000", "-ac", "1", "-c:a", "pcm_s16le", out]);
  else writeFileSync(out, wavBytes(synth));
}
await startServers(scratch);
const TAB = "--auto-select-tab-capture-source-by-title=Toasty Studio — Program Output";
const hostBrowser = await launchChrome(playwright, { programmePath: hostWav, chromePath, extraArgs: [TAB] });
const guestBrowser = await launchChrome(playwright, { programmePath: guestWav, chromePath });
const report = { published: {}, rtc: {}, stages: [] };

// Captures every audio-bearing media element inside a frame, one WAV each, plus RTC stats.
const RECEIVE_ALL = `async ({ seconds }) => {
  const els = [...document.querySelectorAll("video,audio")].filter((e) => e.srcObject?.getAudioTracks?.().length && e.srcObject.getAudioTracks()[0].readyState === "live");
  const ctx = new AudioContext({ sampleRate: 48000 });
  const src = 'class C extends AudioWorkletProcessor{process(i){const c=i[0][0];if(c)this.port.postMessage(c.slice());return true}}registerProcessor("cap",C)';
  await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([src], { type: "text/javascript" })));
  const taps = els.map((e) => { const node = new AudioWorkletNode(ctx, "cap"); const chunks = []; node.port.onmessage = (m) => chunks.push(m.data); ctx.createMediaStreamSource(new MediaStream([e.srcObject.getAudioTracks()[0]])).connect(node); return { chunks, id: e.srcObject.id }; });
  await ctx.resume();
  const statsAt = async () => { const out = []; for (const r of Object.values(window.session?.rpcs || {})) { if (typeof r?.getStats !== "function") continue; try { (await r.getStats()).forEach((v) => out.push(v)); } catch (_) {} } return out; };
  await new Promise((r) => setTimeout(r, 3000));
  const statsStart = await statsAt();
  await new Promise((r) => setTimeout(r, seconds * 1000));
  const stats = await statsAt();
  await ctx.close();
  const pack = (chunks) => { const total = chunks.reduce((n, c) => n + c.length, 0), all = new Float32Array(total); let o = 0; for (const c of chunks) { all.set(c, o); o += c.length; } let bin = ""; const u8 = new Uint8Array(all.buffer); for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(bin); };
  return { taps: taps.map((t) => ({ id: t.id, b64: pack(t.chunks) })), stats, statsStart };
}`;

try {
  console.log("\nSetup: Host Studio + Guest in separate Chrome processes");
  const { ctx: hostCtx, page: hostPage } = await newStudioPage(hostBrowser);
  const { id: sessionId } = await createSession(hostPage, "Two person audio");
  const frame = await openStudio(hostPage, sessionId);
  await joinStudio(frame, "Audio Host");
  const urls = await frame.evaluate(() => window.__toastyLiveSession.inviteUrls());
  const guestCtx = await guestBrowser.newContext({ viewport: { width: 900, height: 700 } });
  await guestCtx.grantPermissions(["camera", "microphone"], { origin: BASE });
  const guest = await guestCtx.newPage();
  guest.on("pageerror", (e) => console.log("[guest pageerror]", String(e).slice(0, 160)));
  if (process.env.DEBUG_CONSOLE) { guest.on("console", (m) => console.log("[guest]", m.text().slice(0, 220))); hostPage.on("console", (m) => /guest|presence|roster|VDO|error/i.test(m.text()) && console.log("[host]", m.text().slice(0, 220))); guest.on("response", (r) => /api\//.test(r.url()) && console.log("[guest api]", r.status(), r.url().slice(0, 120))); }
  await guest.goto(urls.guest);
  await guest.waitForFunction(() => { const b = document.querySelector("#joinStudio"); return b && !b.disabled; }, null, { timeout: 40000 });
  await guest.fill("#guestName", "Audio Guest");
  await guest.click("#joinStudio");
  await guest.waitForFunction(() => document.querySelector("#joinState")?.textContent === "Joined", null, { timeout: 60000 });
  await frame.waitForFunction(() => window.__toastyLiveSession.guestSeats.some(Boolean), null, { timeout: 60000 }).catch(async (e) => {
    console.log("  host state:", JSON.stringify(await frame.evaluate(() => { const S = window.__toastyLiveSession; return { seats: S.guestSeats, participants: S.participants.list().map((p) => ({ id: p.participantId, role: p.role, status: p.connectionStatus })), connection: S.connection, roomId: S.roomId }; })));
    console.log("  guest state:", JSON.stringify(await guest.evaluate(() => ({ join: document.querySelector("#joinState")?.textContent, status: document.querySelector("#guestStatus")?.textContent, url: location.href }))));
    for (const f of hostPage.frames().filter((x) => x.url().includes("vdo.ninja"))) {
      const info = await f.evaluate(() => ({ rpcs: Object.keys(window.session?.rpcs || {}).length, room: window.session?.roomid, director: window.session?.director, streamID: window.session?.streamID, label: window.session?.label })).catch((e) => String(e).slice(0, 80));
      console.log("  host vdo frame:", f.url().slice(0, 150), JSON.stringify(info));
    }
    for (const f of guest.frames().filter((x) => x.url().includes("vdo.ninja"))) {
      const info = await f.evaluate(() => ({ rpcs: Object.keys(window.session?.rpcs || {}).length, room: window.session?.roomid, streamID: window.session?.streamID })).catch((e) => String(e).slice(0, 80));
      console.log("  guest vdo frame:", f.url().slice(0, 150), JSON.stringify(info));
    }
    await hostPage.screenshot({ path: join(scratch, "host-fail.png") }); await guest.screenshot({ path: join(scratch, "guest-fail.png") });
    throw e;
  });
  assert(true, "the guest joined and the host sees the guest");

  const [popup] = await Promise.all([hostCtx.waitForEvent("page"), frame.evaluate(() => window.__toastyLiveSession.ensureProgramOutputWindow())]);
  popup.on("pageerror", () => {});
  // Program Output mounts the room's media only while the Program scene is LIVE (the Live scene switch, not an external broadcast).
  await frame.evaluate(() => window.__toastyLiveSession.setLive(true));
  await popup.waitForFunction(() => document.querySelectorAll("iframe").length > 0, null, { timeout: 30000 }).catch(async (e) => {
    console.log("  popup url:", popup.url(), "title:", await popup.title().catch(() => "?"));
    console.log("  popup text:", (await popup.evaluate(() => document.body.innerText.slice(0, 400)).catch(() => "?")).replace(/\s+/g, " "));
    await popup.screenshot({ path: join(scratch, "popup-fail.png") });
    throw e;
  });
  // Program Output renders ONE VDO frame per participant (view=<stream id>); wait until each has a live audio stream.
  const findLiveFrames = async (tries = 90) => {
    let live = [];
    for (let i = 0; i < tries && live.length < 2; i++) {
      await sleep(1000);
      live = [];
      for (const f of popup.frames().filter((x) => x.url().includes("vdo.ninja"))) {
        const n = await f.evaluate(() => [...document.querySelectorAll("video,audio")].filter((e) => e.srcObject?.getAudioTracks?.().length && e.srcObject.getAudioTracks()[0].readyState === "live").length).catch(() => 0);
        if (n > 0) live.push(f);
      }
    }
    return live;
  };
  let liveFrames = await findLiveFrames();
  console.log(`  Program Output has ${liveFrames.length} participant frame(s) with live audio`);
  assert(liveFrames.length >= 2, "Program Output receives both the host's and the guest's audio");

  const hostPub = await frame.evaluate(() => { const f = document.querySelector("iframe"); return null; });
  // What each side actually publishes (read inside each VDO frame).
  const readPublished = async (page) => {
    for (const f of page.frames().filter((x) => x.url().includes("vdo.ninja"))) {
      const r = await f.evaluate(() => { try { const t = window.session?.streamSrc?.getAudioTracks?.()[0]; return t ? t.getSettings() : null; } catch (_) { return null; } }).catch(() => null);
      if (r) return r;
    }
    return null;
  };
  report.published.host = await readPublished(hostPage);
  report.published.guest = await readPublished(guest);
  for (const [who, s] of Object.entries(report.published)) console.log(`  ${who} publishes: echoCancellation=${s?.echoCancellation} noiseSuppression=${s?.noiseSuppression} autoGainControl=${s?.autoGainControl} channels=${s?.channelCount} rate=${s?.sampleRate}`);
  assert(report.published.guest?.echoCancellation === true && report.published.guest?.noiseSuppression === true && report.published.guest?.autoGainControl === false, "the GUEST's published voice has echo cancellation + noise suppression ON and AGC OFF");
  assert(report.published.host?.echoCancellation === true && report.published.host?.noiseSuppression === true && report.published.host?.autoGainControl === false, "the HOST's published voice has echo cancellation + noise suppression ON and AGC OFF");

  console.log(`\nRecording Program Output for ${SECONDS}s (tab capture, the production path with guests)`);
  await frame.click("#lvRecordToggle");
  await frame.waitForFunction(() => window.__toastyLiveSession.recording.active, null, { timeout: 30000 }).catch(async (e) => { console.log("  record status:", await frame.evaluate(() => document.querySelector("#lvRecordNote")?.textContent)); throw e; });
  const kind = await frame.evaluate(() => window.__toastyLiveSession._programCaptureKind);
  assert(kind === "program-output", `the recording used Program Output tab capture (${kind})`);
  const surface = await frame.evaluate(() => { const ms = window.__toastyLiveSession._masterRecorder?.fallback?.masterStream; return ms ? { video: ms.getVideoTracks().map((t) => ({ label: t.label, surface: t.getSettings().displaySurface })), audio: ms.getAudioTracks().map((t) => ({ label: t.label, settings: t.getSettings() })) } : null; });
  report.captureSurface = surface;
  console.log("  captured surface:", JSON.stringify(surface));
  // Starting a recording may re-open/refresh the Program Output window (it is re-targeted by name), which recreates its VDO frames.
  await sleep(4000);
  liveFrames = await findLiveFrames();
  assert(liveFrames.length >= 2, "Program Output still has both participants' audio after the recording started");
  for (const f of liveFrames) {
    const snap = () => f.evaluate(() => [...document.querySelectorAll("video,audio")].filter((e) => e.srcObject?.getAudioTracks?.().length).map((e) => ({ tag: e.tagName, paused: e.paused, muted: e.muted, volume: e.volume, readyState: e.readyState, t: Math.round(e.currentTime * 10) / 10, sink: e.sinkId ?? null, ctx: window.session?.audioCtx?.state || null }))).catch(() => null);
    const a = await snap(); await sleep(1500); const b = await snap();
    console.log("  playback state in", new URL(f.url()).searchParams.get("view"), JSON.stringify({ before: a, after: b }));
  }
  const perFrame = await Promise.all(liveFrames.map((f) => f.evaluate(`(${RECEIVE_ALL})(${JSON.stringify({ seconds: SECONDS - 16 })})`)));
  const rx = { taps: perFrame.flatMap((r) => r.taps), stats: perFrame.flatMap((r) => r.stats), statsStart: perFrame.flatMap((r) => r.statsStart) };
  const end = Date.now() + 3000; while (Date.now() < end) await sleep(200);
  const { last, path } = await stopAndDownload(hostPage, frame, scratch, "multiparty-recording");
  assert(last.status === "finalized", `recording finalized (${last.as || "converted"}, ${last.mime})`);

  // Save each received stream and label it by best match with the two programmes.
  const taps = [];
  for (let i = 0; i < rx.taps.length; i++) { const p = join(scratch, `po-received-${i}.wav`); writeFileSync(p, wavBytes(f32FromB64(rx.taps[i].b64))); taps.push(p); }
  const startS = summarizeRtcAudioStats(rx.statsStart), endS = summarizeRtcAudioStats(rx.stats, startS);
  report.rtc.programOutput = endS; const verdict = rtcQualityVerdict(endS);
  console.log(`  WebRTC at Program Output: loss ${endS.inbound?.packetLossPct ?? "n/a"}%  jitter ${endS.inbound?.jitterMs ?? "n/a"} ms  concealed ${endS.inbound?.concealedPct ?? "n/a"}%  (${verdict.state})`);

  console.log("\nMeasuring what arrives at Program Output");
  const refMono = { host: await loadMono(hostWav, { seconds: 60 }), guest: await loadMono(guestWav, { seconds: 60 }) };
  const rows = [];
  for (let i = 0; i < taps.length; i++) {
    const m = await analyzeFile(taps[i]); const mono = await loadMono(taps[i], { seconds: 60 });
    const sims = {};
    for (const who of ["host", "guest"]) sims[who] = compareSignals(refMono[who].samples, mono.samples, 48000, { maxDelaySec: 36 });
    const who = sims.host.waveformCorrelation >= sims.guest.waveformCorrelation ? "host" : "guest";
    rows.push({ file: taps[i], who, analysis: m.analysis, sim: sims[who], samples: mono.samples });
    console.log(`  arrival ${i} = ${who}: ${m.analysis.integratedLufs} LUFS, peak ${m.analysis.peakDbfs} dBFS, noise floor ${m.analysis.noiseFloorDbfs} dBFS; vs its source: waveform r ${sims[who].waveformCorrelation}, level ${sims[who].gainDb} dB, source-to-arrival delay ${sims[who].delayMs} ms`);
  }
  report.received = rows.map((r) => ({ who: r.who, analysis: r.analysis, sim: r.sim }));
  const host = rows.find((r) => r.who === "host"), guestRow = rows.find((r) => r.who === "guest");
  assert(host && guestRow && host !== guestRow, "one arrival matches the host's source and the other the guest's (no cross-talk, no swap)");

  // Program mix: both arrivals were tapped in parallel from the same page clock, so they are sample-aligned in time.
  const n = Math.min(host.samples.length, guestRow.samples.length), mix = new Float32Array(n);
  for (let i = 0; i < n; i++) mix[i] = host.samples[i] + guestRow.samples[i];
  const mixStats = (await import("../js/audio-analysis.js")).analyzeChannels([mix], 48000);
  report.programMix = mixStats;
  console.log(`  Program mix (host + guest): ${mixStats.integratedLufs} LUFS, peak ${mixStats.peakDbfs} dBFS, loudness range ${mixStats.loudnessRangeLu} LU, short-term std dev ${mixStats.shortTermStdDevLu} LU, clipped ${mixStats.clippedSamples}`);
  const rec = await analyzeFile(path);
  report.recording = { probe: rec.probe };
  console.log(`  Recording container: ${rec.probe.audio.codec} ${rec.probe.audio.sampleRate} Hz ${rec.probe.audio.channels}ch ${rec.probe.audio.bitrateKbps} kbps (audio content not asserted, see header)`);

  console.log("\nAssertions");
  assert(host.analysis.clippedSamples === 0 && guestRow.analysis.clippedSamples === 0, "neither participant arrives clipped");
  const hostSourcePeak = (await analyzeFile(hostWav)).analysis.peakDbfs, guestSourcePeak = (await analyzeFile(guestWav)).analysis.peakDbfs;
  report.peakOvershootDb = { host: Math.round((host.analysis.peakDbfs - hostSourcePeak) * 10) / 10, guest: Math.round((guestRow.analysis.peakDbfs - guestSourcePeak) * 10) / 10 };
  console.log(`  Peak versus source (a sudden noise burst is in the host's programme): host ${report.peakOvershootDb.host} dB, guest ${report.peakOvershootDb.guest} dB; mix peak ${mixStats.peakDbfs} dBFS`);
  assert(mixStats.clippedSamples === 0 && mixStats.peakDbfs < -0.1, `the summed program mix stays below full scale while both talk (peak ${mixStats.peakDbfs} dBFS)`);
  assert(guestRow.sim.waveformCorrelation > 0.8, `the guest arrives recognisably the same signal as its source (waveform r ${guestRow.sim.waveformCorrelation})`);
  assert(Math.abs(guestRow.sim.gainDb) < 3, `the guest's level survives the trip within 3 dB (${guestRow.sim.gainDb} dB)`);
  assert(host.analysis.noiseFloorDbfs < -60 && guestRow.analysis.noiseFloorDbfs < -60, `quiet moments arrive quiet: noise floors ${host.analysis.noiseFloorDbfs} / ${guestRow.analysis.noiseFloorDbfs} dBFS`);
  assert(rec.probe.audio.sampleRate === 48000 && /aac|opus/.test(rec.probe.audio.codec), `the recording container carries ${rec.probe.audio.codec} audio at ${rec.probe.audio.sampleRate} Hz`);
  assert((endS.inbound?.packetLossPct ?? 0) < 2 && (endS.inbound?.concealedPct ?? 0) < 5, "WebRTC loss and concealment are low on loopback");
  writeFileSync(join(scratch, "report.json"), JSON.stringify(report, null, 2));
  if (process.env.REPORT_JSON) writeFileSync(process.env.REPORT_JSON, JSON.stringify(report, null, 2));
  console.log(`\nfiles: ${scratch}\nALL PASSED — a real two-person session was recorded through VDO.Ninja and Program Output tab capture and measured end to end.`);
  await hostBrowser.close(); await guestBrowser.close(); process.exit(0);
} catch (error) {
  console.error(error.message || error);
  try { writeFileSync(join(scratch, "report.json"), JSON.stringify(report, null, 2)); console.error("partial report:", join(scratch, "report.json")); } catch (_) {}
  await hostBrowser.close().catch(() => {}); await guestBrowser.close().catch(() => {}); process.exit(1);
}
