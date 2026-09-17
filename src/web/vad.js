/**
 * Energy-based speech detection on an echo-cancelled microphone stream.
 *
 * Why this exists: `SpeechRecognition` opens its own microphone and we cannot
 * hand it a processed stream, so while the agent is speaking the recogniser
 * transcribes the speaker output as if the customer had said it. The only
 * reliable cure is to stop the recogniser during playback - but that would
 * also remove barge-in, which the product needs.
 *
 * So we open a *second* capture with `echoCancellation: true`. The browser's
 * AEC subtracts what it is playing out, which means energy on this stream
 * while the agent talks is the customer, not the agent. That gives a barge-in
 * signal that survives with the recogniser switched off.
 *
 * The scoring is split out so the state machine can be unit-tested without a
 * microphone. See vad.test.ts.
 */

/** Root-mean-square level of a byte time-domain buffer, normalised to 0..1. */
export function rmsOf(timeDomain) {
  if (!timeDomain || timeDomain.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < timeDomain.length; i++) {
    const v = (timeDomain[i] - 128) / 128;
    sum += v * v;
  }
  return Math.sqrt(sum / timeDomain.length);
}

/**
 * Fires once when the level has stayed above the noise floor long enough to be
 * speech rather than a door closing or a keyboard.
 */
export class SustainedEnergyGate {
  // 140 ms is long enough to reject a keystroke or a door (both under 100 ms)
  // and short enough that, with a 30 ms poll, audio stops inside the ~200 ms
  // the brief asks for.
  constructor({ sustainMs = 140, minThreshold = 0.02, floorFactor = 3.5 } = {}) {
    this.sustainMs = sustainMs;
    this.minThreshold = minThreshold;
    this.floorFactor = floorFactor;
    this.floor = 0.004;
    this.aboveSince = null;
    this.fired = false;
  }

  /** Track the room's noise floor while nobody is expected to be talking. */
  observeIdle(rms) {
    // Rises slowly, falls quickly, so a brief noise does not desensitise it.
    this.floor = rms < this.floor ? this.floor * 0.9 + rms * 0.1 : this.floor * 0.995 + rms * 0.005;
  }

  get threshold() {
    return Math.max(this.minThreshold, this.floor * this.floorFactor);
  }

  /** @returns true exactly once per stretch of speech. */
  push(rms, now) {
    if (rms < this.threshold) {
      this.aboveSince = null;
      this.fired = false;
      return false;
    }
    if (this.aboveSince == null) this.aboveSince = now;
    if (!this.fired && now - this.aboveSince >= this.sustainMs) {
      this.fired = true;
      return true;
    }
    return false;
  }

  reset() {
    this.aboveSince = null;
    this.fired = false;
  }
}

/**
 * Opens an echo-cancelled capture and polls its level.
 * `onSpeech()` fires when sustained speech is detected while armed.
 */
export class MicMonitor {
  constructor({ onSpeech, pollMs = 30, gate } = {}) {
    this.onSpeech = onSpeech ?? (() => {});
    this.pollMs = pollMs;
    this.gate = gate ?? new SustainedEnergyGate();
    this.stream = null;
    this.ctx = null;
    this.analyser = null;
    this.data = null;
    this.timer = null;
    this.armed = false;
    this.available = false;
    this.level = 0;
  }

  async start() {
    if (this.stream) return true;
    if (!navigator.mediaDevices?.getUserMedia) return false;

    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });

    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    await this.ctx.resume();
    const source = this.ctx.createMediaStreamSource(this.stream);
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    // Deliberately not connected to the destination: this is a meter, not audio.
    source.connect(this.analyser);
    this.data = new Uint8Array(this.analyser.fftSize);

    this.timer = setInterval(() => this.tick(), this.pollMs);
    this.available = true;
    return true;
  }

  tick() {
    if (!this.analyser) return;
    this.analyser.getByteTimeDomainData(this.data);
    const rms = rmsOf(this.data);
    this.level = rms;

    if (!this.armed) {
      this.gate.observeIdle(rms);
      this.gate.reset();
      return;
    }
    if (this.gate.push(rms, Date.now())) this.onSpeech();
  }

  /** Arm while the agent is speaking; anything heard now is an interruption. */
  arm() {
    this.gate.reset();
    this.armed = true;
  }

  disarm() {
    this.armed = false;
    this.gate.reset();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
    this.armed = false;
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.stream = null;
    this.analyser = null;
    if (this.ctx?.state !== 'closed') this.ctx?.close?.();
    this.ctx = null;
    this.available = false;
  }
}
