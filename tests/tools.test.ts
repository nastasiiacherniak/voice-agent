/**
 * Gate behaviour, no audio. Acceptance criteria 1, 2, 3 and 5 are provable at
 * this layer with no microphone involved. ARCHITECTURE.md §15 step 2.
 */
import { describe, expect, it } from 'vitest';
import { harness, NOW } from './helpers.js';
import { HoldTokenMinter } from '../src/booking/tokens.js';

describe('check_availability', () => {
  it('mints a token when the item is free', async () => {
    const h = harness();
    const r = (await h.runner.run('check_availability', {
      equipment: 'tripod_b',
      start_date_phrase: '14 October 2026',
      end_date_phrase: '16 October 2026',
      quantity: 1,
    })) as Record<string, unknown>;

    expect(r.status).toBe('available');
    expect(typeof r.hold_token).toBe('string');
    expect(r.start_date).toBe('2026-10-14');
    expect(r.end_date).toBe('2026-10-16');
    expect(h.state.state).toBe('held');
  });

  it('mints no token when the item is short - criterion 3', async () => {
    const h = harness();
    const r = (await h.runner.run('check_availability', {
      equipment: 'camera_a',
      start_date_phrase: '11 October 2026',
      end_date_phrase: '13 October 2026',
      quantity: 2,
    })) as Record<string, unknown>;

    expect(r.status).toBe('unavailable');
    expect(r.hold_token).toBeUndefined();
    expect(h.state.held).toBeNull();
    expect(h.state.state).toBe('gathering');
  });

  it('asks rather than guessing an unstated month - criterion 6', async () => {
    const h = harness();
    const r = (await h.runner.run('check_availability', {
      equipment: 'camera_a',
      start_date_phrase: 'the tenth',
      end_date_phrase: '',
    })) as Record<string, unknown>;

    expect(r.status).toBe('needs_clarification');
    expect(r.field).toBe('start_date');
    expect(r.hold_token).toBeUndefined();
    expect(h.state.state).toBe('clarifying');
  });

  it('asks about an item it does not stock', async () => {
    const h = harness();
    const r = (await h.runner.run('check_availability', {
      equipment: 'drone',
      start_date_phrase: '14 October 2026',
      end_date_phrase: '16 October 2026',
    })) as Record<string, unknown>;
    expect(r.status).toBe('needs_clarification');
    expect(r.field).toBe('equipment');
  });

  it('defaults a missing quantity to one', async () => {
    const h = harness();
    const r = (await h.runner.run('check_availability', {
      equipment: 'mic_c',
      start_date_phrase: '20 October 2026',
      end_date_phrase: '21 October 2026',
    })) as Record<string, unknown>;
    expect(r.quantity).toBe(1);
  });
});

describe('propose_booking reads back from the token, not from memory', () => {
  it('renders the held booking', async () => {
    const h = harness();
    const check = (await h.runner.run('check_availability', {
      equipment: 'tripod_b',
      start_date_phrase: '14 October 2026',
      end_date_phrase: '16 October 2026',
      quantity: 2,
    })) as Record<string, unknown>;

    const p = (await h.runner.run('propose_booking', {
      hold_token: check.hold_token,
    })) as Record<string, unknown>;

    expect(p.status).toBe('ready');
    expect(p.readback).toBe('2 Tripod Bs, 14–16 October 2026');
    expect(h.rows()).toHaveLength(1); // still only the seed - no write
  });
});

