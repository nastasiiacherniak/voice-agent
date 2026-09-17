/**
 * End-to-end conversation fixtures. ARCHITECTURE.md §14.
 *
 * Fixtures run through the production Session - the same state machine, the
 * same ToolRunner, the same guards. Only the transport changes: turns arrive
 * as messages instead of over a WebSocket from the browser's STT.
 *
 * Three things are asserted: what the agent said, the ordered tool-call log,
 * and the database diff. The tool-call log is what proves the app processes
 * new input rather than replaying canned answers for the demo.
 */
import { readdirSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { createSeededDb, listReservations, type ReservationRow } from '../src/booking/db.js';
import { DeterministicPlanner } from '../src/agent/planner.js';
import { Session, type Outbound } from '../src/pipeline.js';
import { snapshotMarkdown } from '../scripts/snapshot-db.js';

interface ExpectedCall {
  name: string;
  status?: string;
  created?: boolean;
  args?: Record<string, unknown>;
}

interface Turn {
  user?: string;
  barge_in?: string;
  expect_tool_calls?: ExpectedCall[];
  expect_reply_matches?: string;
  expect_stop_audio?: boolean;
  expect_no_hold?: boolean;
}

interface Fixture {
  id: string;
  title: string;
  now: string;
  turns: Turn[];
  expect: {
    final_state: string;
    db_added?: Array<Record<string, unknown>>;
    db_removed?: Array<Record<string, unknown>>;
    db_absent?: Array<Record<string, unknown>>;
    db_row_count_delta?: number;
  };
}

const EXPECTED_DIR = resolve(__dirname, 'fixtures/expected');
const REPORT_DIR = resolve(__dirname, '../reports');

const fixtures: Fixture[] = readdirSync(EXPECTED_DIR)
  .filter((f) => f.endsWith('.yaml'))
  .sort()
  .map((f) => parse(readFileSync(resolve(EXPECTED_DIR, f), 'utf8')) as Fixture);

function matches(row: Record<string, unknown>, want: Record<string, unknown>): boolean {
  return Object.entries(want).every(([k, v]) => String(row[k]) === String(v));
}

describe.each(fixtures)('$id - $title', (fx) => {
  it('produces the recorded tool calls, reply and database diff', async () => {
    const db = createSeededDb(':memory:');
    const before = listReservations(db);
    const beforeMd = snapshotMarkdown(db, fx.now, 'Before');

    const outbound: Outbound[] = [];
    const session = new Session((m) => outbound.push(m), {
      db,
      now: fx.now,
      driver: new DeterministicPlanner(),
      holdSecret: 'fixture-secret',
      sessionId: fx.id,
    });
    session.start();

    const report: string[] = [`# ${fx.id} - ${fx.title}`, '', beforeMd, '## Transcript', ''];

    for (const [index, turn] of fx.turns.entries()) {
      const logMark = session.runner.log.length;
      const outMark = outbound.length;

      if (turn.barge_in != null) {
        report.push(`- **user (interrupting):** ${turn.barge_in}`);
        await session.handle({ type: 'barge_in', partial: turn.barge_in });
      } else {
        report.push(`- **user:** ${turn.user}`);
        await session.handle({
          type: 'user_turn',
          text: turn.user,
          t_speech_end: Date.now(),
          t_stt_final: Date.now(),
        });
      }

      const newOutbound = outbound.slice(outMark);
      const spoken = newOutbound
        .filter((m): m is Extract<Outbound, { type: 'speak' }> => m.type === 'speak')
        .map((m) => m.text)
        .join(' ');
      if (spoken) report.push(`- **agent:** ${spoken}`);

      // ---- the ordered tool-call log for this turn, stale results excluded
      const calls = session.runner.log
        .slice(logMark)
        .filter((e) => !e.discarded)
        .map((e) => ({ name: e.name, result: e.result, args: e.args }));

      const want = turn.expect_tool_calls ?? [];
      expect(
        calls.map((c) => c.name),
        `turn ${index + 1} tool-call sequence`,
      ).toEqual(want.map((w) => w.name));

      for (const [i, w] of want.entries()) {
        const got = calls[i]!;
        if (w.status) expect(got.result.status, `turn ${index + 1} call ${i + 1} status`).toBe(w.status);
        if (w.created !== undefined) expect(got.result.created).toBe(w.created);
        for (const [k, v] of Object.entries(w.args ?? {})) {
          expect(String(got.args[k]), `turn ${index + 1} arg ${k}`).toContain(String(v));
        }
      }

      if (turn.expect_reply_matches) {
        expect(spoken, `turn ${index + 1} reply`).toContain(turn.expect_reply_matches);
      }
      if (turn.expect_stop_audio) {
        expect(newOutbound.some((m) => m.type === 'stop_audio')).toBe(true);
      }
      if (turn.expect_no_hold) {
        expect(session.state.held, `turn ${index + 1} must hold nothing`).toBeNull();
      }
    }

    // ---------------------------------------------------------- database diff
    const after = listReservations(db);
    const beforeIds = new Set(before.map((r) => r.id));
    const added = after.filter((r) => !beforeIds.has(r.id));
    const afterIds = new Set(after.map((r) => r.id));
    const removed = before.filter((r) => !afterIds.has(r.id));

    expect(session.state.state, 'final conversation state').toBe(fx.expect.final_state);

    const wantAdded = fx.expect.db_added ?? [];
    expect(added.length, 'rows added').toBe(wantAdded.length);
    for (const want of wantAdded) {
      expect(
        added.some((row) => matches(row as unknown as Record<string, unknown>, want)),
        `expected an added row matching ${JSON.stringify(want)}, got ${JSON.stringify(added)}`,
      ).toBe(true);
    }

    expect(removed.length, 'rows removed').toBe((fx.expect.db_removed ?? []).length);

    for (const absent of fx.expect.db_absent ?? []) {
      expect(
        after.some((row) => matches(row as unknown as Record<string, unknown>, absent)),
        `no row may match ${JSON.stringify(absent)}`,
      ).toBe(false);
    }

    if (fx.expect.db_row_count_delta !== undefined) {
      expect(after.length - before.length).toBe(fx.expect.db_row_count_delta);
    }

    // ------------------------------------------------------------- the report
    report.push('', '## Ordered tool calls', '');
    for (const e of session.runner.log) {
      report.push(
        `${e.seq + 1}. \`${e.name}\` -> **${e.result.status}**` +
          (e.discarded ? ' _(discarded: stale turn)_' : '') +
          `\n   - args: \`${JSON.stringify(e.args)}\``,
      );
    }
    report.push('', snapshotMarkdown(db, fx.now, 'After'));
    report.push(
      '## Database diff',
      '',
      `- rows added: ${added.length}`,
      ...added.map((r: ReservationRow) => `  - \`${r.id}\` ${r.equipment_id} ${r.start_date} to ${r.end_date} x${r.quantity}`),
      `- rows removed: ${removed.length}`,
      '',
    );

    mkdirSync(REPORT_DIR, { recursive: true });
    writeFileSync(resolve(REPORT_DIR, `${fx.id}.md`), report.join('\n'), 'utf8');
  });
});
