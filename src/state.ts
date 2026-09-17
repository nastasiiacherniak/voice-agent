/**
 * Conversation state machine. ARCHITECTURE.md §9.
 *
 * Two rules live here in code rather than in prose:
 *   1. Only `held` can transition to `confirmed`. A "yes" in any other state
 *      is not a confirmation.
 *   2. Confirmation must be explicit, and the matcher is unit-tested against
 *      positives and near-misses rather than delegated to the model.
 */
import { randomUUID } from 'node:crypto';

export type StateName = 'idle' | 'gathering' | 'clarifying' | 'held' | 'confirmed';

export interface HeldBooking {
  hold_token: string;
  equipment: string;
  display_name: string;
  start_date: string;
  end_date: string;
  quantity: number;
}

export interface ConfirmedBooking {
  id: string;
  equipment: string;
  display_name: string;
  start_date: string;
  end_date: string;
  quantity: number;
  spoken_range: string;
}

// ----------------------------------------------------- confirmation matching

/** A "yes" that is really the start of a change is not a confirmation. */
const CHANGE_MARKERS = [
  'but', 'actually', 'instead', 'change', 'wait', 'hold on', 'hang on', 'no',
  'not', 'never mind', 'nevermind', 'different', 'rather', 'sorry', 'scratch',
  'make it', 'can you', 'could you', 'what about', 'how about', 'except',
];

/** Unambiguous agreement. At least one of these must be present. */
const STRONG_AFFIRMATIVES = [
  'yes', 'yeah', 'yep', 'yup', 'yes please', 'confirm', 'confirmed', 'correct',
  "that's right", 'thats right', 'go ahead', 'book it', 'book that', 'do it',
  'lock it in', 'please book', 'sure', 'absolutely', 'affirmative',
];

/** Agreement too soft to write a row on its own. */
const WEAK_AFFIRMATIVES = ['sounds good', 'ok', 'okay', 'alright', 'fine', 'great', 'perfect', 'nice'];

