import { createSeededDb, type Db } from '../src/booking/db.js';
import { HoldTokenMinter } from '../src/booking/tokens.js';
import { ToolRunner } from '../src/booking/tools.js';
import { ConversationState } from '../src/state.js';

/** Fixed anchor for every fixture and unit test. Tuesday 15 September 2026. */
export const NOW = '2026-09-15';

export interface Harness {
  db: Db;
  state: ConversationState;
  runner: ToolRunner;
  minter: HoldTokenMinter;
  rows: () => Array<Record<string, unknown>>;
}

/**
 * A fully deterministic booking session: fixed signing secret, counted nonces,
 * counted reservation ids and a frozen clock.
 */
export function harness(opts: { withState?: boolean } = {}): Harness {
  const db = createSeededDb(':memory:');
  let nonce = 0;
  let resId = 0;
  const clock = () => Date.parse(`${NOW}T09:00:00.000Z`);

  const minter = new HoldTokenMinter({
    secret: 'test-secret',
    nonceFactory: () => `nonce${nonce++}`,
    clock,
  });

  const state = new ConversationState('conv_test');
  const runner = new ToolRunner({
    db,
    minter,
    now: NOW,
    conversationId: 'conv_test',
    state: opts.withState === false ? undefined : state,
    idFactory: () => `res_test_${resId++}`,
    clock,
  });

  return {
    db,
    state,
    runner,
    minter,
    rows: () =>
      db.prepare('SELECT * FROM reservations ORDER BY created_at, id').all() as Array<
        Record<string, unknown>
      >,
  };
}

/** Rows added relative to a previous snapshot, keyed on reservation id. */
export function diffRows(
  before: Array<Record<string, unknown>>,
  after: Array<Record<string, unknown>>,
) {
  const beforeIds = new Set(before.map((r) => r.id));
  return after.filter((r) => !beforeIds.has(r.id));
}
