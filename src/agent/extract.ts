/**
 * Slot extraction from free speech.
 *
 * Used by the deterministic planner, and by the pipeline to notice that a
 * barge-in carried a correction. It finds the *phrases*, it does not resolve
 * them - resolution stays in booking/dates.ts.
 */

const MONTH_WORDS = [
  'jan', 'january', 'feb', 'february', 'mar', 'march', 'apr', 'april', 'may',
  'jun', 'june', 'jul', 'july', 'aug', 'august', 'sep', 'sept', 'september',
  'oct', 'october', 'nov', 'november', 'dec', 'december',
];

const WEEKDAY_WORDS = [
  'monday', 'mon', 'tuesday', 'tue', 'tues', 'wednesday', 'wed', 'thursday',
  'thu', 'thur', 'thurs', 'friday', 'fri', 'saturday', 'sat', 'sunday', 'sun',
];

const RELATIVE_WORDS = ['today', 'tomorrow', 'tmrw', 'yesterday'];

const WORD_ORDINAL_WORDS = [
  'first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth',
  'ninth', 'tenth', 'eleventh', 'twelfth', 'thirteenth', 'fourteenth',
  'fifteenth', 'sixteenth', 'seventeenth', 'eighteenth', 'nineteenth',
  'twentieth', 'thirtieth', 'twenty', 'thirty',
];

/** Tokens that only make sense attached to a date. */
const GLUE_WORDS = ['the', 'of', 'next', 'this', 'coming', 'upcoming'];

const SEPARATOR_WORDS = ['to', 'until', 'till', 'til', 'through', 'thru', 'and', 'upto'];
const START_MARKERS = ['from', 'starting', 'start', 'starts', 'on', 'beginning', 'begins'];
const END_MARKERS = ['to', 'until', 'till', 'til', 'through', 'thru', 'ending', 'ends'];

const NUMBER_WORDS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10,
};

export const CORRECTION_MARKERS = [
  'actually', 'instead', 'change', 'rather', 'make it', 'no wait', 'sorry',
  'scratch that', 'never mind', 'nevermind', 'i meant', 'lets say', "let's say",
  'switch', 'move it',
];

export interface Extracted {
  equipmentPhrase: string | null;
  quantity: number | null;
  startPhrase: string | null;
  endPhrase: string | null;
  /** True when the utterance only moved the end date ("make it until the 20th"). */
  endOnly: boolean;
  /** A month named with no day, e.g. answering "which month?" with "October". */
  loneMonth: string | null;
  isCorrection: boolean;
}

interface Token {
  text: string;
  start: number;
  end: number;
}

function tokenize(text: string): Token[] {
  const out: Token[] = [];
  const re = /[a-z0-9]+(?:[/.\-][a-z0-9]+)*(?:'[a-z]+)?/g;
  let m: RegExpExecArray | null;
  const lower = text.toLowerCase();
  while ((m = re.exec(lower)) !== null) {
    out.push({ text: m[0], start: m.index, end: m.index + m[0].length });
  }
  return out;
}

function isNumericDate(t: string): boolean {
  return /^\d{1,4}[/.\-]\d{1,2}(?:[/.\-]\d{2,4})?$/.test(t);
}

function isDayNumber(t: string): boolean {
  return /^\d{1,2}(?:st|nd|rd|th)?$/.test(t) && Number(t.replace(/\D/g, '')) >= 1 &&
    Number(t.replace(/\D/g, '')) <= 31;
}

function isYear(t: string): boolean {
  return /^\d{4}$/.test(t) && Number(t) >= 2000 && Number(t) <= 2100;
}

/** A token that can anchor a date span on its own. */
function isCoreDateToken(t: string): boolean {
  return (
    MONTH_WORDS.includes(t) ||
    WEEKDAY_WORDS.includes(t) ||
    RELATIVE_WORDS.includes(t) ||
    WORD_ORDINAL_WORDS.includes(t) ||
    isNumericDate(t) ||
    isDayNumber(t) ||
    isYear(t)
  );
}

function isDateToken(t: string): boolean {
  return isCoreDateToken(t) || GLUE_WORDS.includes(t);
}

interface Span {
  phrase: string;
  firstToken: number;
  lastToken: number;
}

/** Maximal runs of date-ish tokens, trimmed of leading and trailing glue. */
function dateSpans(tokens: Token[], skip: Set<number>): Span[] {
  const spans: Span[] = [];
  let i = 0;
  while (i < tokens.length) {
    if (skip.has(i) || !isDateToken(tokens[i]!.text)) {
      i++;
      continue;
    }
    let j = i;
    while (j + 1 < tokens.length && !skip.has(j + 1) && isDateToken(tokens[j + 1]!.text)) j++;

    let a = i;
    let b = j;
    while (a <= b && GLUE_WORDS.includes(tokens[a]!.text) && !isCoreDateToken(tokens[a]!.text)) a++;
    while (b >= a && GLUE_WORDS.includes(tokens[b]!.text) && !isCoreDateToken(tokens[b]!.text)) b--;

    if (a <= b && tokens.slice(a, b + 1).some((t) => isCoreDateToken(t.text))) {
      spans.push({
        phrase: tokens.slice(a, b + 1).map((t) => t.text).join(' '),
        firstToken: a,
        lastToken: b,
      });
    }
    i = j + 1;
  }
  return spans;
}

const EQUIPMENT_WORDS: Array<{ re: RegExp; label: string }> = [
  { re: /\b(cameras?|cams?)\b/g, label: 'camera_a' },
  { re: /\b(tripods?|stands?)\b/g, label: 'tripod_b' },
  { re: /\b(microphones?|mics?|mikes?)\b/g, label: 'mic_c' },
];

interface Mention {
  label: string;
  index: number;
  text: string;
}

function equipmentMentions(lower: string): Mention[] {
  const out: Mention[] = [];
  for (const { re, label } of EQUIPMENT_WORDS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(lower)) !== null) out.push({ label, index: m.index, text: m[0] });
  }
  return out.sort((a, b) => a.index - b.index);
}

