/**
 * Deterministic planner - the offline conversation driver.
 *
 * It fills the same slots, calls the same three tools in the same order and
 * obeys the same state machine as the LLM driver. It processes whatever the
 * customer actually said; it does not hold canned answers for the fixtures.
 *
 * It runs when no ANTHROPIC_API_KEY is configured, and it is what makes the
 * recorded checks reproducible with zero variance.
 */
import { humanDate, humanRange } from '../booking/dates.js';
import { inventoryState } from '../booking/availability.js';
import { resolveEquipment } from '../booking/tools.js';
import { classifyConfirmation } from '../state.js';
import { extractSlots } from './extract.js';
import type { AgentDriver, TurnContext } from './types.js';

const MONTH_ONLY = /^(jan|january|feb|february|mar|march|apr|april|may|jun|june|jul|july|aug|august|sep|sept|september|oct|october|nov|november|dec|december)(\s+\d{4})?$/;

function listAlternatives(alts: Array<Record<string, unknown>>): string {
  const phrases = alts.map((a) => String(a.summary));
  if (phrases.length === 0) return '';
  if (phrases.length === 1) return ` I could do ${phrases[0]} instead.`;
  return ` I could do ${phrases.slice(0, -1).join(', ')} or ${phrases.at(-1)} instead.`;
}

export class DeterministicPlanner implements AgentDriver {
  readonly name = 'deterministic-planner';
  readonly model = 'none';

  usage() {
    return { input_tokens: 0, output_tokens: 0 };
  }

