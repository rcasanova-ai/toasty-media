// Look-ahead peak limiter, sample by sample. Pure and dependency-free so the exact same code runs inside an
// AudioWorklet (live recording), in the offline enhancement chain (js/audio-enhance.js) and in Node tests.
//
// Guarantee: no output sample exceeds the ceiling. Below the ceiling the gain is exactly 1 (the limiter is transparent).
// How: required gain per sample -> sliding minimum over the look-ahead window -> release smoothing (fast down, slow up)
// -> moving average over the same window length, which together keep gain(i) <= required(i) for every sample while the
// gain changes smoothly (no clicks). The audio is delayed by `lookahead` samples to make this possible.
export class StreamingLimiter {
  constructor(sampleRate, channelCount = 1, { ceilingDb = -1, lookaheadMs = 5, releaseMs = 80 } = {}) {
    this.channelCount = channelCount;
    this.ceiling = 10 ** (ceilingDb / 20);
    this.L = Math.max(1, Math.round(sampleRate * lookaheadMs / 1000));
    this.releaseCoef = 1 - Math.exp(-1 / (sampleRate * releaseMs / 1000));
    const size = this.L + 1;
    this.size = size;
    this.delay = Array.from({ length: channelCount }, () => new Float32Array(size)); // audio delay line
    this.required = new Float32Array(size);   // ring of required gains (for the sliding minimum)
    this.held = new Float32Array(size);       // ring of released gains (for the moving average)
    this.heldSum = 0;
    this.gain = 1;                            // release-smoothed gain state
    this.n = 0;                               // samples pushed so far
    // monotonic deque over `required` (indices), as a ring
    this.dq = new Float64Array(size + 1);   // sample indices (float64 so a many-hour take cannot overflow)
    this.dqHead = 0; this.dqTail = 0; this.dqLen = 0;
    this.maxReductionDb = 0;
    this.activeSamples = 0;
  }

  get latencySamples() { return this.L; }

  // Process one frame (one sample per channel) in place into `out`: returns false until the delay line is primed.
  // Used by process() below; exposed for tests that want per-sample behaviour.
  _step(frameIn, frameOut) {
    const { size, L, n } = this;
    const slot = n % size;
    let peak = 0;
    for (let c = 0; c < this.channelCount; c++) { const a = Math.abs(frameIn[c]); if (a > peak) peak = a; }
    const req = peak > this.ceiling ? this.ceiling / peak : 1;
    this.required[slot] = req;
    // maintain monotonic deque of indices with increasing `required` values
    while (this.dqLen > 0) {
      const tailIdx = (this.dqTail - 1 + this.dq.length) % this.dq.length;
      if (this.required[this.dq[tailIdx] % size] >= req) { this.dqTail = tailIdx; this.dqLen--; } else break;
    }
    this.dq[this.dqTail] = n; this.dqTail = (this.dqTail + 1) % this.dq.length; this.dqLen++;
    // drop indices that left the window [n-L, n]
    while (this.dqLen > 0 && this.dq[this.dqHead] < n - L) { this.dqHead = (this.dqHead + 1) % this.dq.length; this.dqLen--; }
    const windowMin = this.required[this.dq[this.dqHead] % size];
    // release smoothing then moving average of the last L+1 smoothed gains
    this.gain = Math.min(windowMin, this.gain + (1 - this.gain) * this.releaseCoef);
    const old = this.held[slot];
    this.held[slot] = this.gain;
    this.heldSum += this.gain - (n >= size ? old : 0);
    const count = Math.min(n + 1, size);
    const smooth = this.heldSum / count;
    // The audio sample that leaves the delay line now is the one pushed L samples ago.
    for (let c = 0; c < this.channelCount; c++) {
      this.delay[c][slot] = frameIn[c];
      frameOut[c] = n >= L ? this.delay[c][(n - L) % size] * smooth : 0;
    }
    if (n >= L && smooth < 1) { this.activeSamples++; const db = 20 * Math.log10(smooth); if (db < this.maxReductionDb) this.maxReductionDb = db; }
    this.n++;
  }

  // channels: array of Float32Array (one per channel), all the same length. Writes into `outputs` (same shape).
  process(channels, outputs) {
    const frames = channels[0].length;
    const inFrame = new Float32Array(this.channelCount), outFrame = new Float32Array(this.channelCount);
    for (let i = 0; i < frames; i++) {
      for (let c = 0; c < this.channelCount; c++) inFrame[c] = channels[c][i];
      this._step(inFrame, outFrame);
      for (let c = 0; c < this.channelCount; c++) outputs[c][i] = outFrame[c];
    }
  }

  // Run a whole buffer through and compensate the look-ahead delay, so the result lines up with the input.
  static processBuffer(channels, sampleRate, options) {
    const n = channels[0].length;
    const limiter = new StreamingLimiter(sampleRate, channels.length, options);
    const L = limiter.L;
    const padded = channels.map((ch) => { const p = new Float32Array(n + L); p.set(ch); return p; });
    const out = channels.map(() => new Float32Array(n + L));
    limiter.process(padded, out);
    return { channels: out.map((o) => o.subarray(L)), limiter };
  }
}
