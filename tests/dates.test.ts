import { describe, expect, it } from 'vitest';
import {
  addDays,
  humanRange,
  inclusiveDays,
  resolveDay,
  resolveRange,
} from '../src/booking/dates.js';

/** Fixed anchor so these assertions hold forever. Tuesday. */
const NOW = { now: '2026-09-15' };

describe('resolveDay - unambiguous forms', () => {
  it.each([
    ['October 14 2026', '2026-10-14'],
    ['14 October 2026', '2026-10-14'],
    ['the 14th of October 2026', '2026-10-14'],
    ['Oct 14th 2026', '2026-10-14'],
    ['2026-10-14', '2026-10-14'],
    ['October 14', '2026-10-14'],
    ['the fourteenth of October', '2026-10-14'],
    ['the twenty third of October', '2026-10-23'],
    ['today', '2026-09-15'],
    ['tomorrow', '2026-09-16'],
    ['in three days', '2026-09-18'],
  ])('%s -> %s', (phrase, expected) => {
    expect(resolveDay(phrase, NOW)).toEqual({ status: 'resolved', date: expected });
  });

  it('resolves a bare weekday to the next occurrence', () => {
    expect(resolveDay('Friday', NOW)).toEqual({ status: 'resolved', date: '2026-09-18' });
  });

  it('reads "next Friday" as the week after the current one', () => {
    expect(resolveDay('next Friday', NOW)).toEqual({ status: 'resolved', date: '2026-09-25' });
  });

  it('reads a weekday named on that same weekday as the following one', () => {
    expect(resolveDay('Tuesday', NOW)).toEqual({ status: 'resolved', date: '2026-09-22' });
  });

  it('resolves an unambiguous numeric date', () => {
    expect(resolveDay('14/10/2026', NOW)).toEqual({ status: 'resolved', date: '2026-10-14' });
  });
});

describe('resolveDay - ambiguity is never guessed away', () => {
  it('refuses a bare day of month', () => {
    const r = resolveDay('the tenth', NOW);
    expect(r.status).toBe('ambiguous');
    if (r.status === 'ambiguous') {
      expect(r.reason).toMatch(/which month/);
      expect(r.candidates).toEqual(['2026-10-10', '2026-11-10']);
    }
  });

  it('refuses "the 10th" with a numeral just the same', () => {
    expect(resolveDay('the 10th', NOW).status).toBe('ambiguous');
  });

  it('refuses a day/month pair that reads both ways', () => {
    const r = resolveDay('3/4/2026', NOW);
    expect(r.status).toBe('ambiguous');
    if (r.status === 'ambiguous') expect(r.candidates).toEqual(['2026-04-03', '2026-03-04']);
  });

  it('refuses a month+day that has already passed this year', () => {
    const r = resolveDay('March 3', NOW);
    expect(r.status).toBe('ambiguous');
    if (r.status === 'ambiguous') expect(r.candidates[0]).toBe('2027-03-03');
  });

  it('refuses a span phrase as a single day', () => {
    expect(resolveDay('next week', NOW).status).toBe('ambiguous');
    expect(resolveDay('the weekend', NOW).status).toBe('ambiguous');
  });

  it('rejects an unreadable phrase', () => {
    expect(resolveDay('sometime soonish', NOW).status).toBe('invalid');
  });

  it('rejects a date that is not on the calendar', () => {
    expect(resolveDay('31 February 2026', NOW).status).toBe('invalid');
  });
});

describe('resolveDay - durations', () => {
  it.each([
    ['for 3 days', 3],
    ['three days', 3],
    ['for two nights', 2],
    ['a week', 7],
  ])('%s -> %d days', (phrase, days) => {
    expect(resolveDay(phrase, NOW)).toEqual({ status: 'duration', days });
  });
});

describe('resolveRange', () => {
  it('resolves a normal range', () => {
    expect(resolveRange('14 October 2026', '16 October 2026', NOW)).toEqual({
      status: 'resolved',
      start: '2026-10-14',
      end: '2026-10-16',
    });
  });

  it('anchors a bare end day to the start month', () => {
    expect(resolveRange('14 October 2026', 'the 16th', NOW)).toEqual({
      status: 'resolved',
      start: '2026-10-14',
      end: '2026-10-16',
    });
  });

  it('rolls a bare end day into the next month when it precedes the start', () => {
    expect(resolveRange('30 October 2026', 'the 2nd', NOW)).toEqual({
      status: 'resolved',
      start: '2026-10-30',
      end: '2026-11-02',
    });
  });

  it('treats an empty end phrase as a single-day rental', () => {
    expect(resolveRange('14 October 2026', '', NOW)).toEqual({
      status: 'resolved',
      start: '2026-10-14',
      end: '2026-10-14',
    });
  });

  it('applies a duration end phrase inclusively', () => {
    expect(resolveRange('14 October 2026', 'for 3 days', NOW)).toEqual({
      status: 'resolved',
      start: '2026-10-14',
      end: '2026-10-16',
    });
  });

  it('splits a range that arrived in the start field alone', () => {
    expect(resolveRange('14 October 2026 to 16 October 2026', '', NOW)).toEqual({
      status: 'resolved',
      start: '2026-10-14',
      end: '2026-10-16',
    });
  });

  it('propagates start ambiguity with the field named', () => {
    const r = resolveRange('the tenth', 'the twelfth', NOW);
    expect(r.status).toBe('ambiguous');
    if (r.status === 'ambiguous') expect(r.field).toBe('start_date');
  });

  it('rejects an end before the start', () => {
    const r = resolveRange('16 October 2026', '14 October 2026', NOW);
    expect(r.status).toBe('invalid');
    if (r.status === 'invalid') expect(r.field).toBe('range');
  });

  it('rejects a rental longer than 90 days', () => {
    const r = resolveRange('1 October 2026', '1 March 2027', NOW);
    expect(r.status).toBe('invalid');
  });
});

describe('date maths', () => {
  it('counts inclusive days', () => {
    expect(inclusiveDays('2026-10-14', '2026-10-16')).toBe(3);
    expect(inclusiveDays('2026-10-14', '2026-10-14')).toBe(1);
  });

  it('crosses month and year boundaries', () => {
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
  });

  it('formats ranges for speech', () => {
    expect(humanRange('2026-10-14', '2026-10-16')).toBe('14–16 October 2026');
    expect(humanRange('2026-10-14', '2026-10-14')).toBe('14 October 2026');
    expect(humanRange('2026-10-30', '2026-11-02')).toBe('30 October – 2 November 2026');
  });
});

describe('month stated once, at the end of the range', () => {
  it('anchors a bare start day to an explicit end month', () => {
    expect(resolveRange('the 14th', 'the 16th of October 2026', NOW)).toEqual({
      status: 'resolved',
      start: '2026-10-14',
      end: '2026-10-16',
    });
  });

  it('rolls back a month when the start day is after the end day', () => {
    expect(resolveRange('the 30th', 'the 2nd of November 2026', NOW)).toEqual({
      status: 'resolved',
      start: '2026-10-30',
      end: '2026-11-02',
    });
  });

  it('still refuses a bare day with no end date to anchor to', () => {
    expect(resolveRange('the tenth', '', NOW).status).toBe('ambiguous');
  });
});