  async handleTurn(ctx: TurnContext): Promise<void> {
    const { text, state, slots, runner } = ctx;
    const say = (s: string) => {
      ctx.onFirstToken();
      ctx.onSpeak(s);
    };

    state.onUserTurn();

    // ---- explicit confirmation, only meaningful from held or confirmed
    const verdict = classifyConfirmation(text);
    if (verdict.isConfirmation && (state.state === 'held' || state.state === 'confirmed')) {
      if (!state.held) {
        say('I do not have anything held just now. Which item and dates would you like?');
        return;
      }
      const res = (await runner.run(
        'confirm_booking',
        { hold_token: state.held.hold_token },
        ctx.turnId,
      )) as Record<string, unknown>;

      if (res.status === 'confirmed') {
        const r = res.reservation as Record<string, unknown>;
        if (res.created) {
          say(
            `Done. ${r.quantity} ${r.display_name}, ${r.spoken_range}. Your reservation number is ${r.id}.`,
          );
        } else {
          say(
            `That one is already booked under reservation ${r.id}. I have not made a second booking.`,
          );
        }
        return;
      }
      if (res.status === 'not_allowed' || res.status === 'invalid_token') {
        say('That hold is no longer current. Let me check those dates again for you.');
        return;
      }
      say('I could not complete that booking because the stock changed. Shall I look for other dates?');
      return;
    }

    // A "yes" that arrives with nothing held is not a confirmation of anything.
    if (verdict.isConfirmation && state.state !== 'held' && state.state !== 'confirmed') {
      say('Just to be sure - which item and which dates would you like?');
      return;
    }

    // ---- a fresh request after a completed booking
    const extracted = extractSlots(text);
    if (state.state === 'confirmed' && (extracted.equipmentPhrase || extracted.startPhrase)) {
      state.startNewRequest();
      runner.setContext({ conversationId: state.conversationId });
      slots.equipmentPhrase = null;
      slots.quantity = null;
      slots.startPhrase = null;
      slots.endPhrase = null;
    }

    // ---- stock question
    if (/\b(what|which)\b.*\b(have|stock|carry|available|offer)\b/.test(text.toLowerCase())) {
      const items = inventoryState(runner.context.db, runner.context.now);
      say(
        `We have ${items
          .map((i) => `${i.total_stock} ${i.display_name}`)
          .join(', ')}. Which would you like, and for which dates?`,
      );
      return;
    }

    // ---- merge the new information into the carried slots
    const before = JSON.stringify(slots);

    if (extracted.equipmentPhrase) slots.equipmentPhrase = extracted.equipmentPhrase;
    if (extracted.quantity != null) slots.quantity = extracted.quantity;

    if (extracted.startPhrase) {
      slots.startPhrase = extracted.startPhrase;
      // A new start date with no new end date replaces the whole range rather
      // than silently keeping an end that now precedes the start.
      slots.endPhrase = extracted.endPhrase ?? null;
    } else if (extracted.endPhrase) {
      slots.endPhrase = extracted.endPhrase;
    }

    // Answering "which month?" with a bare month completes the stored phrase.
    if (extracted.loneMonth && MONTH_ONLY.test(extracted.loneMonth.trim())) {
      const field = state.pendingClarification?.field;
      if (field === 'end_date' && slots.endPhrase) {
        slots.endPhrase = `${slots.endPhrase} ${extracted.loneMonth}`;
      } else if (slots.startPhrase) {
        slots.startPhrase = `${slots.startPhrase} ${extracted.loneMonth}`;
      }
    }

    const changed = JSON.stringify(slots) !== before;

    // Any slot movement invalidates the hold. ARCHITECTURE.md §8.
    if (changed && state.held) state.discardToken('slot_change');

    if (!slots.equipmentPhrase) {
      say('We rent Camera A, Tripod B and Microphone C. Which of those would you like?');
      return;
    }
    if (!slots.startPhrase) {
      say(`Certainly. Which dates do you need the ${slots.equipmentPhrase} for?`);
      return;
    }
    if (!changed && state.state === 'held' && state.held) {
      say(
        `I have ${state.held.quantity} ${state.held.display_name}, ${humanRange(state.held.start_date, state.held.end_date)} on hold. Shall I confirm it?`,
      );
      return;
    }

    // Resolve to the canonical id where we can, so the tool-call log reads the
    // same whichever driver produced it. An unrecognised phrase is passed
    // through untouched and the tool asks about it.
    const item = resolveEquipment(slots.equipmentPhrase);

    // ---- check, then read back
    const check = (await runner.run(
      'check_availability',
      {
        equipment: item.status === 'resolved' ? item.id : slots.equipmentPhrase,
        start_date_phrase: slots.startPhrase,
        end_date_phrase: slots.endPhrase ?? '',
        quantity: slots.quantity ?? 1,
      },
      ctx.turnId,
    )) as Record<string, unknown>;

    if (check.status === 'discarded') return; // the user moved on mid-check

    if (check.status === 'needs_clarification') {
      say(this.clarifyingQuestion(check));
      return;
    }
    if (check.status === 'invalid' || check.status === 'not_allowed') {
      say(`Sorry, ${check.reason}. Could you give me the dates again?`);
      return;
    }
    if (check.status === 'unavailable') {
      const blocked = humanDate(String(check.first_blocked_date));
      const alts = (check.alternatives as Array<Record<string, unknown>>) ?? [];
      const free = Number(check.max_available);
      const shortage =
        free === 0
          ? `${check.quantity === 1 ? 'It is' : 'They are'} already booked on ${blocked}.`
          : `Only ${free} ${free === 1 ? 'is' : 'are'} free on ${blocked}, and you asked for ${check.quantity}.`;
      say(
        `I am sorry, ${check.display_name} is not free for all of that. ${shortage}` +
          listAlternatives(alts) +
          ' Would any of that work?',
      );
      return;
    }

    // available -> read back from the token, never from memory
    const proposal = (await runner.run(
      'propose_booking',
      { hold_token: check.hold_token },
      ctx.turnId,
    )) as Record<string, unknown>;

    if (proposal.status !== 'ready') {
      say('Let me check those dates once more.');
      return;
    }
    say(`That is available. ${proposal.readback}. Shall I book it?`);
  }

  private clarifyingQuestion(check: Record<string, unknown>): string {
    const field = String(check.field);
    if (field === 'equipment') {
      return 'Sorry - which item did you mean: Camera A, Tripod B or Microphone C?';
    }
    const which = field === 'end_date' ? 'end' : 'start';
    const candidates = (check.candidates as string[] | undefined) ?? [];
    if (candidates.length >= 2) {
      return `Just to be sure about the ${which} date - did you mean ${humanDate(candidates[0]!)} or ${humanDate(candidates[1]!)}?`;
    }
    if (candidates.length === 1) {
      return `Just to be sure about the ${which} date - did you mean ${humanDate(candidates[0]!)}?`;
    }
    return `I need the ${which} date exactly - ${check.reason}. Which day did you have in mind?`;
  }
}
