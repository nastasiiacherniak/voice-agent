/**
 * The barge-in detector that replaces text-based echo filtering.
 *
 * The recogniser is switched off while the agent speaks, so interruption has
 * to come from somewhere else: sustained energy on an echo-cancelled capture.
 */
import { describe, expect, it } from 'vitest';
// @ts-expect-error - plain browser module, no type declarations
import { rmsOf, SustainedEnergyGate } from '../src/web/vad.js';

/** A byte time-domain buffer centred on 128, as an AnalyserNode produces. */
function tone(amplitude: number, samples = 1024): Uint8Array {
  const buf = new Uint8Array(samples);
  for (let i = 0; i < samples; i++) {
    buf[i] = Math.round(128 + Math.sin((i / samples) * Math.PI * 2 * 8) * amplitude * 128);
  }
  return buf;
}

describe('level metering', () => {
  it('reads silence as roughly zero', () => {
    expect(rmsOf(tone(0))).toBeLessThan(0.001);
  });

  it('rises with amplitude', () => {
    expect(rmsOf(tone(0.5))).toBeGreaterThan(rmsOf(tone(0.1)));
  });

  it('survives an empty buffer', () => {
    expect(rmsOf(new Uint8Array(0))).toBe(0);
    expect(rmsOf(null)).toBe(0);
  });
});

describe('sustained energy gate', () => {
  it('ignores a level below the floor', () => {
    const gate = new SustainedEnergyGate({ sustainMs: 140 });
    let t = 0;
    for (let i = 0; i < 20; i++) expect(gate.push(0.001, (t += 30))).toBe(false);
  });

  it('ignores a short transient like a door or a keystroke', () => {
    const gate = new SustainedEnergyGate({ sustainMs: 140 });
    let t = 0;
    // 90 ms of noise, then silence: never reaches the sustain threshold.
    expect(gate.push(0.2, (t += 30))).toBe(false);
    expect(gate.push(0.2, (t += 30))).toBe(false);
    expect(gate.push(0.2, (t += 30))).toBe(false);
    expect(gate.push(0.001, (t += 30))).toBe(false);
  });

  it('fires once speech has lasted long enough', () => {
    const gate = new SustainedEnergyGate({ sustainMs: 140 });
    let t = 0;
    let fired = false;
    for (let i = 0; i < 10; i++) fired = gate.push(0.2, (t += 30)) || fired;
    expect(fired).toBe(true);
  });

  it('fires only once per stretch of speech', () => {
    const gate = new SustainedEnergyGate({ sustainMs: 140 });
    let t = 0;
    let count = 0;
    for (let i = 0; i < 20; i++) if (gate.push(0.2, (t += 30))) count++;
    expect(count).toBe(1);
  });

  it('re-arms after the speaker stops', () => {
    const gate = new SustainedEnergyGate({ sustainMs: 140 });
    let t = 0;
    let count = 0;
    for (let i = 0; i < 10; i++) if (gate.push(0.2, (t += 30))) count++;
    for (let i = 0; i < 5; i++) gate.push(0.001, (t += 30));
    for (let i = 0; i < 10; i++) if (gate.push(0.2, (t += 30))) count++;
    expect(count).toBe(2);
  });

  it('raises its threshold in a noisy room', () => {
    const quiet = new SustainedEnergyGate();
    const noisy = new SustainedEnergyGate();
    for (let i = 0; i < 500; i++) {
      quiet.observeIdle(0.002);
      noisy.observeIdle(0.05);
    }
    expect(noisy.threshold).toBeGreaterThan(quiet.threshold);
  });

  it('never drops below the floor threshold, however quiet the room', () => {
    const gate = new SustainedEnergyGate({ minThreshold: 0.02 });
    for (let i = 0; i < 1000; i++) gate.observeIdle(0);
    expect(gate.threshold).toBeGreaterThanOrEqual(0.02);
  });

  it('detects an interruption inside the 200 ms the brief asks for', () => {
    const gate = new SustainedEnergyGate({ sustainMs: 140 });
    let t = 0;
    let firedAt: number | null = null;
    for (let i = 0; i < 20 && firedAt == null; i++) {
      t += 30;
      if (gate.push(0.2, t)) firedAt = t;
    }
    expect(firedAt).not.toBeNull();
    expect(firedAt!).toBeLessThanOrEqual(200); // sustain window plus one poll
  });

  it('resets cleanly when disarmed', () => {
    const gate = new SustainedEnergyGate({ sustainMs: 140 });
    let t = 0;
    gate.push(0.2, (t += 30));
    gate.push(0.2, (t += 30));
    gate.reset();
    expect(gate.push(0.2, (t += 30))).toBe(false); // sustain starts over
  });
});
