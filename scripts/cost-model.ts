/**
 * Cost per conversation minute. ARCHITECTURE.md §13.
 *
 * Takes the real token and character counts logged during the runs, plus the
 * rate table in rates.yaml, and prints the per-component split for three
 * stacks: the shipped browser cascade, the same cascade on cloud services, and
 * a realtime speech-to-speech alternative.
 *
 * User-speaking minutes and agent-speaking minutes are modelled separately -
 * they consume different services.
 */
import 'dotenv/config';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import type { TurnRecord } from '../src/voice/metrics.js';

const rates = parse(readFileSync(resolve(process.cwd(), 'rates.yaml'), 'utf8')) as any;
const metricsPath = resolve(process.cwd(), process.argv[2] ?? 'metrics/turns.jsonl');

if (!existsSync(metricsPath)) {
  console.error(`no metrics at ${metricsPath} - run a conversation first`);
  process.exit(1);
}

const byTurn = new Map<string, TurnRecord>();
for (const line of readFileSync(metricsPath, 'utf8').split('\n')) {
  if (!line.trim()) continue;
  const r = JSON.parse(line) as TurnRecord;
  byTurn.set(`${r.session_id}:${r.turn_id}`, r);
}
const turns = [...byTurn.values()];
if (turns.length === 0) {
  console.error('metrics file has no turns');
  process.exit(1);
}

const CHARS_PER_TOKEN: number = rates.speech.characters_per_token;
const AGENT_CPM: number = rates.speech.agent_characters_per_minute;
const USER_WPM: number = rates.speech.user_words_per_minute;

// ------------------------------------------------------------------ measured

let userMinutes = 0;
let agentChars = 0;
let measuredIn = 0;
let measuredOut = 0;

for (const t of turns) {
  userMinutes +=
    t.user_audio_ms != null
      ? t.user_audio_ms / 60_000
      : t.transcript.split(/\s+/).filter(Boolean).length / USER_WPM;
  agentChars += t.reply_characters;
}

// usage() is cumulative per session, so take the largest value seen per session.
for (const sessionId of new Set(turns.map((t) => t.session_id))) {
  const s = turns.filter((t) => t.session_id === sessionId);
  measuredIn += Math.max(...s.map((t) => t.input_tokens));
  measuredOut += Math.max(...s.map((t) => t.output_tokens));
}

const tokensMeasured = measuredIn > 0 || measuredOut > 0;

/**
 * When a run had no LLM attached (the deterministic planner counts no tokens),
 * estimate what the same conversation would have cost on Haiku 4.5: a growing
 * prompt replayed each turn, plus the fixed tool-schema overhead.
 */
const SYSTEM_PROMPT_CHARS = 1500;
const toolOverhead: number = rates.llm['claude-haiku-4-5'].tool_system_prompt_tokens;

let estIn = 0;
let estOut = 0;
if (!tokensMeasured) {
  let historyChars = 0;
  for (const t of turns) {
    historyChars += t.transcript.length + t.reply.length;
    estIn += Math.round((SYSTEM_PROMPT_CHARS + historyChars) / CHARS_PER_TOKEN) + toolOverhead;
    estOut += Math.round(t.reply.length / CHARS_PER_TOKEN);
  }
}

const inTokens = tokensMeasured ? measuredIn : estIn;
const outTokens = tokensMeasured ? measuredOut : estOut;

const agentMinutes = agentChars / AGENT_CPM;
const conversationMinutes = userMinutes + agentMinutes;

// --------------------------------------------------------------- the stacks

const llm = rates.llm['claude-haiku-4-5'];
const llmCost =
  (inTokens / 1e6) * llm.input_per_mtok + (outTokens / 1e6) * llm.output_per_mtok;

const browserStack = {
  stt: 0,
  tts: 0,
  llm: llmCost,
};

const cloudStack = {
  stt: userMinutes * rates.stt.deepgram_nova_3_streaming.per_minute,
  tts: (agentChars / 1000) * rates.tts.deepgram_aura_2.per_1k_characters,
  llm: llmCost,
};

