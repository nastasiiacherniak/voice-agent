/**
 * The three LLM-facing tools. ARCHITECTURE.md §7.
 *
 * The model never touches SQL and never touches a date. It passes the raw
 * spoken phrases through; normalisation happens in deterministic code here.
 */
import { randomUUID } from 'node:crypto';
import type { Db, ReservationRow } from './db.js';
import { checkAvailability, getEquipment } from './availability.js';
import { humanRange, resolveRange } from './dates.js';
import { HoldTokenMinter } from './tokens.js';
import type { ConversationState } from '../state.js';

// -------------------------------------------------------- equipment resolver

const CATEGORY_PATTERNS: Array<{ id: string; re: RegExp }> = [
  { id: 'camera_a', re: /\b(cameras?|cams?|camera[\s_-]?a)\b/ },
  { id: 'tripod_b', re: /\b(tripods?|stands?|tripod[\s_-]?b)\b/ },
  { id: 'mic_c', re: /\b(mics?|mikes?|microphones?|mic[\s_-]?c)\b/ },
];

export type EquipmentResolution =
  | { status: 'resolved'; id: string }
  | { status: 'ambiguous'; reason: string; candidates: string[] }
  | { status: 'unknown'; reason: string };

export function resolveEquipment(phrase: string | null | undefined): EquipmentResolution {
  const s = (phrase ?? '').toLowerCase().replace(/[^a-z0-9\s_-]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s) return { status: 'unknown', reason: 'no item named' };

  const hits = CATEGORY_PATTERNS.filter((p) => p.re.test(s)).map((p) => p.id);
  const unique = [...new Set(hits)];
  if (unique.length === 1) return { status: 'resolved', id: unique[0]! };
  if (unique.length > 1) {
    return {
      status: 'ambiguous',
      reason: `"${phrase}" mentions more than one kind of item`,
      candidates: unique,
    };
  }
  return { status: 'unknown', reason: `we do not stock anything called "${phrase}"` };
}

// ----------------------------------------------------------------- contracts

export interface CheckAvailabilityArgs {
  equipment: string;
  start_date_phrase?: string | null;
  end_date_phrase?: string | null;
  quantity?: number | null;
}

export interface HoldTokenArgs {
  hold_token: string;
}

export type ToolName = 'check_availability' | 'propose_booking' | 'confirm_booking';

export interface ToolCallLogEntry {
  seq: number;
  turn_id: number;
  name: ToolName;
  args: Record<string, unknown>;
  result: Record<string, unknown>;
  duration_ms: number;
  /** True when the result was dropped because the turn was interrupted (§10.2). */
  discarded?: boolean;
}

export interface ToolContext {
  db: Db;
  minter: HoldTokenMinter;
  /** ISO yyyy-mm-dd anchor for all relative date parsing. */
  now: string;
  conversationId: string;
  /**
   * When present the runner enforces the state guard and keeps the machine in
   * sync, so no caller can dispatch a tool and forget to update the state.
   */
  state?: ConversationState;
  idFactory?: () => string;
  clock?: () => number;
}

/**
 * Redacts the token itself from the log. Tests assert on booking identity,
 * and a signed blob in the log is noise.
 */
function logSafeArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out = { ...args };
  if (typeof out.hold_token === 'string') out.hold_token = `<token:${out.hold_token.slice(0, 8)}>`;
  return out;
}

export class ToolRunner {
  readonly log: ToolCallLogEntry[] = [];
  private seq = 0;
  /** Bumped on barge-in; results stamped with a stale turn are dropped (§10.2). */
  turnId = 0;

  constructor(private ctx: ToolContext) {}

  setContext(patch: Partial<ToolContext>): void {
    this.ctx = { ...this.ctx, ...patch };
  }

  get context(): ToolContext {
    return this.ctx;
  }

  /** Ordered tool-call log, minus tokens. This is the evidence for §14. */
  get orderedCalls(): Array<{ name: ToolName; args: Record<string, unknown>; status: unknown }> {
    return this.log
      .filter((e) => !e.discarded)
      .map((e) => ({ name: e.name, args: e.args, status: e.result.status }));
  }

