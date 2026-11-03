// Audio measurement for Studio recordings. Pure functions over decoded samples (Float32Array per channel) so the
// same code runs in the browser (diagnostics panel, in-page checks) and in Node (scripts/audio-analyze.mjs and tests).
//
// Everything here is a MEASUREMENT. Nothing in this file changes audio.

export const CLIP_THRESHOLD = 0.999;
export const SILENCE_DBFS = -60;

export function toDbfs(amplitude) {
  if (!Number.isFinite(amplitude) || amplitude <= 0) return -Infinity;
  return Math.max(-200, 20 * Math.log10(amplitude));
}

const round = (value, digits = 2) => (Number.isFinite(value) ? Math.round(value * 10 ** digits) / 10 ** digits : value);

// ITU-R BS.1770 K-weighting: a high-shelf (head) stage followed by a high-pass (RLB) stage. Coefficients are derived
// for the actual sample rate, the same construction libebur128 uses, so 44.1/48 kHz material measures correctly.
export function kWeightingCoefficients(sampleRate) {
  const shelf = (() => {
    const f0 = 1681.974450955533, G = 3.999843853973347, Q = 0.7071752369554196;
    const K = Math.tan(Math.PI * f0 / sampleRate);
    const Vh = 10 ** (G / 20), Vb = Vh ** 0.4996667741545416;
    const a0 = 1 + K / Q + K * K;
    return {
      b: [(Vh + Vb * K / Q + K * K) / a0, 2 * (K * K - Vh) / a0, (Vh - Vb * K / Q + K * K) / a0],
      a: [1, 2 * (K * K - 1) / a0, (1 - K / Q + K * K) / a0]
    };
  })();
  const highpass = (() => {
    const f0 = 38.13547087602444, Q = 0.5003270373238773;
    const K = Math.tan(Math.PI * f0 / sampleRate);
    const a0 = 1 + K / Q + K * K;
    return { b: [1, -2, 1], a: [1, 2 * (K * K - 1) / a0, (1 - K / Q + K * K) / a0] };
  })();
  return { shelf, highpass };
}

class Biquad {
  constructor({ b, a }) { this.b = b; this.a = a; this.z1 = 0; this.z2 = 0; }
  process(x) {
    const y = this.b[0] * x + this.z1;
    this.z1 = this.b[1] * x - this.a[1] * y + this.z2;
    this.z2 = this.b[2] * x - this.a[2] * y;
    return y;
  }
}