describe('confirm_booking', () => {
  it('writes exactly one row - criterion 1', async () => {
    const h = harness();
    const before = h.rows();
    const check = (await h.runner.run('check_availability', {
      equipment: 'tripod_b',
      start_date_phrase: '14 October 2026',
      end_date_phrase: '16 October 2026',
      quantity: 1,
    })) as Record<string, unknown>;
    await h.runner.run('propose_booking', { hold_token: check.hold_token });
    const c = (await h.runner.run('confirm_booking', {
      hold_token: check.hold_token,
    })) as Record<string, unknown>;

    expect(c.status).toBe('confirmed');
    expect(c.created).toBe(true);
    expect(h.rows()).toHaveLength(before.length + 1);
    expect(h.rows().at(-1)).toMatchObject({
      equipment_id: 'tripod_b',
      start_date: '2026-10-14',
      end_date: '2026-10-16',
      quantity: 1,
      status: 'confirmed',
    });
    expect(h.state.state).toBe('confirmed');
  });

  it('is idempotent on a repeated yes - criterion 5', async () => {
    const h = harness();
    const check = (await h.runner.run('check_availability', {
      equipment: 'mic_c',
      start_date_phrase: '20 October 2026',
      end_date_phrase: '21 October 2026',
      quantity: 1,
    })) as Record<string, unknown>;

    const first = (await h.runner.run('confirm_booking', {
      hold_token: check.hold_token,
    })) as Record<string, unknown>;
    const second = (await h.runner.run('confirm_booking', {
      hold_token: check.hold_token,
    })) as Record<string, unknown>;

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect((second.reservation as Record<string, unknown>).id).toBe(
      (first.reservation as Record<string, unknown>).id,
    );
    expect(h.rows().filter((r) => r.equipment_id === 'mic_c')).toHaveLength(1);
  });

  it('refuses a token that is not the live hold - criterion 2', async () => {
    const h = harness();
    const first = (await h.runner.run('check_availability', {
      equipment: 'tripod_b',
      start_date_phrase: '14 October 2026',
      end_date_phrase: '16 October 2026',
      quantity: 1,
    })) as Record<string, unknown>;

    // The customer changes their mind. A fresh check supersedes the old hold.
    const second = (await h.runner.run('check_availability', {
      equipment: 'tripod_b',
      start_date_phrase: '20 October 2026',
      end_date_phrase: '22 October 2026',
      quantity: 1,
    })) as Record<string, unknown>;

    const stale = (await h.runner.run('confirm_booking', {
      hold_token: first.hold_token,
    })) as Record<string, unknown>;
    expect(stale.status).toBe('not_allowed');

    const good = (await h.runner.run('confirm_booking', {
      hold_token: second.hold_token,
    })) as Record<string, unknown>;
    expect(good.status).toBe('confirmed');

    const added = h.rows().filter((r) => r.id !== 'seed-camera-a-oct');
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ start_date: '2026-10-20', end_date: '2026-10-22' });
  });

  it('cannot be reached without a hold', async () => {
    const h = harness();
    const r = (await h.runner.run('confirm_booking', { hold_token: 'made.up' })) as Record<
      string,
      unknown
    >;
    expect(r.status).toBe('not_allowed');
    expect(h.rows()).toHaveLength(1);
  });

  it('rejects a forged token even with the state guard removed', async () => {
    // Defence in depth: signature verification and the availability re-check
    // both sit below the state machine.
    const h = harness({ withState: false });
    const r = (await h.runner.run('confirm_booking', {
      hold_token: 'not-a-real.token',
    })) as Record<string, unknown>;
    expect(r.status).toBe('invalid_token');
    expect(h.rows()).toHaveLength(1);
  });

  it('refuses a correctly signed token for stock that is not there', async () => {
    // Hand-mint a token the checker would never issue, bypassing the gate.
    const h = harness({ withState: false });
    const minter = new HoldTokenMinter({
      secret: 'test-secret',
      nonceFactory: () => 'forged',
      clock: () => Date.parse(`${NOW}T09:00:00.000Z`),
    });
    const { token } = minter.mint({
      equipment_id: 'camera_a',
      start_date: '2026-10-11',
      end_date: '2026-10-13',
      quantity: 2,
      conversation_id: 'conv_test',
    });

    const r = (await h.runner.run('confirm_booking', { hold_token: token })) as Record<
      string,
      unknown
    >;
    expect(r.status).toBe('unavailable');
    expect(h.rows()).toHaveLength(1);
  });

  it('rejects an expired hold', async () => {
    const h = harness({ withState: false });
    let t = Date.parse(`${NOW}T09:00:00.000Z`);
    const minter = new HoldTokenMinter({
      secret: 'test-secret',
      nonceFactory: () => 'n',
      clock: () => t,
    });
    const { token } = minter.mint({
      equipment_id: 'tripod_b',
      start_date: '2026-10-14',
      end_date: '2026-10-16',
      quantity: 1,
      conversation_id: 'conv_test',
    });
    t += 11 * 60 * 1000;
    h.runner.setContext({ minter });

    const r = (await h.runner.run('confirm_booking', { hold_token: token })) as Record<
      string,
      unknown
    >;
    expect(r).toMatchObject({ status: 'invalid_token', reason: 'expired' });
    expect(h.rows()).toHaveLength(1);
  });
});

describe('the ordered tool-call log', () => {
  it('records the real sequence, which is the evidence of live processing', async () => {
    const h = harness();
    const check = (await h.runner.run('check_availability', {
      equipment: 'tripod_b',
      start_date_phrase: '14 October 2026',
      end_date_phrase: '16 October 2026',
      quantity: 1,
    })) as Record<string, unknown>;
    await h.runner.run('propose_booking', { hold_token: check.hold_token });
    await h.runner.run('confirm_booking', { hold_token: check.hold_token });

    expect(h.runner.orderedCalls.map((c) => c.name)).toEqual([
      'check_availability',
      'propose_booking',
      'confirm_booking',
    ]);
    expect(h.runner.orderedCalls.map((c) => c.status)).toEqual([
      'available',
      'ready',
      'confirmed',
    ]);
  });
});