  async run(name: ToolName, rawArgs: Record<string, unknown>, turnId = this.turnId) {
    const started = performance.now();
    const state = this.ctx.state;

    // Structural guard runs before the tool does. A write is not reachable
    // from a state that has not checked and held the exact booking.
    const guard = state?.guardToolCall(name, rawArgs);
    if (guard && !guard.allowed) {
      const refusal = { status: 'not_allowed', reason: guard.reason };
      this.log.push({
        seq: this.seq++,
        turn_id: turnId,
        name,
        args: logSafeArgs(rawArgs),
        result: refusal,
        duration_ms: 0,
      });
      return refusal;
    }

    let result: Record<string, unknown>;
    switch (name) {
      case 'check_availability':
        result = this.checkAvailabilityTool(rawArgs as unknown as CheckAvailabilityArgs);
        break;
      case 'propose_booking':
        result = this.proposeBookingTool(rawArgs as unknown as HoldTokenArgs);
        break;
      case 'confirm_booking':
        result = this.confirmBookingTool(rawArgs as unknown as HoldTokenArgs);
        break;
      default:
        result = { status: 'error', reason: `unknown tool ${name}` };
    }

    // A result that landed after the user interrupted carries a choice they
    // have already retracted. Drop it rather than let it reach the model.
    const stale = turnId < this.turnId;
    this.log.push({
      seq: this.seq++,
      turn_id: turnId,
      name,
      args: logSafeArgs(rawArgs),
      result,
      duration_ms: Math.round(performance.now() - started),
      ...(stale ? { discarded: true } : {}),
    });

    if (stale) {
      return { status: 'discarded', reason: 'the request changed while this check was running' };
    }

    if (state) {
      if (name === 'check_availability') state.onAvailabilityResult(result);
      if (name === 'confirm_booking') state.onConfirmResult(result);
    }
    return result;
  }

  // ------------------------------------------------------- check_availability

  /** Read-only. Mints a hold token if and only if the status is "available". */
  private checkAvailabilityTool(args: CheckAvailabilityArgs): Record<string, unknown> {
    const { db, minter, now, conversationId } = this.ctx;

    const item = resolveEquipment(args.equipment);
    if (item.status !== 'resolved') {
      return {
        status: 'needs_clarification',
        field: 'equipment',
        reason: item.reason,
        ...(item.status === 'ambiguous' ? { candidates: item.candidates } : {}),
      };
    }

    const range = resolveRange(args.start_date_phrase, args.end_date_phrase, { now });
    if (range.status === 'ambiguous') {
      return {
        status: 'needs_clarification',
        field: range.field,
        reason: range.reason,
        candidates: range.candidates,
        candidates_spoken: range.candidates.map((c) => humanRange(c, c)),
      };
    }
    if (range.status === 'invalid') {
      return { status: 'invalid', field: range.field, reason: range.reason };
    }

    const quantity = args.quantity == null ? 1 : Number(args.quantity);
    const check = checkAvailability(db, item.id, range.start, range.end, quantity, { now });

    if (check.status === 'invalid') return { status: 'invalid', field: 'request', reason: check.reason };

    if (check.status === 'unavailable') {
      return {
        status: 'unavailable',
        equipment: check.equipment_id,
        display_name: check.display_name,
        start_date: check.start_date,
        end_date: check.end_date,
        quantity: check.quantity,
        shortfall: check.shortfall,
        first_blocked_date: check.first_blocked_date,
        max_available: check.max_available,
        alternatives: check.alternatives,
        spoken_range: humanRange(check.start_date, check.end_date),
      };
    }

    const { token } = minter.mint({
      equipment_id: check.equipment_id,
      start_date: check.start_date,
      end_date: check.end_date,
      quantity: check.quantity,
      conversation_id: conversationId,
    });

    return {
      status: 'available',
      hold_token: token,
      equipment: check.equipment_id,
      display_name: check.display_name,
      start_date: check.start_date,
      end_date: check.end_date,
      quantity: check.quantity,
      remaining_after: check.remaining_after,
      summary: check.summary,
    };
  }

  // ---------------------------------------------------------- propose_booking

  /**
   * No write. The read-back is generated from the token's contents rather than
   * from the model's recollection - if the model drifted, this exposes it.
   */
  private proposeBookingTool(args: HoldTokenArgs): Record<string, unknown> {
    const v = this.ctx.minter.verify(args?.hold_token ?? '');
    if (!v.ok) return { status: 'invalid_token', reason: v.reason };
    if (v.payload.conversation_id !== this.ctx.conversationId) {
      return { status: 'invalid_token', reason: 'token belongs to another conversation' };
    }

    const p = v.payload;
    const name = getEquipment(this.ctx.db, p.equipment_id)?.display_name ?? p.equipment_id;
    return {
      status: 'ready',
      readback: `${p.quantity} ${name}${p.quantity === 1 ? '' : 's'}, ${humanRange(p.start_date, p.end_date)}`,
      equipment: p.equipment_id,
      display_name: name,
      start_date: p.start_date,
      end_date: p.end_date,
      quantity: p.quantity,
    };
  }

  // ---------------------------------------------------------- confirm_booking