// Streaming BS.1770-4 loudness meter: feed blocks of samples as they are decoded, read integrated loudness,
// loudness range and short-term series at the end. Memory is one number per 100 ms, so hour-long files are fine.
export class LoudnessMeter {
  constructor(sampleRate, channelCount = 1) {
    this.sampleRate = sampleRate;
    this.channelCount = channelCount;
    const k = kWeightingCoefficients(sampleRate);
    this.filters = Array.from({ length: channelCount }, () => [new Biquad(k.shelf), new Biquad(k.highpass)]);
    this.step = Math.round(sampleRate * 0.1); // 100 ms hops; 400 ms momentary blocks = 4 hops, 3 s short-term = 30 hops
    this.hop = new Float64Array(this.step);
    this.hopFill = 0;
    this.hopEnergies = [];
  }
  push(channels) {
    const frames = channels[0]?.length || 0;
    for (let i = 0; i < frames; i++) {
      let energy = 0;
      for (let c = 0; c < this.channelCount; c++) {
        const f = this.filters[c];
        const y = f[1].process(f[0].process(channels[c][i]));
        energy += y * y;
      }
      this.hop[this.hopFill++] = energy;
      if (this.hopFill === this.step) {
        let sum = 0;
        for (let j = 0; j < this.step; j++) sum += this.hop[j];
        this.hopEnergies.push(sum / this.step);
        this.hopFill = 0;
      }
    }
  }
  _windowLoudness(windowHops) {
    const out = [];
    for (let i = 0; i + windowHops <= this.hopEnergies.length; i++) {
      let sum = 0;
      for (let j = 0; j < windowHops; j++) sum += this.hopEnergies[i + j];
      out.push(sum / windowHops);
    }
    return out;
  }
  static _lufs(meanSquare) { return meanSquare > 0 ? -0.691 + 10 * Math.log10(meanSquare) : -Infinity; }
  result() {
    const momentary = this._windowLoudness(4); // mean-square per 400 ms block, hop 100 ms (75 % overlap)
    const absolute = momentary.filter((e) => LoudnessMeter._lufs(e) > -70);
    if (!absolute.length) return { integratedLufs: -Infinity, loudnessRangeLu: 0, shortTermLufs: [], momentaryLufs: [] };
    const relThreshold = LoudnessMeter._lufs(absolute.reduce((a, b) => a + b, 0) / absolute.length) - 10;
    const gated = absolute.filter((e) => LoudnessMeter._lufs(e) > relThreshold);
    const integrated = gated.length ? LoudnessMeter._lufs(gated.reduce((a, b) => a + b, 0) / gated.length) : -Infinity;
    // Loudness range (EBU R128 / Tech 3342): short-term (3 s) blocks, gated at -70 abs and -20 rel, 10th..95th percentile.
    const shortTerm = this._windowLoudness(30);
    const stAbs = shortTerm.filter((e) => LoudnessMeter._lufs(e) > -70);
    let range = 0;
    if (stAbs.length) {
      const stRel = LoudnessMeter._lufs(stAbs.reduce((a, b) => a + b, 0) / stAbs.length) - 20;
      const values = stAbs.map(LoudnessMeter._lufs).filter((v) => v > stRel).sort((a, b) => a - b);
      if (values.length > 1) range = values[Math.floor(0.95 * (values.length - 1))] - values[Math.floor(0.1 * (values.length - 1))];
    }
    return {
      integratedLufs: integrated,
      loudnessRangeLu: range,
      shortTermLufs: shortTerm.map(LoudnessMeter._lufs),
      momentaryLufs: momentary.map(LoudnessMeter._lufs)
    };
  }
}

export function measureLoudness(channels, sampleRate) {
  const meter = new LoudnessMeter(sampleRate, channels.length);
  meter.push(channels);
  return meter.result();
}

