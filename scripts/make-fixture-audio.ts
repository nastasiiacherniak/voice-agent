/**
 * Generates a shareable WAV per user turn from the expected/*.yaml fixtures,
 * using the local Windows SAPI voice. No API key, no cloud, nothing to licence.
 *
 * These are for exercising the microphone path by playing them at the mic, and
 * as shareable stand-in material. The automated harness in
 * tests/conversations.test.ts injects the transcripts directly - see the README
 * section "What the audio fixtures do and do not prove".
 *
 * To use your own voice instead, record over any file with the same name:
 *   npm run fixtures:record -- 01-normal-booking-turn1
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';

const EXPECTED = resolve(process.cwd(), 'tests/fixtures/expected');
const AUDIO = resolve(process.cwd(), 'tests/fixtures/audio');
mkdirSync(AUDIO, { recursive: true });

interface Fixture {
  id: string;
  turns: Array<{ user?: string; barge_in?: string }>;
}

const jobs: Array<{ file: string; text: string }> = [];
const manifest: Array<{ fixture: string; turn: number; file: string; text: string; kind: string }> = [];

for (const name of readdirSync(EXPECTED).filter((f) => f.endsWith('.yaml')).sort()) {
  const fx = parse(readFileSync(resolve(EXPECTED, name), 'utf8')) as Fixture;
  fx.turns.forEach((turn, i) => {
    const text = turn.user ?? turn.barge_in;
    if (!text) return;
    const file = `${fx.id}-turn${i + 1}.wav`;
    jobs.push({ file: resolve(AUDIO, file), text });
    manifest.push({
      fixture: fx.id,
      turn: i + 1,
      file,
      text,
      kind: turn.barge_in ? 'barge_in' : 'user',
    });
  });
}

const ps = [
  'Add-Type -AssemblyName System.Speech',
  '$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer',
  '$synth.Rate = 0',
  ...jobs.flatMap((j) => [
    `$synth.SetOutputToWaveFile(${JSON.stringify(j.file)})`,
    `$synth.Speak(${JSON.stringify(j.text)})`,
  ]),
  '$synth.SetOutputToNull()',
  '$synth.Dispose()',
  `Write-Output "generated ${jobs.length} files"`,
].join('\n');

const scriptPath = resolve(AUDIO, '_generate.ps1');
writeFileSync(scriptPath, ps, 'utf8');

console.log(`synthesising ${jobs.length} utterances with the local Windows voice...`);
const out = execFileSync(
  'powershell',
  ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
  { encoding: 'utf8' },
);
console.log(out.trim());

writeFileSync(
  resolve(AUDIO, 'manifest.json'),
  `${JSON.stringify({ generated_at: new Date().toISOString(), voice: 'windows-sapi', clips: manifest }, null, 2)}\n`,
  'utf8',
);
console.log(`wrote ${resolve(AUDIO, 'manifest.json')}`);
