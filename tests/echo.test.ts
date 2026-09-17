/**
 * Echo rejection. Regression cover for the bug where the agent heard itself
 * through the speakers and its own sentence was written into the dialogue as
 * a customer turn.
 */
import { describe, expect, it } from 'vitest';
// @ts-expect-error - plain browser module, no type declarations
import { AgentSpeechMemory, isEchoOf, normaliseWords } from '../src/web/echo.js';

/** What the agent actually says, verbatim from the planner templates. */
const READBACK = 'That is available. 1 Tripod B, 14–16 October 2026. Shall I book it?';
const DONE = 'Done. 1 Tripod B, 14–16 October 2026. Your reservation number is res_3c55bc14.';
const ASK_DATES = 'Certainly. Which dates do you need the tripod for?';

function memoryOf(...sentences: string[]) {
  const m = new AgentSpeechMemory();
  for (const s of sentences) m.remember(s);
  return m;
}

describe('the agent hearing itself', () => {
  it('rejects a clean echo of the read-back', () => {
    expect(memoryOf(READBACK).isEcho(READBACK)).toBe(true);
  });

  it('rejects a partial echo, which is what the recogniser usually returns', () => {
    const m = memoryOf(READBACK);
    expect(m.isEcho('that is available 1 tripod b')).toBe(true);
    expect(m.isEcho('14 16 october 2026 shall i book it')).toBe(true);
  });

  it('rejects an echo with a word misheard', () => {
    // "Tripod B" often comes back as "tripod be".
    expect(memoryOf(READBACK).isEcho('that is available one tripod be 14 16 october')).toBe(true);
  });

  it('rejects an echo of a sentence that already finished playing', () => {
    // Echo arrives between sentences and after the last one, so the memory
    // has to cover more than the utterance currently in flight.
    const m = memoryOf(ASK_DATES, READBACK);
    expect(m.isEcho('certainly which dates do you need the tripod for')).toBe(true);
  });

  it('rejects an echo of the confirmation sentence', () => {
    expect(memoryOf(DONE).isEcho('done 1 tripod b 14 16 october 2026 your reservation number')).toBe(
      true,
    );
  });
});

describe('real customer speech still gets through', () => {
  it('accepts a booking request', () => {
    expect(memoryOf(ASK_DATES).isEcho('I need a tripod from the 14th to the 16th of October 2026')).toBe(
      false,
    );
  });

  it('accepts a correction spoken over the read-back', () => {
    expect(memoryOf(READBACK).isEcho('actually make it the microphone instead')).toBe(false);
  });

  it('accepts "yes, book it" even though the agent just said "shall I book it"', () => {
    // The whole point of the short-utterance threshold.
    expect(memoryOf(READBACK).isEcho('yes book it')).toBe(false);
  });

  it('accepts a bare yes', () => {
    expect(memoryOf(READBACK).isEcho('yes')).toBe(false);
    expect(memoryOf(READBACK).isEcho('yes confirm')).toBe(false);
  });

  it('accepts an interruption', () => {
    expect(memoryOf(READBACK).isEcho('no wait')).toBe(false);
    expect(memoryOf(READBACK).isEcho('stop')).toBe(false);
  });

  it('accepts a question that shares a couple of words with the agent', () => {
    expect(memoryOf(READBACK).isEcho('is the camera available that week')).toBe(false);
  });

  it('accepts anything when the agent has said nothing', () => {
    expect(new AgentSpeechMemory().isEcho('hello I would like a camera')).toBe(false);
  });
});

describe('scoring details', () => {
  it('normalises punctuation, case and dashes', () => {
    expect(normaliseWords('14–16 October 2026.')).toEqual(['14', '16', 'october', '2026']);
  });

  it('ignores empty input', () => {
    expect(isEchoOf('', ['anything'])).toBe(false);
    expect(isEchoOf('   ', ['anything'])).toBe(false);
  });

  it('needs total overlap for a short utterance but only 70% for a long one', () => {
    const vocab = ['one', 'two', 'three', 'four', 'five'];
    expect(isEchoOf('one two', vocab)).toBe(true); // 2/2
    expect(isEchoOf('one nine', vocab)).toBe(false); // 1/2
    expect(isEchoOf('one two three nine', vocab)).toBe(true); // 3/4 >= 0.7
    expect(isEchoOf('one two nine ten', vocab)).toBe(false); // 2/4 < 0.7
  });

  it('forgets sentences older than the memory window', () => {
    let clock = 1_000_000;
    const m = new AgentSpeechMemory(() => clock);
    m.remember(READBACK);
    expect(m.isEcho('that is available 1 tripod b')).toBe(true);
    clock += 16_000;
    expect(m.isEcho('that is available 1 tripod b')).toBe(false);
  });
});