// Streaming sample statistics (peak, clipping, DC, RMS, digital-zero dropouts, silence) for one or more channels.
export class SampleStats {
  constructor(sampleRate, channelCount = 1) {
    this.sampleRate = sampleRate;
    this.channelCount = channelCount;
    this.frames = 0;
    this.peak = 0;
    this.sumSquares = 0;
    this.sum = 0;
    this.clippedSamples = 0;
    this.clipRuns = 0;
    this._clipRun = Array(channelCount).fill(0);
    this._zeroRun = 0;
    this.dropouts = [];            // digital-silence gaps inside programme material, in seconds
    this._signalSeen = false;
    this.win = Math.max(1, Math.round(sampleRate * 0.05));
    this._winSq = 0; this._winN = 0;
    this.silentWindows = 0; this.windows = 0;
    this._silenceRun = 0; this.longestSilenceWindows = 0;
    this.levelHistogram = new Uint32Array(141); // 50 ms window RMS in 1 dB bins, -140..0 dBFS: a noise-floor / speech-level estimate without storing windows
    this.channelPeaks = Array(channelCount).fill(0);
  }
  push(channels) {
    const frames = channels[0]?.length || 0;
    const zeroMin = Math.round(this.sampleRate * 0.01); // 10 ms of exact zeros
    for (let i = 0; i < frames; i++) {
      let allZero = true, frameSq = 0;
      for (let c = 0; c < this.channelCount; c++) {
        const x = channels[c][i];
        const a = Math.abs(x);
        if (a > this.peak) this.peak = a;
        if (a > this.channelPeaks[c]) this.channelPeaks[c] = a;
        this.sum += x;
        frameSq += x * x;
        if (a >= CLIP_THRESHOLD) {
          this.clippedSamples++;
          if (++this._clipRun[c] === 3) this.clipRuns++; // 3+ consecutive full-scale samples = a flat-topped clip, not a lone peak
        } else this._clipRun[c] = 0;
        if (x !== 0) allZero = false;
      }
      this.sumSquares += frameSq;
      if (allZero) {
        this._zeroRun++;
      } else {
        // Digital silence in the first 300 ms is device/processing start-up (AEC and noise suppression ramp in), not a dropout.
        if (this._signalSeen && this._zeroRun >= zeroMin && (this.frames + i - this._zeroRun) / this.sampleRate >= 0.3) this.dropouts.push({ atSec: round((this.frames + i - this._zeroRun) / this.sampleRate, 3), durationMs: round(this._zeroRun / this.sampleRate * 1000, 1) });
        this._zeroRun = 0;
        this._signalSeen = true;
      }
      this._winSq += frameSq / this.channelCount;
      if (++this._winN === this.win) {
        const rms = Math.sqrt(this._winSq / this._winN);
        this.windows++;
        this.levelHistogram[Math.max(0, Math.min(140, Math.round(toDbfs(rms)) + 140))]++;
        if (toDbfs(rms) < SILENCE_DBFS) { this.silentWindows++; this.longestSilenceWindows = Math.max(this.longestSilenceWindows, ++this._silenceRun); }
        else this._silenceRun = 0;
        this._winSq = 0; this._winN = 0;
      }
    }
    this.frames += frames;
  }
  _percentileDbfs(p) {
    const total = this.levelHistogram.reduce((a, b) => a + b, 0);
    if (!total) return -Infinity;
    let acc = 0;
    for (let i = 0; i < this.levelHistogram.length; i++) { acc += this.levelHistogram[i]; if (acc >= total * p) return i - 140; }
    return 0;
  }
  result() {
    const samples = this.frames * this.channelCount || 1;
    const rms = Math.sqrt(this.sumSquares / samples);
    return {
      frames: this.frames,
      durationSec: round(this.frames / this.sampleRate, 3),
      peakDbfs: round(toDbfs(this.peak)),
      rmsDbfs: round(toDbfs(rms)),
      crestDb: round(toDbfs(this.peak) - toDbfs(rms)),
      dcOffset: round(this.sum / samples, 6),
      clippedSamples: this.clippedSamples,
      clipRuns: this.clipRuns,
      dropouts: this.dropouts,
      // Noise floor = quietest 10 % of 50 ms windows; speech level = loudest 10 %. Their gap is a practical signal-to-noise estimate.
      noiseFloorDbfs: this._percentileDbfs(0.1),
      speechLevelDbfs: this._percentileDbfs(0.9),
      snrEstimateDb: this._percentileDbfs(0.9) - this._percentileDbfs(0.1),
      silenceRatio: round(this.windows ? this.silentWindows / this.windows : 0, 3),
      longestSilenceSec: round(this.longestSilenceWindows * this.win / this.sampleRate, 2),
      channelPeaksDbfs: this.channelPeaks.map((p) => round(toDbfs(p)))
    };
  }
}

// One-shot analysis of already-decoded channels.
export function analyzeChannels(channels, sampleRate) {
  const stats = new SampleStats(sampleRate, channels.length);
  stats.push(channels);
  const loudness = measureLoudness(channels, sampleRate);
  const finite = loudness.shortTermLufs.filter(Number.isFinite);
  const mean = finite.reduce((a, b) => a + b, 0) / (finite.length || 1);
  const stdDev = Math.sqrt(finite.reduce((a, b) => a + (b - mean) ** 2, 0) / (finite.length || 1));
  return {
    sampleRate,
    channels: channels.length,
    ...stats.result(),
    integratedLufs: round(loudness.integratedLufs),
    loudnessRangeLu: round(loudness.loudnessRangeLu),
    shortTermStdDevLu: round(stdDev) // loudness consistency: lower = steadier
  };
}

// Stream-wise analysis for long recordings: callers hand decoded blocks to push(); result() returns the same shape as
// analyzeChannels. Memory stays bounded regardless of recording length.
export class StreamingAnalyzer {
  constructor(sampleRate, channelCount) {
    this.sampleRate = sampleRate;
    this.channelCount = channelCount;
    this.stats = new SampleStats(sampleRate, channelCount);
    this.loudness = new LoudnessMeter(sampleRate, channelCount);
  }
  push(channels) { this.stats.push(channels); this.loudness.push(channels); }
  result() {
    const loudness = this.loudness.result();
    const finite = loudness.shortTermLufs.filter(Number.isFinite);
    const mean = finite.reduce((a, b) => a + b, 0) / (finite.length || 1);
    const stdDev = Math.sqrt(finite.reduce((a, b) => a + (b - mean) ** 2, 0) / (finite.length || 1));
    return {
      sampleRate: this.sampleRate,
      channels: this.channelCount,
      ...this.stats.result(),
      integratedLufs: round(loudness.integratedLufs),
      loudnessRangeLu: round(loudness.loudnessRangeLu),
      shortTermStdDevLu: round(stdDev)
    };
  }
}

