/**
 * Echo rejection scoring.
 *
 * The microphone hears the agent's own voice through the speakers and the
 * recogniser transcribes it as if the customer had spoken. Without acoustic
 * echo cancellation the only signal available is the text itself, so this
 * scores a candidate transcript against what the agent said recently.
 *
 * Pure functions, no DOM, so they can be unit-tested. See echo.test.ts.
 */

/** Fraction of the candidate's words that must be the agent's for a long phrase. */
export const ECHO_OVERLAP = 0.7;

/** How long playback stays "possibly audible" after it stops, for the tail. */
export const ECHO_TAIL_MS = 900;

/** How long a spoken sentence stays in the comparison window. */
export const ECHO_MEMORY_MS = 15000;

export function normaliseWords(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
}

/**
 * Does `candidate` look like the agent hearing itself?
 *
 * Scored on word overlap against every sentence spoken recently, not on an
 * exact substring of the sentence currently in flight: the recogniser drops
 * punctuation, mishears words and splits phrases across events, so a literal
 * match almost never holds even for pure echo.
 *
 * A short utterance must match completely. The agent's read-back ends
 * "Shall I book it?", so a bare "book it" overlaps entirely by coincidence -
 * but "yes, book it" carries a word the agent never said and gets through.
 *
 * @param {string} candidate       newly heard text
 * @param {Iterable<string>} spoken every word the agent said recently
 */
export function isEchoOf(candidate, spoken) {
  const words = normaliseWords(candidate);
  if (words.length === 0) return false;

  const vocabulary = spoken instanceof Set ? spoken : new Set(spoken);
  if (vocabulary.size === 0) return false;

  const hits = words.filter((w) => vocabulary.has(w)).length;
  const threshold = words.length >= 4 ? ECHO_OVERLAP : 1;
  return hits / words.length >= threshold;
}

/**
 * Rolling memory of what the agent has said, so echo arriving between
 * sentences - or after the last one - is still recognised.
 */
export class AgentSpeechMemory {
  constructor(now = () => Date.now()) {
    this.now = now;
    this.entries = [];
  }

  remember(text) {
    const at = this.now();
    this.entries = this.entries.filter((e) => at - e.at < ECHO_MEMORY_MS);
    this.entries.push({ words: normaliseWords(text), at });
  }

  /** Every word still inside the memory window. */
  vocabulary() {
    const at = this.now();
    const out = new Set();
    for (const entry of this.entries) {
      if (at - entry.at >= ECHO_MEMORY_MS) continue;
      for (const w of entry.words) out.add(w);
    }
    return out;
  }

  isEcho(candidate) {
    return isEchoOf(candidate, this.vocabulary());
  }

  clear() {
    this.entries = [];
  }
}
