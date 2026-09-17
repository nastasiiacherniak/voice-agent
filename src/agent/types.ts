import type { ToolRunner } from '../booking/tools.js';
import type { ConversationState } from '../state.js';

/** Slots carried across turns so a correction only has to move one of them. */
export interface Slots {
  equipmentPhrase: string | null;
  quantity: number | null;
  startPhrase: string | null;
  endPhrase: string | null;
}

export function emptySlots(): Slots {
  return { equipmentPhrase: null, quantity: null, startPhrase: null, endPhrase: null };
}

export interface TurnContext {
  /** Final transcript of the user turn. */
  text: string;
  runner: ToolRunner;
  state: ConversationState;
  slots: Slots;
  /** Stamped on every tool call so results from a cancelled turn can be dropped. */
  turnId: number;
  signal: AbortSignal;
  /** Called once, as soon as the driver has produced anything at all. */
  onFirstToken: () => void;
  /** Emits a speakable chunk. Called as early and as often as possible. */
  onSpeak: (chunk: string) => void;
}

export interface AgentDriver {
  readonly name: string;
  readonly model: string;
  handleTurn(ctx: TurnContext): Promise<void>;
  /** Token counts for the cost model, accumulated across the session. */
  usage(): { input_tokens: number; output_tokens: number };
}
