/* Records a fixture clip from the microphone and writes it back into
 * tests/fixtures/audio/ as a 16-bit PCM WAV, replacing the synthesised one. */

const clipsEl = document.getElementById('clips');
const statusEl = document.getElementById('status');

let audioCtx = null;
let active = null; // { file, stream, source, processor, chunks, sampleRate }

function note(msg, bad = false) {
  statusEl.hidden = false;
  statusEl.textContent = msg;
  statusEl.style.borderColor = bad ? 'var(--bad)' : 'var(--good)';
  statusEl.style.color = bad ? 'var(--bad)' : 'var(--good)';
}

/** Float32 [-1,1] frames -> a 16-bit mono PCM WAV. */
function encodeWav(chunks, sampleRate) {
  const length = chunks.reduce((n, c) => n + c.length, 0);
  const buffer = new ArrayBuffer(44 + length * 2);
  const view = new DataView(buffer);
  const ascii = (offset, str) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };

  ascii(0, 'RIFF');
  view.setUint32(4, 36 + length * 2, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, 'data');
  view.setUint32(40, length * 2, true);

  let offset = 44;
  for (const chunk of chunks) {
    for (let i = 0; i < chunk.length; i++) {
      const s = Math.max(-1, Math.min(1, chunk[i]));
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      offset += 2;
    }
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

async function startRecording(clip, row, button) {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  audioCtx = audioCtx ?? new AudioContext();
  await audioCtx.resume();

  const source = audioCtx.createMediaStreamSource(stream);
  const processor = audioCtx.createScriptProcessor(4096, 1, 1);
  const chunks = [];

  processor.onaudioprocess = (e) => chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
  source.connect(processor);
  processor.connect(audioCtx.destination);

  active = { file: clip.file, stream, source, processor, chunks, sampleRate: audioCtx.sampleRate };
  row.classList.add('recording');
  button.textContent = 'Stop and save';
  button.classList.add('rec');
}

async function stopRecording(row, button) {
  if (!active) return;
  const { file, stream, source, processor, chunks, sampleRate } = active;
  processor.disconnect();
  source.disconnect();
  for (const track of stream.getTracks()) track.stop();
  active = null;

  row.classList.remove('recording');
  button.textContent = 'Re-record';
  button.classList.remove('rec');

  const blob = encodeWav(chunks, sampleRate);
  const res = await fetch(`/api/fixture-audio/${encodeURIComponent(file)}`, {
    method: 'POST',
    headers: { 'content-type': 'audio/wav' },
    body: blob,
  });

  if (res.ok) {
    row.classList.add('saved');
    note(`saved ${file} (${(blob.size / 1024).toFixed(0)} kB)`);
  } else {
    note(`could not save ${file}: ${await res.text()}`, true);
  }
}

async function load() {
  const res = await fetch('/api/fixture-clips');
  if (!res.ok) {
    note('no manifest yet - run "npm run fixtures:audio" first', true);
    return;
  }
  const { clips } = await res.json();

  for (const clip of clips) {
    const row = document.createElement('div');
    row.className = 'clip';

    const say = document.createElement('div');
    say.className = 'say';
    say.textContent = clip.text;

    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = clip.file;

    const play = document.createElement('button');
    play.textContent = 'Play current';
    play.onclick = () => new Audio(`/fixture-audio/${clip.file}`).play();

    const rec = document.createElement('button');
    rec.textContent = 'Record';
    rec.onclick = async () => {
      try {
        if (active && active.file === clip.file) await stopRecording(row, rec);
        else if (active) note('finish the clip you are recording first', true);
        else await startRecording(clip, row, rec);
      } catch (err) {
        note(String(err && err.message ? err.message : err), true);
      }
    };

    row.append(say, meta, play, rec);
    clipsEl.appendChild(row);
  }
}

load();
