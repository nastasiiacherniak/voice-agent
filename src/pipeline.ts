/**
 * Turn orchestration. ARCHITECTURE.md §10.
 *
 * The browser owns microphone capture, VAD, STT and TTS playback; this owns
 * the turn boundary, the tool loop, interruption and the metrics. Swapping in
 * a cloud STT/TTS pair changes only where the transcript and the audio come
 * from - the logic below does not move.
 */
import { randomUUID } from 'node:crypto';
import type { Db } from './booking/db.js';
import { inventoryState } from './booking/availability.js';
import { HoldTokenMinter } from './booking/tokens.js';
import { ToolRunner } from './booking/tools.js';
import { ConversationState } from './state.js';
import { AnthropicDriver } from './agent/llm.js';
import { DeterministicPlanner } from './agent/planner.js';
import { emptySlots, type AgentDriver, type Slots } from './agent/types.js';
import { ClockSync, MetricsWriter, TurnMetrics, type TurnRecord } from './voice/metrics.js';

export const DEFAULT_VAD_SILENCE_MS = 600;

export interface SessionOptions {
  db: Db;
  /** ISO yyyy-mm-dd anchor for relative dates. */
  now: string;
  driver: AgentDriver;
  holdSecret?: string;
  metrics?: MetricsWriter;
  vadSilenceMs?: number;
  sessionId?: string;
}

export type Outbound =
  | { type: 'ready'; session_id: string; driver: string; model: string; vad_silence_ms: number }
  | { type: 'pong'; client_sent: number; server_time: number }
  | { type: 'speak'; turn_id: number; seq: number; text: string }
  | { type: 'stop_audio'; turn_id: number }
  | { type: 'agent_done'; turn_id: number; reply: string }
  | { type: 'state'; payload: unknown }
  | { type: 'error'; message: string };

export interface Inbound {
  type:
    | 'ping'
    | 'clock_sample'
    | 'user_turn'
    | 'barge_in'
    | 'audio_first_frame'
    | 'reset'
    | 'get_state';
  [k: string]: unknown;
}

export class Session {
  readonly id: string;
  readonly state: ConversationState;
  readonly runner: ToolRunner;
  readonly db: Db;
  slots: Slots = emptySlots();

  private driver: AgentDriver;
  private clock = new ClockSync();
  private metricsWriter?: MetricsWriter;
  private vadSilenceMs: number;
  private abort: AbortController | null = null;
  private current: TurnMetrics | null = null;
  private spokenThisTurn = '';
  private seq = 0;
  private toolLogWatermark = 0;
  /**
   * One per user turn, for metrics and for addressing audio back to the right
   * turn. Distinct from state.turnId, which is the barge-in generation used to
   * decide whether an in-flight tool result is stale.
   */
  private turnSeq = 0;
  readonly turnRecords: TurnRecord[] = [];

  constructor(
    private readonly send: (msg: Outbound) => void,
    opts: SessionOptions,
  ) {
    this.id = opts.sessionId ?? `sess_${randomUUID().slice(0, 8)}`;
    this.db = opts.db;
    this.driver = opts.driver;
    this.metricsWriter = opts.metrics;
    this.vadSilenceMs = opts.vadSilenceMs ?? DEFAULT_VAD_SILENCE_MS;
    this.state = new ConversationState();
    this.runner = new ToolRunner({
      db: opts.db,
      minter: new HoldTokenMinter({ secret: opts.holdSecret }),
      now: opts.now,
      conversationId: this.state.conversationId,
      state: this.state,
    });
  }

  start(): void {
    this.send({
      type: 'ready',
      session_id: this.id,
      driver: this.driver.name,
      model: this.driver.model,
      vad_silence_ms: this.vadSilenceMs,
    });
    this.pushState();
  }

  pushState(): void {
    this.send({
      type: 'state',
      payload: {
        conversation: this.state.snapshot(),
        inventory: inventoryState(this.db, this.runner.context.now),
        tool_calls: this.runner.log.map((e) => ({
          seq: e.seq,
          name: e.name,
          args: e.args,
          status: e.result.status,
          discarded: e.discarded ?? false,
          duration_ms: e.duration_ms,
        })),
        now: this.runner.context.now,
      },
    });
  }

  async handle(msg: Inbound): Promise<void> {
    switch (msg.type) {
      case 'ping':
        this.send({ type: 'pong', client_sent: Number(msg.t), server_time: Date.now() });
        return;

      case 'clock_sample':
        this.clock.addSample(Number(msg.client_sent), Number(msg.server_time), Number(msg.client_received));
        return;

      case 'get_state':
        this.pushState();
        return;

      case 'barge_in':
        this.onBargeIn(typeof msg.partial === 'string' ? msg.partial : '');
        return;

      case 'audio_first_frame':
        this.onAudioFirstFrame(Number(msg.turn_id), Number(msg.t_client));
        return;

      case 'reset':
        this.reset();
        return;

      case 'user_turn':
        await this.onUserTurn(msg);
        return;

      default:
        this.send({ type: 'error', message: `unknown message ${String(msg.type)}` });
    }
  }

  // -------------------------------------------------------------- interruption

