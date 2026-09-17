import { describe, expect, it } from 'vitest';
import { classifyConfirmation, ConversationState } from '../src/state.js';
import { harness } from './helpers.js';

describe('explicit confirmation - positives', () => {
  it.each([
    'yes',
    'Yes.',
    'yes please',
    'yeah',
    'yep',
    'confirm',
    'confirm it',
    'yes, confirm',
    'book it',
    'go ahead',
    "that's right, go ahead",
    'correct',
    'do it',
    'sure, book it',
  ])('%s confirms', (text) => {
    expect(classifyConfirmation(text).isConfirmation).toBe(true);
  });
});

describe('explicit confirmation - near misses that must not write a row', () => {
  it.each([
    ['', 'empty'],
    ['   ', 'empty'],
    ['yeah but can we change the dates', 'contains_change'],
    ['yes, but make it three days', 'contains_change'],
    ['yes actually make it two cameras', 'contains_change'],
    ['no', 'contains_change'],
    ['not yet', 'contains_change'],
    ['hold on', 'contains_change'],
    ['wait', 'contains_change'],
    ['sounds good', 'too_weak'],
    ['ok', 'too_weak'],
    ['okay great', 'too_weak'],
    ['what are the dates again', 'no_affirmative'],
    ['how much is it', 'no_affirmative'],
  ])('%s does not confirm (%s)', (text, reason) => {
    const v = classifyConfirmation(text);
    expect(v.isConfirmation).toBe(false);
    expect(v.reason).toBe(reason);
  });

  it('refuses a long utterance that merely contains yes', () => {
    const v = classifyConfirmation(
      'yes I was thinking about the camera and maybe a tripod as well for the weekend',
    );
    expect(v.isConfirmation).toBe(false);
  });
});

describe('only held can become confirmed', () => {
  it('refuses a confirmation from gathering', () => {
    const s = new ConversationState('c1');
    s.onUserTurn();
    expect(s.guardToolCall('confirm_booking', { hold_token: 'x' }).allowed).toBe(false);
  });

  it('refuses a confirmation while a clarification is outstanding', () => {
    const s = new ConversationState('c1');
    s.onUserTurn();
    s.onAvailabilityResult({ status: 'needs_clarification', field: 'start_date', reason: 'no month' });
    expect(s.state).toBe('clarifying');
    const g = s.guardToolCall('confirm_booking', { hold_token: 'x' });
    expect(g.allowed).toBe(false);
    if (!g.allowed) expect(g.reason).toMatch(/unclear/);
  });

  it('refuses a confirmation after an unavailable check', () => {
    const s = new ConversationState('c1');
    s.onUserTurn();
    s.onAvailabilityResult({ status: 'unavailable', shortfall: 1 });
    expect(s.state).toBe('gathering');
    expect(s.held).toBeNull();
    expect(s.guardToolCall('confirm_booking', { hold_token: 'x' }).allowed).toBe(false);
  });
});

describe('slot changes drop the previous hold', () => {
  it('holds at most one token at a time', async () => {
    const h = harness();
    const first = (await h.runner.run('check_availability', {
      equipment: 'tripod_b',
      start_date_phrase: '14 October 2026',
      end_date_phrase: '16 October 2026',
      quantity: 1,
    })) as Record<string, unknown>;
    expect(h.state.held?.hold_token).toBe(first.hold_token);

    const second = (await h.runner.run('check_availability', {
      equipment: 'tripod_b',
      start_date_phrase: '20 October 2026',
      end_date_phrase: '22 October 2026',
      quantity: 1,
    })) as Record<string, unknown>;

    expect(h.state.held?.hold_token).toBe(second.hold_token);
    expect(h.state.guardToolCall('confirm_booking', { hold_token: first.hold_token }).allowed).toBe(
      false,
    );
  });
});

