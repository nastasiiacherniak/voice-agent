/**
 * Deterministic date parsing. ARCHITECTURE.md §6.2.
 *
 * The model never fills in a missing month or year. This module returns one of
 * three outcomes and the agent is required to ask about `ambiguous` by voice.
 *
 * All relative parsing is anchored to an injectable `now`, so fixtures stay
 * reproducible forever.
 */

export type DayResult =
  | { status: 'resolved'; date: string }
  | { status: 'ambiguous'; reason: string; candidates: string[] }
  | { status: 'invalid'; reason: string }
  | { status: 'duration'; days: number }
  | { status: 'empty' };

export type RangeField = 'start_date' | 'end_date' | 'range';

export type RangeResult =
  | { status: 'resolved'; start: string; end: string }
  | { status: 'ambiguous'; field: RangeField; reason: string; candidates: string[] }
  | { status: 'invalid'; field: RangeField; reason: string };

// ---------------------------------------------------------------- date maths

/** Plain-date arithmetic in UTC so local timezone can never shift a rental day. */
export function toISO(y: number, m: number, d: number): string {
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

export function isRealDate(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

export function parseISO(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y!, (m ?? 1) - 1, d ?? 1));
}

export function isoOf(dt: Date): string {
  return toISO(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}

export function addDays(iso: string, n: number): string {
  const dt = parseISO(iso);
  dt.setUTCDate(dt.getUTCDate() + n);
  return isoOf(dt);
}

/** Inclusive day count: 14th..16th === 3 days. */
export function inclusiveDays(start: string, end: string): number {
  return Math.round((parseISO(end).getTime() - parseISO(start).getTime()) / 86_400_000) + 1;
}

export function eachDay(start: string, end: string): string[] {
  const out: string[] = [];
  for (let d = start; d <= end; d = addDays(d, 1)) out.push(d);
  return out;
}

const LONG_MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

export function humanDate(iso: string): string {
  const dt = parseISO(iso);
  return `${dt.getUTCDate()} ${LONG_MONTHS[dt.getUTCMonth()]} ${dt.getUTCFullYear()}`;
}

/** "14-16 October 2026" / "30 October - 2 November 2026" */
export function humanRange(start: string, end: string): string {
  const a = parseISO(start);
  const b = parseISO(end);
  if (start === end) return humanDate(start);
  if (a.getUTCFullYear() === b.getUTCFullYear() && a.getUTCMonth() === b.getUTCMonth()) {
    return `${a.getUTCDate()}–${b.getUTCDate()} ${LONG_MONTHS[a.getUTCMonth()]} ${a.getUTCFullYear()}`;
  }
  if (a.getUTCFullYear() === b.getUTCFullYear()) {
    return `${a.getUTCDate()} ${LONG_MONTHS[a.getUTCMonth()]} – ${humanDate(end)}`;
  }
  return `${humanDate(start)} – ${humanDate(end)}`;
}

// ------------------------------------------------------------------ lexicons

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8,
  sep: 9, sept: 9, september: 9, oct: 10, october: 10,
  nov: 11, november: 11, dec: 12, december: 12,
};

const WEEKDAYS: Record<string, number> = {
  sunday: 0, sun: 0, monday: 1, mon: 1, tuesday: 2, tue: 2, tues: 2,
  wednesday: 3, wed: 3, thursday: 4, thu: 4, thur: 4, thurs: 4,
  friday: 5, fri: 5, saturday: 6, sat: 6,
};

const ONES: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
  sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30,
};

const WORD_ORDINALS: Record<string, number> = {
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7,
  eighth: 8, ninth: 9, tenth: 10, eleventh: 11, twelfth: 12, thirteenth: 13,
  fourteenth: 14, fifteenth: 15, sixteenth: 16, seventeenth: 17, eighteenth: 18,
  nineteenth: 19, twentieth: 20, 'twenty first': 21, 'twenty second': 22,
  'twenty third': 23, 'twenty fourth': 24, 'twenty fifth': 25, 'twenty sixth': 26,
  'twenty seventh': 27, 'twenty eighth': 28, 'twenty ninth': 29, thirtieth: 30,
  'thirty first': 31,
};

/** Phrases that denote a span rather than a single day - never guessed at. */
const SPAN_PHRASES = [
  'next week', 'this week', 'the week', 'a week', 'next month', 'this month',
  'the weekend', 'next weekend', 'this weekend', 'the summer', 'next year',
];

const RANGE_SEPARATOR = /\s+(?:to|through|thru|till|til|until|up to|-|–|—)\s+/;