  private confirmBookingTool(args: HoldTokenArgs): Record<string, unknown> {
    const { db, minter, now, conversationId } = this.ctx;

    const v = minter.verify(args?.hold_token ?? '');
    if (!v.ok) {
      return {
        status: 'invalid_token',
        reason: v.reason,
        message:
          v.reason === 'expired'
            ? 'that hold has expired, I need to re-check availability'
            : 'I do not have a valid hold to confirm',
      };
    }
    if (v.payload.conversation_id !== conversationId) {
      return { status: 'invalid_token', reason: 'token belongs to another conversation' };
    }

    const p = v.payload;
    const holdHash = v.hold_hash;

    const write = db.transaction(() => {
      // Idempotency first. On a repeated "yes" the row already exists, and
      // re-running availability would now see our own booking and refuse it.
      const existing = db
        .prepare('SELECT * FROM reservations WHERE hold_hash = ?')
        .get(holdHash) as ReservationRow | undefined;
      if (existing) return { row: existing, created: false };

      // Time passed between read-back and "yes" - re-check before writing.
      const recheck = checkAvailability(db, p.equipment_id, p.start_date, p.end_date, p.quantity, {
        now,
      });
      if (recheck.status !== 'available') return { row: null, created: false, recheck };

      const id = (this.ctx.idFactory ?? (() => `res_${randomUUID().slice(0, 8)}`))();
      const createdAt = new Date(this.ctx.clock?.() ?? Date.now()).toISOString();
      db.prepare(
        `INSERT INTO reservations
           (id, equipment_id, start_date, end_date, quantity, status, hold_hash, created_at)
         VALUES (?, ?, ?, ?, ?, 'confirmed', ?, ?)
         ON CONFLICT(hold_hash) DO NOTHING`,
      ).run(id, p.equipment_id, p.start_date, p.end_date, p.quantity, holdHash, createdAt);

      const row = db.prepare('SELECT * FROM reservations WHERE hold_hash = ?').get(holdHash) as
        | ReservationRow
        | undefined;
      return { row: row ?? null, created: row?.id === id };
    });

    const outcome = write();

    if (!outcome.row) {
      const r = (outcome as { recheck?: ReturnType<typeof checkAvailability> }).recheck;
      return {
        status: 'unavailable',
        reason: 'stock changed since the hold was issued',
        ...(r && r.status === 'unavailable'
          ? { first_blocked_date: r.first_blocked_date, max_available: r.max_available }
          : {}),
      };
    }

    const name = getEquipment(db, outcome.row.equipment_id)?.display_name ?? outcome.row.equipment_id;
    return {
      status: 'confirmed',
      created: outcome.created,
      reservation: {
        id: outcome.row.id,
        equipment: outcome.row.equipment_id,
        display_name: name,
        start_date: outcome.row.start_date,
        end_date: outcome.row.end_date,
        quantity: outcome.row.quantity,
        spoken_range: humanRange(outcome.row.start_date, outcome.row.end_date),
      },
    };
  }
}

// ------------------------------------------------------- schemas for the LLM

export const TOOL_SCHEMAS = [
  {
    name: 'check_availability',
    description:
      'Check whether an item is free for a date range. Read-only. Pass the date phrases exactly as the customer said them - do not convert them to calendar dates yourself, and never invent a month or a year that was not spoken.',
    input_schema: {
      type: 'object' as const,
      properties: {
        equipment: {
          type: 'string',
          enum: ['camera_a', 'tripod_b', 'mic_c'],
          description: 'Camera A, Tripod B or Microphone C.',
        },
        start_date_phrase: {
          type: 'string',
          description: 'The start date exactly as spoken, e.g. "the 14th of October" or "next Friday".',
        },
        end_date_phrase: {
          type: 'string',
          description:
            'The end date exactly as spoken. Use an empty string for a single-day rental, or a duration such as "for 3 days".',
        },
        quantity: { type: 'integer', minimum: 1, description: 'How many units. Defaults to 1.' },
      },
      required: ['equipment', 'start_date_phrase'],
    },
  },
  {
    name: 'propose_booking',
    description:
      'Turn a hold token into the exact sentence to read back to the customer before asking them to confirm. Does not book anything.',
    input_schema: {
      type: 'object' as const,
      properties: { hold_token: { type: 'string' } },
      required: ['hold_token'],
    },
  },
  {
    name: 'confirm_booking',
    description:
      'Write the reservation. Call this only after the customer has explicitly confirmed the read-back. Safe to call twice - the second call returns the same reservation with created=false.',
    input_schema: {
      type: 'object' as const,
      properties: { hold_token: { type: 'string' } },
      required: ['hold_token'],
    },
  },
];