function normaliseUtterance(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9'\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

export interface ConfirmationVerdict {
  isConfirmation: boolean;
  reason: 'explicit' | 'too_weak' | 'contains_change' | 'too_long' | 'no_affirmative' | 'empty';
}

/**
 * Explicit confirmation only. "Yes", "confirm", "book it", "that's right, go
 * ahead" pass. "Yeah but can we change the dates", "sounds good", silence and
 * anything carrying new information do not.
 */
export function classifyConfirmation(text: string): ConfirmationVerdict {
  const s = normaliseUtterance(text);
  if (!s) return { isConfirmation: false, reason: 'empty' };

  for (const marker of CHANGE_MARKERS) {
    const re = new RegExp(`(^|\\s)${marker.replace(/'/g, "'?")}(\\s|$)`);
    if (re.test(s)) return { isConfirmation: false, reason: 'contains_change' };
  }

  const words = s.split(' ');
  if (words.length > 8) return { isConfirmation: false, reason: 'too_long' };

  const hasStrong = STRONG_AFFIRMATIVES.some((a) =>
    new RegExp(`(^|\\s)${a.replace(/'/g, "'?")}(\\s|$)`).test(s),
  );
  if (hasStrong) return { isConfirmation: true, reason: 'explicit' };

  const hasWeak = WEAK_AFFIRMATIVES.some((a) => new RegExp(`(^|\\s)${a}(\\s|$)`).test(s));
  if (hasWeak) return { isConfirmation: false, reason: 'too_weak' };

  return { isConfirmation: false, reason: 'no_affirmative' };
}

// ------------------------------------------------------------- state machine

export interface TransitionRecord {
  from: StateName;
  to: StateName;
  event: string;
  note?: string;
  at: number;
}

export class ConversationState {
  state: StateName = 'idle';
  conversationId: string;
  held: HeldBooking | null = null;
  confirmed: ConfirmedBooking | null = null;
  /** Set while a clarifying question is outstanding. */
  pendingClarification: { field: string; reason: string } | null = null;
  /** Monotonic; bumped on every barge-in so late tool results can be dropped. */
  turnId = 0;
  /** An audio-only interruption whose words have not arrived yet. */
  pendingBargeIn = false;
  readonly transitions: TransitionRecord[] = [];

  constructor(conversationId = `conv_${randomUUID().slice(0, 8)}`) {
    this.conversationId = conversationId;
  }

  private go(to: StateName, event: string, note?: string): void {
    this.transitions.push({ from: this.state, to, event, note, at: Date.now() });
    this.state = to;
  }

  /** idle -> gathering on the first thing the user says. */
  onUserTurn(): void {
    if (this.state === 'idle') this.go('gathering', 'user_speaks');
  }

  onAvailabilityResult(result: Record<string, unknown>): void {
    const status = result.status as string;

    if (status === 'available') {
      this.pendingClarification = null;
      this.held = {
        hold_token: result.hold_token as string,
        equipment: result.equipment as string,
        display_name: result.display_name as string,
        start_date: result.start_date as string,
        end_date: result.end_date as string,
        quantity: result.quantity as number,
      };
      this.go('held', 'available', 'token minted');
      return;
    }

    // Anything that is not "available" must never leave a live token behind.
    this.discardToken('check_not_available');

    if (status === 'needs_clarification') {
      this.pendingClarification = {
        field: result.field as string,
        reason: result.reason as string,
      };
      this.go('clarifying', 'ambiguous_slot');
      return;
    }
    this.pendingClarification = null;
    this.go('gathering', status === 'unavailable' ? 'unavailable' : 'invalid_request');
  }

  /**
   * Any change to item, dates or quantity mints a new token, so the old one is
   * dropped the moment a slot moves. ARCHITECTURE.md §8.
   */
  discardToken(event: string): void {
    if (this.held) {
      this.held = null;
      if (this.state === 'held') this.go('gathering', event, 'token discarded');
    }
  }

  /**
   * Barge-in. Spec §9 discards the held token on interruption; we keep it when
   * the interrupting utterance is itself an explicit confirmation of the
   * read-back in flight, because that choice is not obsolete - it is the one
   * being read out. Every other interruption drops the token. Documented as a
   * deliberate deviation in the README.
   */
  onBargeIn(interruptingText?: string): { tokenKept: boolean } {
    this.turnId += 1;

    // The barge-in detector works on audio energy, so an interruption usually
    // arrives with no transcript yet - the recogniser is switched off while the
    // agent speaks, precisely so it cannot hear the agent. Hold the decision
    // over until the words arrive rather than guess now.
    if (!interruptingText) {
      if (this.state === 'held' && this.held) {
        this.pendingBargeIn = true;
        return { tokenKept: true };
      }
      return { tokenKept: this.held !== null };
    }

    if (this.state === 'held' && !classifyConfirmation(interruptingText).isConfirmation) {
      this.discardToken('barge_in');
      return { tokenKept: false };
    }
    return { tokenKept: this.held !== null };
  }

  /**
   * The words behind an audio-only interruption have arrived. Anything that is
   * not an explicit confirmation of the read-back drops the hold, which is the
   * deferred half of onBargeIn.
   */
  resolvePendingBargeIn(text: string): void {
    if (!this.pendingBargeIn) return;
    this.pendingBargeIn = false;
    if (!classifyConfirmation(text).isConfirmation) this.discardToken('barge_in');
  }

  onConfirmResult(result: Record<string, unknown>): void {
    if (result.status !== 'confirmed') return;
    const r = result.reservation as ConfirmedBooking;
    this.confirmed = r;
    if (this.state !== 'confirmed') this.go('confirmed', 'explicit_confirmation');
  }

  /** A new request after a confirmed booking starts a fresh conversation id. */
  startNewRequest(): void {
    this.conversationId = `conv_${randomUUID().slice(0, 8)}`;
    this.held = null;
    this.confirmed = null;
    this.pendingClarification = null;
    this.go('gathering', 'new_request');
  }

  /**
   * The structural guard, enforced before any tool is dispatched.
   *
   *  - `confirm_booking` is reachable only from `held`, or from `confirmed`
   *    for the idempotent repeat.
   *  - Only the *currently held* token may be proposed or confirmed. An older
   *    token stays cryptographically valid after the customer changes their
   *    mind, so signature checking alone would still let a superseded booking
   *    through. This is what keeps the corrected-dates case honest.
   */
  guardToolCall(
    name: string,
    args: Record<string, unknown> = {},
  ): { allowed: true } | { allowed: false; reason: string } {
    if (name !== 'confirm_booking' && name !== 'propose_booking') return { allowed: true };

    if (name === 'confirm_booking') {
      if (this.state !== 'held' && this.state !== 'confirmed') {
        return {
          allowed: false,
          reason:
            this.state === 'clarifying'
              ? 'a detail is still unclear, ask the customer about it before booking'
              : 'there is no checked and held booking to confirm - call check_availability first',
        };
      }
    }

    if (!this.held) {
      return { allowed: false, reason: 'there is no live hold - call check_availability first' };
    }

    const presented = args.hold_token;
    if (typeof presented !== 'string' || presented !== this.held.hold_token) {
      return {
        allowed: false,
        reason:
          'that hold is out of date because the request changed - call check_availability again for the current details',
      };
    }

    return { allowed: true };
  }

  snapshot() {
    return {
      state: this.state,
      conversation_id: this.conversationId,
      turn_id: this.turnId,
      pending_barge_in: this.pendingBargeIn,
      held: this.held
        ? {
            equipment: this.held.equipment,
            display_name: this.held.display_name,
            start_date: this.held.start_date,
            end_date: this.held.end_date,
            quantity: this.held.quantity,
          }
        : null,
      confirmed: this.confirmed,
      pending_clarification: this.pendingClarification,
    };
  }
}