function normalise(raw: string): string {
  let s = raw.toLowerCase().trim();
  s = s.replace(/[.,!?;:"']/g, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  // "the 14th of October" -> "the 14th October"; the joiner carries no information
  // and otherwise gets swallowed by the day-of-month capture group.
  s = s.replace(/\s+of\s+/g, ' ');
  // Leading filler that carries no date information.
  s = s.replace(
    /^(?:from|starting|start|starts|on|at|beginning|begin|as of|to|until|till|til|through|thru|up to|ending|ends|end|the day)\s+/,
    '',
  );
  return s.trim();
}

function stripThe(s: string): string {
  return s.replace(/^the\s+/, '').trim();
}

function ordinalToNumber(token: string): number | null {
  const t = token.trim();
  const m = /^(\d{1,2})(?:st|nd|rd|th)?$/.exec(t);
  if (m) return Number(m[1]);
  if (t in WORD_ORDINALS) return WORD_ORDINALS[t]!;
  const hyphen = t.replace(/-/g, ' ');
  if (hyphen in WORD_ORDINALS) return WORD_ORDINALS[hyphen]!;
  return null;
}

function wordToCount(token: string): number | null {
  const t = token.trim();
  if (/^\d{1,3}$/.test(t)) return Number(t);
  if (t in ONES) return ONES[t]!;
  return null;
}

// -------------------------------------------------------------- day resolver

export interface ParseOptions {
  /** ISO yyyy-mm-dd anchor for all relative phrases. */
  now: string;
}

/**
 * Resolve a single spoken day phrase.
 *
 * Deterministic rules, documented in the README:
 *  - bare day-of-month ("the 10th")        -> ambiguous, no month given
 *  - month+day, year omitted, still ahead  -> resolved to the current year
 *  - month+day, year omitted, already gone -> ambiguous (this year vs next)
 *  - ambiguous numeric (3/4/2026)          -> ambiguous, both readings offered
 *  - span phrases ("next week")            -> ambiguous, not a single day
 */
export function resolveDay(phrase: string | null | undefined, opts: ParseOptions): DayResult {
  if (phrase == null) return { status: 'empty' };
  const s0 = normalise(phrase);
  if (!s0) return { status: 'empty' };

  const now = opts.now;
  const nowDt = parseISO(now);
  const nowYear = nowDt.getUTCFullYear();

  // -- duration ("for 3 days", "three nights", "a week")
  const dur =
    /^(?:for\s+)?(?:a|an|([a-z]+))\s*(day|days|night|nights|week|weeks)$/.exec(s0) ??
    /^(?:for\s+)?(\d{1,3})\s*(day|days|night|nights|week|weeks)$/.exec(s0);
  if (dur) {
    const unit = dur[2]!;
    const rawCount = dur[1];
    const n = rawCount ? wordToCount(rawCount) : 1;
    if (n != null && n > 0) {
      const days = unit.startsWith('week') ? n * 7 : n;
      return { status: 'duration', days };
    }
  }

  const s = stripThe(s0);

  // -- span phrases: a week is not a day
  for (const span of SPAN_PHRASES) {
    if (s === span || s === stripThe(span)) {
      return {
        status: 'ambiguous',
        reason: `"${phrase.trim()}" covers a range of days rather than one date`,
        candidates: [],
      };
    }
  }

  // -- ISO
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (iso) {
    const [y, m, d] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
    return isRealDate(y, m, d)
      ? { status: 'resolved', date: toISO(y, m, d) }
      : { status: 'invalid', reason: `${phrase.trim()} is not a real date` };
  }

  // -- relative keywords
  if (s === 'today') return { status: 'resolved', date: now };
  if (s === 'tomorrow' || s === 'tmrw') return { status: 'resolved', date: addDays(now, 1) };
  if (s === 'day after tomorrow') return { status: 'resolved', date: addDays(now, 2) };
  if (s === 'yesterday') return { status: 'invalid', reason: 'that date is in the past' };

  const inDays = /^in\s+([a-z0-9]+)\s+(day|days|week|weeks)$/.exec(s);
  if (inDays) {
    const n = wordToCount(inDays[1]!);
    if (n != null) {
      return { status: 'resolved', date: addDays(now, inDays[2]!.startsWith('week') ? n * 7 : n) };
    }
  }

  // -- weekdays
  const wd = /^(this|next|coming|upcoming)?\s*([a-z]+)$/.exec(s);
  if (wd && wd[2]! in WEEKDAYS) {
    const target = WEEKDAYS[wd[2]!]!;
    const qualifier = wd[1] ?? '';
    let delta = (target - nowDt.getUTCDay() + 7) % 7;
    if (delta === 0) delta = 7; // "Friday" said on a Friday means the next one
    let date = addDays(now, delta);
    // Days remaining in the current Mon-Sun week, counting from tomorrow.
    const daysLeftThisWeek = 6 - ((nowDt.getUTCDay() + 6) % 7);
    if (qualifier === 'next' && delta <= daysLeftThisWeek) {
      date = addDays(date, 7); // "next Friday" means the week after the current one
    }
    return { status: 'resolved', date };
  }

  // -- numeric d/m/y or m/d/y
  const num = /^(\d{1,2})[\/.](\d{1,2})(?:[\/.](\d{2,4}))?$/.exec(s);
  if (num) {
    const a = Number(num[1]);
    const b = Number(num[2]);
    let year = num[3] ? Number(num[3]) : nowYear;
    if (year < 100) year += 2000;
    const dmy = isRealDate(year, b, a) ? toISO(year, b, a) : null;
    const mdy = isRealDate(year, a, b) ? toISO(year, a, b) : null;
    if (dmy && mdy && dmy !== mdy) {
      return {
        status: 'ambiguous',
        reason: `"${phrase.trim()}" could be ${humanDate(dmy)} or ${humanDate(mdy)}`,
        candidates: [dmy, mdy],
      };
    }
    const only = dmy ?? mdy;
    if (only) return { status: 'resolved', date: only };
    return { status: 'invalid', reason: `${phrase.trim()} is not a real date` };
  }

  // -- month name forms
  const monthNames = Object.keys(MONTHS).join('|');
  const mdyRe = new RegExp(`^(${monthNames})\\s+([a-z0-9-]+(?:\\s+[a-z]+)?)(?:\\s+(\\d{4}))?$`);
  const dmyRe = new RegExp(`^([a-z0-9-]+(?:\\s+[a-z]+)?)\\s+(?:of\\s+)?(${monthNames})(?:\\s+(\\d{4}))?$`);

  let month: number | null = null;
  let day: number | null = null;
  let year: number | null = null;

  const m1 = mdyRe.exec(s);
  if (m1) {
    month = MONTHS[m1[1]!]!;
    day = ordinalToNumber(m1[2]!);
    year = m1[3] ? Number(m1[3]) : null;
  } else {
    const m2 = dmyRe.exec(s);
    if (m2) {
      day = ordinalToNumber(m2[1]!);
      month = MONTHS[m2[2]!]!;
      year = m2[3] ? Number(m2[3]) : null;
    }
  }

  if (month != null && day != null) {
    if (year != null) {
      return isRealDate(year, month, day)
        ? { status: 'resolved', date: toISO(year, month, day) }
        : { status: 'invalid', reason: `${phrase.trim()} is not a real date` };
    }
    // Year omitted. Resolve only when this year's occurrence is still ahead.
    const thisYear = isRealDate(nowYear, month, day) ? toISO(nowYear, month, day) : null;
    const nextYear = isRealDate(nowYear + 1, month, day) ? toISO(nowYear + 1, month, day) : null;
    if (thisYear && thisYear >= now) return { status: 'resolved', date: thisYear };
    if (thisYear && nextYear) {
      return {
        status: 'ambiguous',
        reason: `${humanDate(thisYear)} has already passed`,
        candidates: [nextYear, thisYear],
      };
    }
    if (nextYear) return { status: 'resolved', date: nextYear };
    return { status: 'invalid', reason: `${phrase.trim()} is not a real date` };
  }

  // -- bare day of month: never guess the month
  const bare = ordinalToNumber(s);
  if (bare != null && bare >= 1 && bare <= 31) {
    const nowMonth = nowDt.getUTCMonth() + 1;
    const cands: string[] = [];
    for (let k = 0; k < 4 && cands.length < 2; k++) {
      const y = nowYear + Math.floor((nowMonth - 1 + k) / 12);
      const mo = ((nowMonth - 1 + k) % 12) + 1;
      if (isRealDate(y, mo, bare)) {
        const c = toISO(y, mo, bare);
        if (c >= now) cands.push(c);
      }
    }
    return {
      status: 'ambiguous',
      reason: `"${phrase.trim()}" does not say which month`,
      candidates: cands,
    };
  }

  return { status: 'invalid', reason: `I could not read "${phrase.trim()}" as a date` };
}

// ------------------------------------------------------------ range resolver

export const MAX_RENTAL_DAYS = 90;

/** The day number when a phrase is nothing but a day of the month, else null. */
function bareDayOf(phrase: string): number | null {
  const n = ordinalToNumber(stripThe(normalise(phrase)));
  return n != null && n >= 1 && n <= 31 ? n : null;
}

/**
 * Resolve a start/end pair. An empty end phrase means a single-day rental.
 * A bare day-of-month in the *end* phrase is anchored to the start date's
 * month - arithmetic on a known anchor, not a guess about the month.
 */
export function resolveRange(
  startPhrase: string | null | undefined,
  endPhrase: string | null | undefined,
  opts: ParseOptions,
): RangeResult {
  let sp = startPhrase ?? '';
  let ep = endPhrase ?? '';

  // Defensive: the whole range arrived in one field ("14th to the 16th").
  if (!normalise(ep) && RANGE_SEPARATOR.test(normalise(sp))) {
    const parts = normalise(sp).split(RANGE_SEPARATOR);
    if (parts.length === 2) {
      sp = parts[0]!;
      ep = parts[1]!;
    }
  }

  let start = resolveDay(sp, opts);

  // "the 14th to the 16th of October": the month is stated once, at the end.
  // Anchoring the start to it is arithmetic on a known date, not a guess.
  if (start.status === 'ambiguous' && bareDayOf(sp) != null) {
    const endStandalone = resolveDay(ep, opts);
    if (endStandalone.status === 'resolved') {
      const day = bareDayOf(sp)!;
      const edt = parseISO(endStandalone.date);
      let y = edt.getUTCFullYear();
      let mo = edt.getUTCMonth() + 1;
      for (let k = 0; k < 13; k++) {
        if (isRealDate(y, mo, day)) {
          const c = toISO(y, mo, day);
          if (c <= endStandalone.date) {
            start = { status: 'resolved', date: c };
            break;
          }
        }
        mo -= 1;
        if (mo < 1) {
          mo = 12;
          y -= 1;
        }
      }
    }
  }

  if (start.status === 'empty') {
    return { status: 'ambiguous', field: 'start_date', reason: 'no start date given', candidates: [] };
  }
  if (start.status === 'duration') {
    return {
      status: 'ambiguous',
      field: 'start_date',
      reason: 'a length of time is not a start date',
      candidates: [],
    };
  }
  if (start.status === 'ambiguous') {
    return { status: 'ambiguous', field: 'start_date', reason: start.reason, candidates: start.candidates };
  }
  if (start.status === 'invalid') {
    return { status: 'invalid', field: 'start_date', reason: start.reason };
  }

  const end = resolveDay(ep, opts);
  let endDate: string;

  switch (end.status) {
    case 'empty':
      endDate = start.date; // single-day rental
      break;
    case 'duration':
      endDate = addDays(start.date, end.days - 1); // inclusive
      break;
    case 'resolved':
      endDate = end.date;
      break;
    case 'invalid':
      return { status: 'invalid', field: 'end_date', reason: end.reason };
    case 'ambiguous': {
      // A bare day-of-month can be anchored to the start month deterministically.
      const bare = ordinalToNumber(stripThe(normalise(ep)));
      if (bare != null && bare >= 1 && bare <= 31) {
        const sdt = parseISO(start.date);
        let y = sdt.getUTCFullYear();
        let mo = sdt.getUTCMonth() + 1;
        let anchored: string | null = null;
        for (let k = 0; k < 13; k++) {
          if (isRealDate(y, mo, bare)) {
            const c = toISO(y, mo, bare);
            if (c >= start.date) {
              anchored = c;
              break;
            }
          }
          mo += 1;
          if (mo > 12) {
            mo = 1;
            y += 1;
          }
        }
        if (anchored) {
          endDate = anchored;
          break;
        }
      }
      return { status: 'ambiguous', field: 'end_date', reason: end.reason, candidates: end.candidates };
    }
  }

  if (endDate < start.date) {
    return {
      status: 'invalid',
      field: 'range',
      reason: `the end date ${humanDate(endDate)} is before the start date ${humanDate(start.date)}`,
    };
  }
  if (inclusiveDays(start.date, endDate) > MAX_RENTAL_DAYS) {
    return {
      status: 'invalid',
      field: 'range',
      reason: `rentals are limited to ${MAX_RENTAL_DAYS} days`,
    };
  }

  return { status: 'resolved', start: start.date, end: endDate };
}
