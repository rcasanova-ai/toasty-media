// AudioWorklet: posts batches of { rmsDb, zcr } (one per 20 ms) of the microphone, off the main thread so a backgrounded Studio tab
// keeps analysing (timers in background tabs are throttled; the audio thread is not).
class ToastyFeatures extends AudioWorkletProcessor {
  constructor() { super(); this.n = Math.round(sampleRate * 0.02); this.buf = new Float32Array(this.n); this.fill = 0; this.batch = []; }
  process(inputs) {
    const ch = inputs[0]?.[0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      this.buf[this.fill++] = ch[i];
      if (this.fill === this.n) {
        let sum = 0, crossings = 0, prev = this.buf[0];
        for (let k = 0; k < this.n; k++) { const v = this.buf[k]; sum += v * v; if ((v >= 0) !== (prev >= 0)) crossings++; prev = v; }
        const rms = Math.sqrt(sum / this.n);
        this.batch.push({ rmsDb: rms > 0 ? 20 * Math.log10(rms) : -120, zcr: crossings / this.n });
        if (this.batch.length >= 10) { this.port.postMessage(this.batch); this.batch = []; }   // 5 messages a second, not 50
        this.fill = 0;
      }
    }
    return true;
  }
}
registerProcessor("toasty-features", ToastyFeatures);
