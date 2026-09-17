/**
 * Stands in for src/agent/llm.ts in the Pages build.
 *
 * pipeline.ts imports AnthropicDriver at module scope, which would pull the
 * whole Anthropic SDK - and a key-shaped hole - into a static page. The demo
 * only ever runs the deterministic planner, so the class is never constructed;
 * this exists so the import resolves.
 *
 * A static page cannot hold an API key anyway: anything shipped here is public.
 */
import type { AgentDriver, TurnContext } from '../../agent/types.js';

export class AnthropicDriver implements AgentDriver {
  readonly name = 'anthropic';
  readonly model = 'unavailable-in-browser';

  constructor(_opts?: unknown) {
    throw new Error('the browser demo runs the deterministic planner only');
  }

  async handleTurn(_ctx: TurnContext): Promise<void> {}

  usage(): { input_tokens: number; output_tokens: number } {
    return { input_tokens: 0, output_tokens: 0 };
  }
}