  /**
   * Barge-in. The browser has already stopped its own audio locally; this
   * cancels the completion we are paying for, bumps the turn id so any tool
   * result still in flight is dropped, and truncates the assistant message to
   * what the customer actually heard.
   */
  private onBargeIn(partial: string): void {
    if (this.current) this.current.set('interrupted', true);

    this.state.onBargeIn(partial);
    this.runner.turnId = this.state.turnId;

    this.abort?.abort();
    this.abort = null;

    if (this.driver instanceof AnthropicDriver) {
      this.driver.truncateLastAssistant(this.spokenThisTurn);
    }

    this.send({ type: 'stop_audio', turn_id: this.turnSeq });
    this.finishTurn('');
    this.pushState();
  }

  private onAudioFirstFrame(turnId: number, tClient: number): void {
    const rec = this.turnRecords.find((r) => r.turn_id === turnId);
    if (rec && rec.t_audio_first_frame == null) {
      rec.t_audio_first_frame = this.clock.toServer(tClient);
      if (rec.t_speech_end != null && rec.t_audio_first_frame != null) {
        rec.first_audio_latency_ms = rec.t_audio_first_frame - rec.t_speech_end;
      }
      this.metricsWriter?.write(rec);
    }
  }

  // ------------------------------------------------------------------- a turn

  private async onUserTurn(msg: Inbound): Promise<void> {
    const text = String(msg.text ?? '').trim();
    if (!text) return;

    // A new turn always supersedes whatever was in flight.
    this.abort?.abort();
    const controller = new AbortController();
    this.abort = controller;

    // Generation stamp for staleness; sequence number for addressing.
    const generation = this.state.turnId;
    const turnId = ++this.turnSeq;
    this.runner.turnId = generation;
    this.spokenThisTurn = '';
    this.seq = 0;
    this.toolLogWatermark = this.runner.log.length;

    const metrics = new TurnMetrics({
      session_id: this.id,
      turn_id: turnId,
      driver: this.driver.name,
      model: this.driver.model,
      vad_silence_ms: this.vadSilenceMs,
      clock_offset_ms: Math.round(this.clock.offsetMs),
    });
    metrics.set('t_speech_end', this.clock.toServer(Number(msg.t_speech_end)));
    metrics.set('t_stt_final', this.clock.toServer(Number(msg.t_stt_final)));
    // Settle any audio-only interruption now that we know what was said.
    this.state.resolvePendingBargeIn(text);

    metrics.set('transcript', text);
    metrics.set('input_mode', msg.input_mode === 'typed' ? 'typed' : 'voice');
    metrics.set(
      'user_audio_ms',
      msg.speech_duration_ms == null ? null : Number(msg.speech_duration_ms),
    );
    this.current = metrics;

    try {
      await this.driver.handleTurn({
        text,
        runner: this.runner,
        state: this.state,
        slots: this.slots,
        turnId: generation,
        signal: controller.signal,
        onFirstToken: () => {
          if (metrics.get('t_llm_first_token') == null) metrics.set('t_llm_first_token', Date.now());
        },
        onSpeak: (chunk) => {
          if (controller.signal.aborted) return;
          if (metrics.get('t_tts_first_byte') == null) metrics.set('t_tts_first_byte', Date.now());
          this.spokenThisTurn = this.spokenThisTurn ? `${this.spokenThisTurn} ${chunk}` : chunk;
          metrics.appendReply(chunk);
          this.send({ type: 'speak', turn_id: turnId, seq: this.seq++, text: chunk });
        },
      });
    } catch (err) {
      if (!controller.signal.aborted) {
        const message = err instanceof Error ? err.message : String(err);
        this.send({ type: 'error', message });
        this.send({
          type: 'speak',
          turn_id: turnId,
          seq: this.seq++,
          text: 'Sorry, something went wrong at my end. Could you say that again?',
        });
      }
    }

    if (controller.signal.aborted) return;
    this.abort = null;
    this.finishTurn(this.spokenThisTurn);
    this.send({ type: 'agent_done', turn_id: turnId, reply: this.spokenThisTurn });
    this.pushState();
  }

  private finishTurn(reply: string): void {
    const metrics = this.current;
    if (!metrics) return;
    this.current = null;

    for (const entry of this.runner.log.slice(this.toolLogWatermark)) {
      metrics.addToolCall(entry.name, entry.duration_ms);
    }
    const usage = this.driver.usage();
    metrics.set('input_tokens', usage.input_tokens);
    metrics.set('output_tokens', usage.output_tokens);
    if (reply) metrics.set('reply', reply);

    const record = metrics.finalise();
    this.turnRecords.push(record);
    // Written again, with the audio stamp filled in, when the browser reports it.
    this.metricsWriter?.write(record);
  }

  private reset(): void {
    this.abort?.abort();
    this.abort = null;
    this.slots = emptySlots();
    this.state.startNewRequest();
    this.state.state = 'idle';
    this.runner.setContext({ conversationId: this.state.conversationId });
    this.pushState();
  }
}

/** Anthropic when a key is present, the deterministic planner otherwise. */
export function makeDriver(env: NodeJS.ProcessEnv = process.env): AgentDriver {
  const key = env.ANTHROPIC_API_KEY?.trim();
  if (key) {
    return new AnthropicDriver({
      apiKey: key,
      model: env.ANTHROPIC_MODEL?.trim() || 'claude-haiku-4-5-20251001',
      ...(env.ANTHROPIC_BASE_URL?.trim() ? { baseURL: env.ANTHROPIC_BASE_URL.trim() } : {}),
    });
  }
  return new DeterministicPlanner();
}
