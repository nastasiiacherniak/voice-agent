/**
 * Turn timing. ARCHITECTURE.md §12.
 *
 * STT and TTS run in the browser, so three of the six stamps are taken on the
 * client clock. A short ping exchange at session start measures the offset,
 * and every client stamp is converted into server time before it is written -
 * otherwise the headline number is measuring clock skew.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export interface TurnRecord {
  session_id: string;
  turn_id: number;
  /** VAD detected end of user speech (server clock, ms). */
  t_speech_end: number | null;
  t_stt_final: number | null;
  t_llm_first_token: number | null;
  t_tool_calls: Array<{ name: string; duration_ms: number }>;
  t_tts_first_byte: number | null;
  t_audio_first_frame: number | null;
  /** The headline metric: first audible answer minus end of user speech. */
  first_audio_latency_ms: number | null;
  vad_silence_ms: number;
  clock_offset_ms: number;
  driver: string;
  model: string;
  transcript: string;
  reply: string;
  input_tokens: number;
  output_tokens: number;
  reply_characters: number;
  user_audio_ms: number | null;
  interrupted: boolean;
  /** 'voice' turns waited for the end-of-turn silence; 'typed' ones did not. */
  input_mode: 'voice' | 'typed';
}

export class ClockSync {
  private samples: number[] = [];

  /** serverTime ~= clientTime + offset */
  addSample(clientSent: number, serverSeen: number, clientReceived: number): void {
    this.samples.push(serverSeen - (clientSent + clientReceived) / 2);
  }

  get offsetMs(): number {
    if (this.samples.length === 0) return 0;
    const s = [...this.samples].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)]!;
  }

  toServer(clientTime: number | null | undefined): number | null {
    if (clientTime == null) return null;
    return Math.round(clientTime + this.offsetMs);
  }
}

export class TurnMetrics {
  private record: TurnRecord;

  constructor(init: Pick<TurnRecord, 'session_id' | 'turn_id' | 'driver' | 'model' | 'vad_silence_ms' | 'clock_offset_ms'>) {
    this.record = {
      ...init,
      t_speech_end: null,
      t_stt_final: null,
      t_llm_first_token: null,
      t_tool_calls: [],
      t_tts_first_byte: null,
      t_audio_first_frame: null,
      first_audio_latency_ms: null,
      transcript: '',
      reply: '',
      input_tokens: 0,
      output_tokens: 0,
      reply_characters: 0,
      user_audio_ms: null,
      interrupted: false,
      input_mode: 'voice',
    };
  }

  set<K extends keyof TurnRecord>(key: K, value: TurnRecord[K]): void {
    this.record[key] = value;
  }

  get<K extends keyof TurnRecord>(key: K): TurnRecord[K] {
    return this.record[key];
  }

  appendReply(text: string): void {
    this.record.reply = this.record.reply ? `${this.record.reply} ${text}` : text;
    this.record.reply_characters = this.record.reply.length;
  }

  addToolCall(name: string, durationMs: number): void {
    this.record.t_tool_calls.push({ name, duration_ms: durationMs });
  }

  finalise(): TurnRecord {
    const { t_audio_first_frame, t_speech_end } = this.record;
    if (t_audio_first_frame != null && t_speech_end != null) {
      this.record.first_audio_latency_ms = t_audio_first_frame - t_speech_end;
    }
    return this.record;
  }
}

export class MetricsWriter {
  constructor(private readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
  }

  write(record: TurnRecord): void {
    appendFileSync(this.path, `${JSON.stringify(record)}\n`, 'utf8');
  }
}