describe('barge-in', () => {
  it('bumps the turn id so an in-flight tool result can be dropped', () => {
    const s = new ConversationState('c1');
    s.onUserTurn();
    const before = s.turnId;
    s.onBargeIn('actually make it a microphone');
    expect(s.turnId).toBe(before + 1);
  });

  it('discards the hold when the interruption changes the request', () => {
    const s = new ConversationState('c1');
    s.onUserTurn();
    s.onAvailabilityResult({
      status: 'available',
      hold_token: 'tok',
      equipment: 'tripod_b',
      display_name: 'Tripod B',
      start_date: '2026-10-14',
      end_date: '2026-10-16',
      quantity: 1,
    });
    expect(s.state).toBe('held');

    const r = s.onBargeIn('actually make it the microphone');
    expect(r.tokenKept).toBe(false);
    expect(s.held).toBeNull();
    expect(s.state).toBe('gathering');
  });

  it('keeps the hold when the interruption is itself an explicit yes', () => {
    const s = new ConversationState('c1');
    s.onUserTurn();
    s.onAvailabilityResult({
      status: 'available',
      hold_token: 'tok',
      equipment: 'tripod_b',
      display_name: 'Tripod B',
      start_date: '2026-10-14',
      end_date: '2026-10-16',
      quantity: 1,
    });
    const r = s.onBargeIn('yes, confirm');
    expect(r.tokenKept).toBe(true);
    expect(s.state).toBe('held');
  });
});

describe('stale tool results are discarded', () => {
  it('drops a check that lands after the user interrupted', async () => {
    const h = harness();
    const turnAtDispatch = h.runner.turnId;

    // The user cuts in while this check is in flight.
    h.state.onBargeIn('actually, the microphone instead');
    h.runner.turnId = h.state.turnId;

    const r = (await h.runner.run(
      'check_availability',
      {
        equipment: 'tripod_b',
        start_date_phrase: '14 October 2026',
        end_date_phrase: '16 October 2026',
        quantity: 1,
      },
      turnAtDispatch,
    )) as Record<string, unknown>;

    expect(r.status).toBe('discarded');
    expect(h.state.held).toBeNull();
    expect(h.runner.log.at(-1)?.discarded).toBe(true);
    expect(h.runner.orderedCalls).toHaveLength(0);
  });
});

describe('audio-only barge-in defers the hold decision', () => {
  function heldState() {
    const s = new ConversationState('c1');
    s.onUserTurn();
    s.onAvailabilityResult({
      status: 'available',
      hold_token: 'tok',
      equipment: 'tripod_b',
      display_name: 'Tripod B',
      start_date: '2026-10-14',
      end_date: '2026-10-16',
      quantity: 1,
    });
    return s;
  }

  it('keeps the hold until the words arrive', () => {
    // The recogniser is off while the agent speaks, so the detector only knows
    // that someone started talking - not what they said.
    const s = heldState();
    const r = s.onBargeIn();
    expect(r.tokenKept).toBe(true);
    expect(s.pendingBargeIn).toBe(true);
    expect(s.state).toBe('held');
  });

  it('still bumps the turn id so stale tool results are dropped', () => {
    const s = heldState();
    const before = s.turnId;
    s.onBargeIn();
    expect(s.turnId).toBe(before + 1);
  });

  it('drops the hold once the words turn out to be a change', () => {
    const s = heldState();
    s.onBargeIn();
    s.resolvePendingBargeIn('actually make it the microphone');
    expect(s.held).toBeNull();
    expect(s.state).toBe('gathering');
    expect(s.pendingBargeIn).toBe(false);
  });

  it('keeps the hold when the words are an explicit confirmation', () => {
    const s = heldState();
    s.onBargeIn();
    s.resolvePendingBargeIn('yes, confirm');
    expect(s.held).not.toBeNull();
    expect(s.state).toBe('held');
  });

  it('does nothing when no interruption is outstanding', () => {
    const s = heldState();
    s.resolvePendingBargeIn('anything at all');
    expect(s.held).not.toBeNull();
  });
});