export function hasCorrectionMarker(text: string): boolean {
  const s = text.toLowerCase();
  return CORRECTION_MARKERS.some((m) => s.includes(m));
}

export function extractSlots(text: string): Extracted {
  const lower = text.toLowerCase();
  const tokens = tokenize(text);
  const isCorrection = hasCorrectionMarker(text);

  // ---- quantity, and the tokens it consumes so they are not read as dates
  const skip = new Set<number>();
  let quantity: number | null = null;

  const qtyRe =
    /\b(\d{1,2}|a|an|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:of\s+(?:the\s+)?)?(cameras?|cams?|tripods?|stands?|microphones?|mics?|mikes?)\b/;
  const qtyMatch = qtyRe.exec(lower);
  if (qtyMatch) {
    const raw = qtyMatch[1]!;
    quantity = /^\d+$/.test(raw) ? Number(raw) : (NUMBER_WORDS[raw] ?? null);
    const at = tokens.findIndex((t) => t.start === qtyMatch.index);
    if (at >= 0) skip.add(at);
  }

  // ---- duration ("for three days")
  let endPhrase: string | null = null;
  const durRe = /\b(?:for\s+)?(\d{1,3}|a|an|one|two|three|four|five|six|seven|eight|nine|ten)\s+(days?|nights?|weeks?)\b/;
  const durMatch = durRe.exec(lower);
  if (durMatch) {
    endPhrase = `for ${durMatch[1]} ${durMatch[2]}`;
    for (const [idx, t] of tokens.entries()) {
      if (t.start >= durMatch.index && t.end <= durMatch.index + durMatch[0].length) skip.add(idx);
    }
  }

  // ---- date spans
  const spans = dateSpans(tokens, skip);
  let startPhrase: string | null = null;
  let endOnly = false;

  if (spans.length >= 2) {
    const between = tokens
      .slice(spans[0]!.lastToken + 1, spans[1]!.firstToken)
      .map((t) => t.text);
    const looksLikeRange = between.length === 0 || between.every((w) => SEPARATOR_WORDS.includes(w));
    startPhrase = spans[0]!.phrase;
    endPhrase = looksLikeRange || endPhrase === null ? spans[1]!.phrase : endPhrase;
  } else if (spans.length === 1) {
    const span = spans[0]!;
    const preceding = span.firstToken > 0 ? tokens[span.firstToken - 1]!.text : '';
    if (END_MARKERS.includes(preceding) && !START_MARKERS.includes(preceding)) {
      endPhrase = span.phrase;
      endOnly = true;
    } else {
      startPhrase = span.phrase;
    }
  }

  // ---- a month named on its own, answering "which month?"
  let loneMonth: string | null = null;
  if (!startPhrase && !endPhrase) {
    const monthOnly = tokens.filter((t) => MONTH_WORDS.includes(t.text));
    if (monthOnly.length === 1) loneMonth = monthOnly[0]!.text;
  } else if (startPhrase && MONTH_WORDS.includes(startPhrase.split(' ')[0] ?? '')) {
    // "October" plus a year and nothing else is still only a month.
    const parts = startPhrase.split(' ');
    const hasDay = parts.some((p) => isDayNumber(p) || WORD_ORDINAL_WORDS.includes(p));
    if (!hasDay) {
      loneMonth = startPhrase;
      startPhrase = null;
    }
  }

  // ---- equipment: on a correction, the item named after the marker wins
  const mentions = equipmentMentions(lower);
  let equipmentPhrase: string | null = null;
  if (mentions.length === 1) {
    equipmentPhrase = mentions[0]!.text;
  } else if (mentions.length > 1) {
    const unique = new Set(mentions.map((m) => m.label));
    if (unique.size === 1) {
      equipmentPhrase = mentions[0]!.text;
    } else {
      const markerAt = CORRECTION_MARKERS.map((m) => lower.indexOf(m)).filter((i) => i >= 0);
      const after = markerAt.length ? Math.min(...markerAt) : -1;
      const chosen = after >= 0 ? mentions.find((m) => m.index > after) : undefined;
      equipmentPhrase = chosen ? chosen.text : mentions.map((m) => m.text).join(' and ');
    }
  }

  return { equipmentPhrase, quantity, startPhrase, endPhrase, endOnly, loneMonth, isCorrection };
}