// Linear-interpolated delay + gain + residual between a reference and a test signal (mono, same rate).
// Used to find where the chain delays the audio (sync) and how much of the signal survives (similarity), without
// assuming the test is a clean copy: lossy codecs change the waveform, so similarity is correlation, not equality.
export function compareSignals(reference, test, sampleRate, { maxDelaySec = 1.5, minOverlapSec = null } = {}) {
  // A lag that leaves only a sliver of overlap can correlate perfectly by chance, so every candidate lag must overlap by at
  // least half of the shorter signal (capped at 8 s).
  const overlapNeededSec = minOverlapSec ?? Math.min(8, Math.min(reference.length, test.length) / sampleRate / 2);
  const envelope = (x, hop) => {
    const out = new Float32Array(Math.floor(x.length / hop));
    for (let i = 0; i < out.length; i++) {
      let s = 0;
      for (let j = 0; j < hop; j++) s += Math.abs(x[i * hop + j]);
      out[i] = s / hop;
    }
    return out;
  };
  const meanOf = (x) => x.reduce((s, v) => s + v, 0) / (x.length || 1);
  // Correlation of two envelopes for lags in [from, to] (in envelope units); returns the best lag.
  const searchLag = (a, b, from, to, stride = 1, unitsPerSec = 100) => {
    const needed = Math.round(overlapNeededSec * unitsPerSec);
    const ma = meanOf(a), mb = meanOf(b);
    let best = { lag: from, score: -Infinity };
    for (let lag = from; lag <= to; lag++) {
      let num = 0, da = 0, db = 0;
      const start = Math.max(0, -lag), end = Math.min(a.length, b.length - lag);
      if (end - start < needed) continue;
      for (let i = start; i < end; i += stride) {
        const x = a[i] - ma, y = b[i + lag] - mb;
        num += x * y; da += x * x; db += y * y;
      }
      const score = da && db ? num / Math.sqrt(da * db) : 0;
      if (score > best.score) best = { lag, score };
    }
    return best;
  };
  // Coarse (10 ms envelope) over the whole delay range, then fine (1 ms envelope) around the coarse winner.
  const coarseHop = Math.max(1, Math.round(sampleRate / 100)), fineHop = Math.max(1, Math.round(sampleRate / 1000));
  const coarse = searchLag(envelope(reference, coarseHop), envelope(test, coarseHop), -Math.round(maxDelaySec * 100), Math.round(maxDelaySec * 100));
  const centreMs = coarse.lag * 10;
  const fine = searchLag(envelope(reference, fineHop), envelope(test, fineHop), centreMs - 15, centreMs + 15, 1, 1000);
  const best = fine;
  const hop = fineHop;
  // The envelope search is only good to ~1 ms. Refine on the waveform itself (+/- 2 hops) so correlation and
  // signal-to-error are measured at sample-accurate alignment instead of being corrupted by a sub-ms phase error.
  let delaySamples = best.lag * hop;
  {
    const centre = delaySamples, span = hop * 2 + 2;
    const from = Math.max(0, Math.round(sampleRate * 2), -centre + 1), to = Math.min(reference.length, test.length - centre - span - 1, from + sampleRate * 20);
    let bestScore = -Infinity;
    for (let d = centre - span; d <= centre + span; d++) {
      let num = 0, da = 0, db = 0;
      for (let i = Math.max(from, -d); i < Math.min(to, test.length - d); i += 3) { const x = reference[i], y = test[i + d]; num += x * y; da += x * x; db += y * y; }
      const score = da && db ? num / Math.sqrt(da * db) : 0;
      if (score > bestScore) { bestScore = score; delaySamples = d; }
    }
  }
  // Waveform-level correlation after alignment.
  let num = 0, da = 0, db = 0, refEnergy = 0, errEnergy = 0;
  const start = Math.max(0, -delaySamples), end = Math.min(reference.length, test.length - delaySamples);
  let gainNum = 0, gainDen = 0;
  for (let i = start; i < end; i++) { gainNum += reference[i] * test[i + delaySamples]; gainDen += reference[i] * reference[i]; }
  const gain = gainDen ? gainNum / gainDen : 1;
  for (let i = start; i < end; i++) {
    const r = reference[i], t = test[i + delaySamples];
    num += r * t; da += r * r; db += t * t;
    const e = t - gain * r;
    refEnergy += (gain * r) ** 2; errEnergy += e * e;
  }
  return {
    delayMs: round(delaySamples / sampleRate * 1000, 1),
    envelopeCorrelation: round(best.score, 4),
    waveformCorrelation: round(da && db ? num / Math.sqrt(da * db) : 0, 4),
    gainDb: round(toDbfs(Math.abs(gain))),
    // Signal-to-error after removing the best linear gain: how far the test deviates from the reference.
    signalToErrorDb: round(errEnergy ? 10 * Math.log10(refEnergy / errEnergy) : Infinity)
  };
}

