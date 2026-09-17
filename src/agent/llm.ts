/**
 * Anthropic driver. Streaming, temperature 0, pinned model version.
 *
 * Text is flushed to the speaker sentence by sentence so the first audible
 * word does not wait for the whole completion. The tool loop runs through the
 * same ToolRunner as the deterministic planner, so the state guard, the
 * stale-turn guard and the tool-call log apply identically.
 */
import Anthropic from '@anthropic-ai/sdk';
import { TOOL_SCHEMAS, type ToolName } from '../booking/tools.js';
import { systemPrompt } from './prompt.js';
import type { AgentDriver, TurnContext } from './types.js';

type Msg = Anthropic.MessageParam;

const MAX_TOOL_ROUNDS = 6;

/** Flushes on sentence boundaries so TTS can start before the model finishes. */
class SentenceChunker {
  private buf = '';
  constructor(private readonly emit: (s: string) => void) {}

  push(delta: string): void {
    this.buf += delta;
    // Split after . ! ? or a newline, when followed by whitespace.
    let m: RegExpExecArray | null;
    const re = /([^.!?\n]*[.!?\n])(\s+)/;
    while ((m = re.exec(this.buf)) !== null) {
      const sentence = m[1]!.trim();
      this.buf = this.buf.slice(m[0].length);
      if (sentence) this.emit(sentence);
    }
    if (this.buf.length > 160) {
      this.emit(this.buf.trim());
      this.buf = '';
    }
  }

  flush(): void {
    const rest = this.buf.trim();
    this.buf = '';
    if (rest) this.emit(rest);
  }
}

export class AnthropicDriver implements AgentDriver {
  readonly name = 'anthropic';
  readonly model: string;
  private client: Anthropic;
  private history: Msg[] = [];
  private inputTokens = 0;
  private outputTokens = 0;

  constructor(opts: { apiKey: string; model?: string; baseURL?: string }) {
    this.model = opts.model ?? 'claude-haiku-4-5-20251001';
    this.client = new Anthropic({
      apiKey: opts.apiKey,
      ...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
    });
  }

  usage() {
    return { input_tokens: this.inputTokens, output_tokens: this.outputTokens };
  }

  /**
   * Truncate the assistant's last message to what was actually spoken, so the
   * model does not believe it said something the customer never heard (§10.2).
   */
  truncateLastAssistant(spoken: string): void {
    for (let i = this.history.length - 1; i >= 0; i--) {
      const m = this.history[i]!;
      if (m.role !== 'assistant') continue;
      if (typeof m.content === 'string') {
        m.content = spoken;
      } else if (Array.isArray(m.content)) {
        m.content = m.content.map((b) =>
          b.type === 'text' ? { ...b, text: spoken || '(interrupted)' } : b,
        );
      }
      return;
    }
  }

  async handleTurn(ctx: TurnContext): Promise<void> {
    ctx.state.onUserTurn();
    this.history.push({ role: 'user', content: ctx.text });

    let firstEmitted = false;
    const chunker = new SentenceChunker((s) => {
      if (ctx.signal.aborted) return;
      if (!firstEmitted) {
        firstEmitted = true;
        ctx.onFirstToken();
      }
      ctx.onSpeak(s);
    });

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      if (ctx.signal.aborted) return;

      const stream = this.client.messages.stream(
        {
          model: this.model,
          max_tokens: 400,
          temperature: 0,
          system: systemPrompt(ctx.runner.context.now),
          tools: TOOL_SCHEMAS as Anthropic.Tool[],
          messages: this.history,
        },
        { signal: ctx.signal },
      );

      stream.on('text', (delta) => {
        if (!firstEmitted) ctx.onFirstToken();
        chunker.push(delta);
      });

      let final: Anthropic.Message;
      try {
        final = await stream.finalMessage();
      } catch (err) {
        if (ctx.signal.aborted) return; // barge-in cancelled the completion
        throw err;
      }

      this.inputTokens += final.usage.input_tokens;
      this.outputTokens += final.usage.output_tokens;
      this.history.push({ role: 'assistant', content: final.content });

      if (final.stop_reason !== 'tool_use') {
        chunker.flush();
        return;
      }

      const toolUses = final.content.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
      );
      const results: Anthropic.ToolResultBlockParam[] = [];

      for (const use of toolUses) {
        if (ctx.signal.aborted) return;
        const out = await ctx.runner.run(
          use.name as ToolName,
          (use.input ?? {}) as Record<string, unknown>,
          ctx.turnId,
        );
        results.push({
          type: 'tool_result',
          tool_use_id: use.id,
          content: JSON.stringify(out),
        });
      }

      // A discarded result means the customer changed their mind while the
      // tool was in flight. Stop this turn rather than speak about it.
      if (results.length === 0) {
        chunker.flush();
        return;
      }
      this.history.push({ role: 'user', content: results });
    }

    chunker.flush();
  }
}
