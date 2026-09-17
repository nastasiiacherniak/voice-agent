/**
 * Reads metrics/turns.jsonl and prints the latency table for the submission.
 * ARCHITECTURE.md §12.
 */
import 'dotenv/config';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { TurnRecord } from '../src/voice/metrics.js';

const path = resolve(process.cwd(), process.argv[2] ?? 'metrics/turns.jsonl');
if (!existsSync(path)) {
  console.error(`no metrics at ${path} - run a conversation first`);
  process.exit(1);
}

/** The file is append-only; a turn is rewritten once its audio stamp lands. */
const byTurn = new Map<string, TurnRecord>();
for (const line of readFileSync(path, 'utf8').split('\n')) {
  if (!line.trim()) continue;
  const r = JSON.parse(line) as TurnRecord;
  byTurn.set(`${r.session_id}:${r.turn_id}`, r);
}
const turns = [...byTurn.values()];

function pct(values: number[], p: number): number | null {
  const v = values.filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (v.length === 0) return null;
  const idx = Math.min(v.length - 1, Math.max(0, Math.ceil((p / 100) * v.length) - 1));
  return Math.round(v[idx]!);
}

function stage(from: keyof TurnRecord, to: keyof TurnRecord): number[] {
  return turns
    .map((t) => {
      const a = t[from] as number | null;
      const b = t[to] as number | null;
      return a != null && b != null ? b - a : NaN;
    })
    .filter((n) => Number.isFinite(n) && n >= 0);
}

const voiceTurns = turns.filter((t) => (t.input_mode ?? 'voice') === 'voice');
const typedTurns = turns.filter((t) => t.input_mode === 'typed');

const latencies = (ts: TurnRecord[]) =>
  ts.map((t) => t.first_audio_latency_ms).filter((n): n is number => n != null);

const headline = latencies(voiceTurns);
const typedLatencies = latencies(typedTurns);

const vad = turns[0]?.vad_silence_ms ?? 0;

const rows: Array<[string, number[]]> = [
  ['end of speech -> final transcript', stage('t_speech_end', 't_stt_final')],
  ['final transcript -> first token', stage('t_stt_final', 't_llm_first_token')],
  ['first token -> first TTS byte', stage('t_llm_first_token', 't_tts_first_byte')],
  ['first TTS byte -> first audio frame', stage('t_tts_first_byte', 't_audio_first_frame')],
];

console.log(`# Latency report\n`);
console.log(`Turns recorded: ${turns.length}  (with an audio stamp: ${headline.length})`);
console.log(`Drivers: ${[...new Set(turns.map((t) => `${t.driver} ${t.model}`))].join(', ')}`);
console.log(`Clock offset applied: ${turns[0]?.clock_offset_ms ?? 0} ms\n`);

console.log('## Headline: end of user speech -> first audible word\n');

if (headline.length === 0) {
  console.log(
    '_No microphone turns recorded yet._ Open the app in Chrome or Edge, press "Start talking"' +
      ' and hold a conversation; the voice numbers land here.\n',
  );
} else {
  console.log('Voice turns (microphone, includes the end-of-turn silence wait):\n');
  console.log('| metric | ms |');
  console.log('| --- | --- |');
  console.log(`| p50 | ${pct(headline, 50)} |`);
  console.log(`| p95 | ${pct(headline, 95)} |`);
  console.log(`| min | ${Math.min(...headline)} |`);
  console.log(`| max | ${Math.max(...headline)} |`);
  console.log(`| p50 excluding the ${vad} ms end-of-turn silence | ${pct(headline, 50)! - vad} |`);
  console.log(
    `\nThe end-of-turn silence threshold is ${vad} ms. It is a tuning choice, not a system limit,` +
      ' and it is the dominant additive term - subtract it to compare the machinery itself.\n',
  );
}

if (typedLatencies.length) {
  console.log(
    `Typed turns (${typedLatencies.length}) bypass the microphone and the silence wait entirely,` +
      ' so they measure the server plus TTS start-up only, and the VAD threshold must not be' +
      ' subtracted from them:\n',
  );
  console.log('| metric | ms |');
  console.log('| --- | --- |');
  console.log(`| p50 | ${pct(typedLatencies, 50)} |`);
  console.log(`| p95 | ${pct(typedLatencies, 95)} |`);
  console.log('');
}

console.log('## Stage breakdown\n');
console.log('| stage | p50 ms | p95 ms | samples |');
console.log('| --- | --- | --- | --- |');
for (const [label, values] of rows) {
  console.log(`| ${label} | ${pct(values, 50) ?? '-'} | ${pct(values, 95) ?? '-'} | ${values.length} |`);
}

const toolCalls = turns.flatMap((t) => t.t_tool_calls);
if (toolCalls.length) {
  console.log('\n## Tool calls\n');
  console.log('| tool | calls | p50 ms | p95 ms |');
  console.log('| --- | --- | --- | --- |');
  for (const name of [...new Set(toolCalls.map((c) => c.name))]) {
    const d = toolCalls.filter((c) => c.name === name).map((c) => c.duration_ms);
    console.log(`| ${name} | ${d.length} | ${pct(d, 50)} | ${pct(d, 95)} |`);
  }
}

const interrupted = turns.filter((t) => t.interrupted).length;
console.log(`\nInterrupted turns: ${interrupted} of ${turns.length}`);