// Compare the same programme measured at successive chain stages. `stages` is an ordered list of
// { name, analysis, container? } where analysis is analyzeChannels() output. Returns findings that name the first
// stage where a measurable degradation appears, so a bad recording can be traced to a step rather than guessed at.
export function compareStages(stages, thresholds = {}) {
  const t = { loudnessShiftLu: 3, peakRiseDb: 1.5, rangeGrowthLu: 3, durationDriftSec: 0.25, ...thresholds };
  const findings = [];
  for (let i = 0; i < stages.length; i++) {
    const cur = stages[i].analysis;
    if (cur.clippedSamples > 0) findings.push({ stage: stages[i].name, severity: "error", code: "clipping", detail: `${cur.clippedSamples} clipped samples in ${cur.clipRuns} runs` });
    if (cur.dropouts?.length) findings.push({ stage: stages[i].name, severity: "error", code: "dropouts", detail: `${cur.dropouts.length} digital-silence gaps (first at ${cur.dropouts[0].atSec}s, ${cur.dropouts[0].durationMs} ms)` });
    if (Math.abs(cur.dcOffset) > 0.01) findings.push({ stage: stages[i].name, severity: "warn", code: "dc-offset", detail: `DC offset ${cur.dcOffset}` });
    if (i === 0) continue;
    const prev = stages[i - 1].analysis;
    if (prev.sampleRate !== cur.sampleRate) findings.push({ stage: stages[i].name, severity: "info", code: "resampled", detail: `${prev.sampleRate} Hz -> ${cur.sampleRate} Hz` });
    if (prev.channels !== cur.channels) findings.push({ stage: stages[i].name, severity: "info", code: "channel-change", detail: `${prev.channels} ch -> ${cur.channels} ch` });
    if (Number.isFinite(prev.integratedLufs) && Number.isFinite(cur.integratedLufs) && Math.abs(cur.integratedLufs - prev.integratedLufs) > t.loudnessShiftLu) {
      findings.push({ stage: stages[i].name, severity: "warn", code: "loudness-shift", detail: `${prev.integratedLufs} -> ${cur.integratedLufs} LUFS` });
    }
    if (cur.peakDbfs - prev.peakDbfs > t.peakRiseDb) findings.push({ stage: stages[i].name, severity: "warn", code: "peak-rise", detail: `peak ${prev.peakDbfs} -> ${cur.peakDbfs} dBFS` });
    if (cur.loudnessRangeLu - prev.loudnessRangeLu > t.rangeGrowthLu) findings.push({ stage: stages[i].name, severity: "warn", code: "range-growth", detail: `loudness range ${prev.loudnessRangeLu} -> ${cur.loudnessRangeLu} LU` });
    if (Math.abs(cur.durationSec - prev.durationSec) > t.durationDriftSec) findings.push({ stage: stages[i].name, severity: "warn", code: "duration-drift", detail: `${prev.durationSec}s -> ${cur.durationSec}s` });
  }
  return findings;
}