const s2s = rates.speech_to_speech.openai_gpt_realtime;
const audioTokPerMin: number = s2s.assumed_audio_tokens_per_minute;
// Realtime replays the audio context each turn, so input audio tokens
// accumulate across the conversation rather than being paid for once.
let realtimeAudioIn = 0;
{
  let minutesSoFar = 0;
  for (const t of turns) {
    const turnUserMin =
      t.user_audio_ms != null
        ? t.user_audio_ms / 60_000
        : t.transcript.split(/\s+/).filter(Boolean).length / USER_WPM;
    minutesSoFar += turnUserMin;
    realtimeAudioIn += minutesSoFar * audioTokPerMin;
  }
}
const s2sCost =
  (realtimeAudioIn / 1e6) * s2s.audio_input_per_mtok +
  ((agentMinutes * audioTokPerMin) / 1e6) * s2s.audio_output_per_mtok;

// ------------------------------------------------------------------- output

const money = (n: number) => `$${n.toFixed(4)}`;
const perMin = (n: number) => `$${(n / conversationMinutes).toFixed(4)}`;

console.log('# Cost model\n');
console.log(`Rate card fetched: ${rates.fetched_at}`);
console.log(`Turns: ${turns.length} across ${new Set(turns.map((t) => t.session_id)).size} session(s)`);
console.log(`User speaking: ${userMinutes.toFixed(2)} min`);
console.log(`Agent speaking: ${agentMinutes.toFixed(2)} min (${agentChars} characters)`);
console.log(`Conversation minutes: ${conversationMinutes.toFixed(2)}`);
console.log(
  `LLM tokens: ${inTokens} in / ${outTokens} out ` +
    (tokensMeasured ? '(measured from API usage)' : '(ESTIMATED - no LLM key on this run)'),
);
console.log('');

console.log('| component | browser cascade (shipped) | cloud cascade | speech-to-speech |');
console.log('| --- | --- | --- | --- |');
console.log(
  `| STT | ${money(browserStack.stt)} (Web Speech) | ${money(cloudStack.stt)} (Nova-3) | included |`,
);
console.log(
  `| TTS | ${money(browserStack.tts)} (speechSynthesis) | ${money(cloudStack.tts)} (Aura-2) | included |`,
);
console.log(`| LLM | ${money(browserStack.llm)} (Haiku 4.5) | ${money(cloudStack.llm)} | - |`);
console.log(`| audio model | - | - | ${money(s2sCost)} (gpt-realtime) |`);

const browserTotal = browserStack.stt + browserStack.tts + browserStack.llm;
const cloudTotal = cloudStack.stt + cloudStack.tts + cloudStack.llm;

console.log(`| **total** | **${money(browserTotal)}** | **${money(cloudTotal)}** | **${money(s2sCost)}** |`);
console.log(
  `| **per conversation minute** | **${perMin(browserTotal)}** | **${perMin(cloudTotal)}** | **${perMin(s2sCost)}** |`,
);

console.log(
  `\nSpeech-to-speech is ${(s2sCost / cloudTotal).toFixed(1)}x the cloud cascade on this workload.`,
);
console.log(
  'Audio tokens accumulate in the realtime context, so that multiple grows with conversation length' +
    ' rather than staying flat.',
);
if (!rates.speech_to_speech.openai_gpt_realtime.assumption_verified) {
  console.log(
    `\nCaveat: the speech-to-speech column assumes ${audioTokPerMin} audio tokens per minute,` +
      ' which is not stated on the vendor pricing page. Order of magnitude, not a quote.',
  );
}
if (!tokensMeasured) {
  console.log(
    '\nCaveat: this run used the deterministic planner, so LLM token counts are estimated from' +
      ' transcript length at ' +
      `${CHARS_PER_TOKEN} characters per token. Set ANTHROPIC_API_KEY and re-run for measured counts.`,
  );
}