// WebRTC inbound/outbound audio stats -> the numbers that matter for voice quality. `prev` (an earlier summary's
// raw counters) lets the caller get per-interval loss/concealment instead of since-connection averages.
export function summarizeRtcAudioStats(reports, prev = null) {
  const list = Array.isArray(reports) ? reports : [...(reports?.values?.() || [])];
  const inbound = list.find((r) => r.type === "inbound-rtp" && (r.kind || r.mediaType) === "audio");
  const outbound = list.find((r) => r.type === "outbound-rtp" && (r.kind || r.mediaType) === "audio");
  const pair = list.find((r) => r.type === "candidate-pair" && (r.nominated || r.selected) && r.state === "succeeded");
  const out = { raw: {} };
  if (inbound) {
    const received = inbound.packetsReceived || 0, lost = inbound.packetsLost || 0;
    const prevRaw = prev?.raw || {};
    const dReceived = received - (prevRaw.packetsReceived || 0), dLost = lost - (prevRaw.packetsLost || 0);
    const concealed = inbound.concealedSamples || 0, total = inbound.totalSamplesReceived || 0;
    const dConcealed = concealed - (prevRaw.concealedSamples || 0), dTotal = total - (prevRaw.totalSamplesReceived || 0);
    out.inbound = {
      packetLossPct: round(received + lost ? (lost / (received + lost)) * 100 : 0),
      intervalPacketLossPct: round(dReceived + dLost > 0 ? (dLost / (dReceived + dLost)) * 100 : 0),
      jitterMs: round((inbound.jitter || 0) * 1000, 1),
      concealedPct: round(total ? (concealed / total) * 100 : 0), // samples the decoder invented = audible glitches
      intervalConcealedPct: round(dTotal > 0 ? (dConcealed / dTotal) * 100 : 0),
      concealmentEvents: inbound.concealmentEvents || 0,
      insertedSamplesForDeceleration: inbound.insertedSamplesForDeceleration || 0,
      removedSamplesForAcceleration: inbound.removedSamplesForAcceleration || 0,
      audioLevel: inbound.audioLevel ?? null,
      jitterBufferDelayMs: round(inbound.jitterBufferEmittedCount ? (inbound.jitterBufferDelay / inbound.jitterBufferEmittedCount) * 1000 : 0, 1)
    };
    out.raw = { packetsReceived: received, packetsLost: lost, concealedSamples: concealed, totalSamplesReceived: total };
  }
  if (outbound) out.outbound = { bytesSent: outbound.bytesSent || 0, targetBitrate: outbound.targetBitrate ?? null, packetsSent: outbound.packetsSent || 0 };
  if (pair) out.network = { rttMs: round((pair.currentRoundTripTime || 0) * 1000, 1), availableOutgoingKbps: pair.availableOutgoingBitrate ? Math.round(pair.availableOutgoingBitrate / 1000) : null };
  return out;
}

export function rtcQualityVerdict(summary) {
  const i = summary?.inbound;
  if (!i) return { state: "unknown", message: "No audio stats yet." };
  if (i.intervalPacketLossPct > 5 || i.intervalConcealedPct > 10 || i.jitterMs > 80) return { state: "poor", message: "Audio is breaking up: packet loss, concealment or jitter is high." };
  if (i.intervalPacketLossPct > 1 || i.intervalConcealedPct > 2 || i.jitterMs > 30) return { state: "fair", message: "Audio is mostly fine with occasional glitches." };
  return { state: "good", message: "Audio connection is clean." };
}

// MediaRecorder dataavailable timestamps -> gaps. A recorder that is starved (tab throttled, CPU stalled) delivers
// slices late; a slice later than 2x the requested timeslice means audio may have been dropped around it.
export function detectRecorderGaps(timestampsMs, timesliceMs = 1000) {
  const gaps = [];
  for (let i = 1; i < timestampsMs.length; i++) {
    const delta = timestampsMs[i] - timestampsMs[i - 1];
    if (delta > timesliceMs * 2) gaps.push({ atMs: timestampsMs[i - 1], lateByMs: Math.round(delta - timesliceMs) });
  }
  return { slices: timestampsMs.length, gaps, worstLateMs: gaps.reduce((m, g) => Math.max(m, g.lateByMs), 0) };
}
