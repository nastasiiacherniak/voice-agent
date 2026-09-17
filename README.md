# Voice equipment booking agent

A browser voice agent for a small equipment rental desk. One person at a time speaks to it, asks
for equipment and dates, changes their mind, and confirms. The agent checks real inventory in a
local SQLite database and writes exactly one reservation, only after explicit spoken confirmation.

**[Try it live](https://nastasiiacherniak.github.io/voice-agent/)** — the whole thing, running in
the page. See [The live demo](#the-live-demo) for what that costs.

Built against the handoff spec in [ARCHITECTURE.md](ARCHITECTURE.md). Where this implementation
departs from that spec, it says so and why — see [Deviations](#deviations-from-architecturemd).

---

## Run it

```bash
npm install
npm run seed
npm start
```

Then open **http://localhost:8787** in **Chrome or Edge** (the voice path uses the Web Speech API)
and press **Start talking**.

There is no API key required to run the whole product. See [Which brain is driving](#which-brain-is-driving).

```bash
npm test        # 145 tests: domain, gate, state machine, six recorded conversations
npm run latency # latency percentiles from metrics/turns.jsonl
npm run cost    # cost per conversation minute, three stacks
npm run snapshot # dump the database as markdown
npm run build:pages && npm run preview:pages   # the static demo, on :8788
```

## The live demo

GitHub Pages serves files, not processes, so there is no Node to hold the session and no disk to
hold the database. The demo does not fake that: **the server runs in the page**. The same
`Session`, the same `DeterministicPlanner`, the same SQL against the same schema — SQLite itself
comes along as [sql.js](https://sql.js.org), compiled to WebAssembly (658 kB).

The substitution is four aliases in [`scripts/build-pages.ts`](scripts/build-pages.ts) and the
shims in [`src/browser/shims/`](src/browser/shims/):

| Alias | Stands in for | Why |
| --- | --- | --- |
| `better-sqlite3` | [`sqlite.ts`](src/browser/shims/sqlite.ts) | the native module cannot load in a browser; sql.js runs the same engine |
| `node:crypto` | [`crypto.ts`](src/browser/shims/crypto.ts) | Web Crypto's digest is async and the hold tokens are synchronous throughout |
| `node:fs` / `node:path` | [`node-fs.ts`](src/browser/shims/node-fs.ts) | no filesystem; the database is in memory and the metrics go nowhere |
| `src/agent/llm.ts` | [`llm.ts`](src/browser/shims/llm.ts) | keeps the Anthropic SDK — and a key-shaped hole — out of a public page |

Nothing under `src/booking` or `src/agent` is forked for the browser, and `app.js` takes exactly one
branch: when `window.__voiceBookingDemo` is present it gets a socket-shaped object from
[`src/browser/demo.ts`](src/browser/demo.ts) instead of a `WebSocket`. The protocol across it is
unchanged.

So the on-screen proof still holds: the panel renders what a real SQL query returns, the unique
index on `hold_hash` still refuses the second "yes", and the whole voice path works — Pages is
HTTPS, which is what the Web Speech API requires.

Three things differ from `npm start`, all of them consequences of having no server:

- **The database lives in the tab.** A reload reseeds it; nobody else sees your bookings.
- **The deterministic planner always drives.** A static page cannot hold an API key — anything
  shipped to it is public. To see the LLM driver, run it locally with `ANTHROPIC_API_KEY` set.
- **Per-turn metrics are dropped** rather than appended to `metrics/turns.jsonl`, so `npm run latency`
  has nothing to read from a Pages session. The first-answer readout in the navbar still works; it
  is measured in the browser.

Pushing to `main` rebuilds and redeploys it ([`.github/workflows/pages.yml`](.github/workflows/pages.yml)).

### Seeded inventory

| Item | Stock |
| --- | --- |
| Camera A | 2 |
| Tripod B | 3 |
| Microphone C | 1 |

Plus one existing booking: **Camera A, 10–12 October 2026 inclusive**. `npm run seed` drops and
recreates, so every run starts identical. The server also reseeds on boot unless `NO_RESEED=1`.

---

## What you should see

Say: *"I'd like a tripod from the 14th to the 16th of October 2026."* → the agent checks the
database, reads the booking back, and asks. Say *"yes, confirm"* → one row appears in the
reservations table on the right and the stock count drops. Say *"yes, confirm"* again → it tells
you it is already booked and **no second row appears**.

The right-hand panel reads from `/api/state`, which reads the database. It never renders anything
the model said. That is the on-screen proof the write actually happened.

### The interface

Light theme, Lucide icons, two regions under a sticky top bar. The **navbar** carries the brand mark
(`src/web/brand-mark.svg`, traced from the supplied raster and masked so it takes the brand violet from
`--accent`),
the first-answer latency readout, Reset demo data and a notepad toggle that reveals or hides the
state panel (the button takes a pressed state while the panel is open). **The panel starts closed**,
so the on-screen proof of the database write is one click away rather than always visible - flip
the initial `panel-open` class on `body` if you would rather it opened by default. The **centre stage** fills the viewport: the
greeting is centred while the desk is idle, and once turns arrive the transcript takes the whole
column and scrolls inside itself so the composer stays pinned at the foot of the screen. The
composer has a clip on the left and the microphone and send buttons on the right — the arrow is
disabled until you type something, and the microphone swaps to a mic-off glyph while it is open -
same colours either way, since the beams and the placeholder already carry that state. Nothing is painted behind the composer: the page ground runs clean up to its edge, and the
only colour down there is the two beams on the element itself. Opening the microphone drops the composer to the foot of the screen; there is nothing
above it, because the composer itself is the status display — see
[The composer is the status display](#the-composer-is-the-status-display). The **state panel** on the right holds conversation
state, inventory, the booking card, reservations and the live tool-call log.
Its "State" heading sits outside the scrolling area - the panel is a flex column of a fixed header
and a scrolling body - so the heading stays put and the scrollbar begins beneath it rather than
running the full height of the card. Both scrolling panes use a slim, arrowless scrollbar inset
from the rounded edge. The panel is never a layout column: it floats as a 312px drawer at 1440px and wider, and sits in the
flow under the conversation below that, so opening it never shifts the composer off the centre of the
screen. The scrollbar gutter is reserved for the same reason. On the opening screen a slow band of colour travels around the composer's edge; it fades
out the moment you click into the field, start a conversation, or open the microphone.

Screen-level changes - greeting to conversation, opening the microphone - run
through the View Transitions API, so the composer, transcript and panel tween between layouts
instead of cutting. Entering voice mode is staggered rather than dissolved - the greeting and chips clear out over the
first 100ms and the composer travels 100-300ms. Overlapping them meant watching the chips fade straight through the moving composer. CSS cannot transition `justify-content` or elements entering the flow, which is
what those changes actually are. A skipped or unsupported transition applies the same DOM change
instantly, so nothing depends on it. The panel is deliberately excluded: it is the only thing that
moves when it opens, and a view transition would cross-fade the whole page root around it, which
reads as a flicker. It animates itself with `@starting-style` and `allow-discrete` instead. Below 1100px the stage returns to
normal document flow;
below 720px the navbar wraps.

#### The composer is the status display

There is no orb and no separate status line. What the desk is doing shows up in the two places the
eye is already on: the composer's placeholder reads **Ask anything…**, **Listening…**, **Thinking…**
or **Speaking…**, and the composer itself carries two beams.

[`border-beam`](https://www.npmjs.com/package/border-beam)'s `BorderBeam` travels a band of colour
around the composer's edge. It runs only on the opening screen and only while the field is
untouched — clicking in, opening the microphone or starting a conversation all fade it out — which
is exactly what the hand-rolled conic gradient it replaced did, at the same 4s pace and 0.9
strength.

[`voice-glow`](https://www.npmjs.com/package/voice-glow)'s `VoiceBeam` blooms along the bottom
edge and rises with the voice. With the microphone open it is fed the live capture and follows what
the customer is actually saying; while the agent is thinking, `processing` gathers it into a single
beam that sweeps the composer's width.

Two notes on how they are wired, since both libraries are React and this page is not:

- **One React island.** `src/web/composer-beams.entry.jsx` nests `<BorderBeam><VoiceBeam>` around an
  empty host node and moves the existing `<form>` into it. React never owns children there, so it
  never diffs the form away and every listener `app.js` attached survives. `npm run build:web`
  bundles it (with React) to `src/web/vendor/composer-beams.js`, which is what the page loads;
  `prestart` and `predev` run it, so `npm start` is still the only command. It is the one bundled
  file in `src/web` and it is gitignored. That bundle is ~320 kB minified, most of it React — the
  price of the two components. `voice-glow` detects its corner radius from the host node's CSS;
  `border-beam`'s first child is the voice wrapper, which has no corner of its own, so the island
  measures the composer once at mount and passes the number in.
- **No third microphone.** `voice-glow` ships a `useMicrophone` hook; this app does not use it. The
  page already opens two captures (the recogniser's, and the echo-cancelled one behind barge-in),
  and a third would be a third permission-holding stream of the same voice. The beam is handed
  `MicMonitor`'s existing stream instead. Because that one is echo-cancelled, the glow follows the
  customer and not the agent's own playback.

Placeholder text is only announced by a screen reader while the field has focus, so the same status
also goes to an `aria-live` region next to the composer.

The fixture recorder is still served at `/recorder.html`; it no longer has a navbar link.

Connection trouble is reported in the transcript ("connection lost - reconnecting…", "not sent -
waiting for the connection to come back") rather than in a status line, and the session id, driver
and VAD threshold are logged to the browser console at connect.

---

## Which brain is driving

Two interchangeable drivers implement the same interface, call the same three tools and obey the
same state machine:

| Driver | When it runs | Notes |
| --- | --- | --- |
| **Anthropic Haiku 4.5** | `ANTHROPIC_API_KEY` is set in `.env` | Streaming, `temperature: 0`, pinned model id, tool loop, abortable mid-completion on barge-in |
| **Deterministic planner** | no key set (the default) | Regex/heuristic slot filling. Zero cost, zero variance, no network |

Copy `.env.example` to `.env` and add your key to use the model. **I have not run the Anthropic
driver** — I had no key in this environment — so while it is written, typechecked and wired
through the same guards, it is unverified against the live API. Everything reported below was
measured on the deterministic planner. This is the single biggest caveat in this submission.

The deterministic planner is not a demo stub: it parses whatever you actually say, and every one
of the six recorded checks runs through it against live inventory. It handles unusual phrasing
worse than a model would, which is exactly the tradeoff you take for zero variance.

---

## How the safety properties are enforced

None of the six acceptance criteria depend on the model behaving well. Each is enforced by a
mechanism below it.

| # | Criterion | Mechanism | Proven in |
| --- | --- | --- | --- |
| 1 | A normal booking writes exactly one correct row | `confirm_booking` is the only writer | `tools.test.ts`, fixture 01 |
| 2 | A date correction books the new dates, never the old | `state.ts` holds at most one token and the guard refuses any token that is not the live one | `tools.test.ts`, `state.test.ts`, fixture 02 |
| 3 | An unavailable request never becomes a booking | Only an `available` check mints a token, and `confirm_booking` re-checks before inserting | `tools.test.ts`, fixture 03 |
| 4 | Interruption stops audio and the agent does not finish its old sentence | recogniser suspended during playback; barge-in detected on an echo-cancelled stream in 140 ms, then `synth.cancel()` plus turn-generation stamping so stale tool results are dropped | `vad.test.ts`, `state.test.ts`, fixture 04 |
| 5 | Confirming twice makes one row | `UNIQUE INDEX` on `hold_hash` + idempotent-first ordering in `confirm_booking` | `tools.test.ts`, fixture 05 |
| 6 | Ambiguity produces a spoken question, not a guess | `dates.ts` returns `ambiguous` and no token is minted | `dates.test.ts`, fixture 06 |

### The three-step gate

`check_availability` → `propose_booking` → `confirm_booking`. The model never touches SQL and never
touches a date.

- **Only `check_availability` mints a hold token**, and only when the answer is `available`. There
  is no other path to a write, which makes criterion 3 structural rather than a rule the model is
  asked to follow.
- **`propose_booking` does not write.** It renders the read-back *from the token's contents*, so if
  the model has drifted from what was actually checked, the read-back exposes it.
- **`confirm_booking`** verifies the signature and TTL, checks for an existing row on `hold_hash`
  *first* (so a repeated "yes" is idempotent rather than being refused by its own booking), re-runs
  availability, then inserts `ON CONFLICT DO NOTHING`.

`hold_hash` is a SHA-256 over `{equipment, start, end, quantity, conversation_id}`, excluding the
issue time and nonce. Two confirmations of the same booking in one conversation collide on the
unique index; a genuinely different booking does not.

One subtlety worth calling out: an old token stays *cryptographically valid* after the customer
changes their mind. Signature checking alone would happily write a superseded booking. So the state
guard also requires the presented token to be **the currently held one**. That, not the signature,
is what makes criterion 2 hold.

### Confirmation must be explicit

`classifyConfirmation` in [`src/state.ts`](src/state.ts) is unit-tested against positives and
near-misses rather than left to the model. "yes", "confirm", "book it", "that's right, go ahead"
pass. These do not:

| Utterance | Why not |
| --- | --- |
| "yeah but can we change the dates" | carries a change |
| "yes, but make it three days" | carries a change |
| "sounds good" / "ok" | too weak on its own |
| "yes I was thinking about the camera and maybe a tripod as well" | too long to be a bare yes |
| silence | nothing said |

And a "yes" in any state other than `held`/`confirmed` is not a confirmation of anything, because
the guard refuses to dispatch `confirm_booking` from anywhere else.

---

## Dates are never the model's job

[`src/booking/dates.ts`](src/booking/dates.ts) parses deterministically and returns `resolved`,
`ambiguous` or `invalid`. All relative parsing is anchored to an injectable `now`, so fixtures stay
reproducible forever. The rules:

| Input | Result |
| --- | --- |
| "the tenth", "the 10th" | **ambiguous** — no month was said |
| "3/4/2026" | **ambiguous** — could be 3 April or 4 March |
| "March 3" said in September | **ambiguous** — this year has passed, did you mean next year? |
| "next week", "the weekend" | **ambiguous** — a span, not a day |
| "October 14" said in September | resolved to 2026-10-14 (this year, still ahead) |
| "the 14th" … "the 16th of October" | resolved — the start borrows the month from the explicit end |
| "14 October" … "the 16th" | resolved — the end is anchored to the start's month |
| "14 October" … "for 3 days" | resolved to 14–16 October (inclusive) |
| "next Friday" | the Friday of the following week, anchored to `now` |
| "31 February" | invalid |

Note what is deliberately *not* done: the month is never carried over from earlier in the
conversation. If you book 14–16 October and then say *"make it the 20th to the 22nd"*, the agent
asks which month. That is mildly annoying and it is the correct trade — the brief asks for
clarification on ambiguity, and silently inheriting context is exactly how a demo books the wrong
month. Say *"the 20th to the 22nd of October"* and it proceeds.

Availability uses **per-day peak usage**, not a range-level sum. A naive sum over-counts when two
bookings each overlap the request but not each other, and wrongly refuses valid bookings; there is
a test for precisely that case in `availability.test.ts`.

---

## Interruption

The browser stops its own audio the moment the recogniser produces any interim result while the
agent is speaking, so the audio stop does not wait for a server round trip. In parallel it sends
`barge_in`, and the server:

1. aborts the in-flight LLM completion — cancelled, not merely ignored, because those tokens cost money;
2. bumps a monotonic **turn generation**, so any tool result that lands afterwards is marked
   `discarded` and never reaches the model;
3. truncates the assistant message in history to **what was actually spoken**, so the model does not
   believe it said something the customer never heard;
4. drops the hold token.

**The agent must never hear itself.** `SpeechRecognition` opens its own microphone and cannot be
handed a processed stream, so while the agent speaks the recogniser transcribes the speaker output
as if the customer had said it. Filtering that out by text does not work: Chrome returns *final*
results seconds late, so echo arrives long after any "is the agent talking" window has closed.

So the recogniser is **switched off during playback** ([`src/web/app.js`](src/web/app.js)) —
`abort()`, not `stop()`, because `stop()` flushes pending results while `abort()` discards them.
It restarts 900 ms after playback ends, once the speaker tail has decayed.

That alone would remove barge-in, so interruption comes from a **second microphone capture opened
with `echoCancellation: true`** ([`src/web/vad.js`](src/web/vad.js)). The browser's AEC subtracts
what it is playing out, so energy on that stream while the agent talks is the customer, not the
agent. A gate fires when the level stays above an adaptive noise floor for **140 ms** — long enough
to reject a keystroke or a door, and with a 30 ms poll it stops audio inside the ~200 ms the brief
asks for.

Because that detector works on energy, an interruption arrives with **no transcript**. The state
machine therefore *defers* the decision: the hold is kept until the words land, and
`resolvePendingBargeIn` then drops it unless what was said is an explicit confirmation of the
read-back. Turn generations are still stamped immediately, so an in-flight tool result is dropped
either way.

The word-overlap scorer in [`src/web/echo.js`](src/web/echo.js) remains as a backstop for a final
result captured just before the abort, and it is no longer gated on "is the agent audible" —
precisely because those results arrive late.

The transcript pane only shows agent text **once it actually starts playing**. An interrupted
sentence that was queued but never spoken never appears — which is what you want to see when
checking criterion 4.

---

## The recorded test set

Six cases. The expected outcomes in `tests/fixtures/expected/*.yaml` were **written before the
harness was run**. They passed as written; two bugs in my code were fixed to make them pass
(`resolveEquipment` did not match plurals, and the planner logged the raw phrase rather than the
canonical id). No expectation was loosened to fit the output.

| # | Case | Expected tool calls | DB delta |
| --- | --- | --- | --- |
| 1 | Normal booking — Tripod B, 14–16 Oct | check → propose → confirm | +1 row |
| 2 | Corrected dates — 14–16 becomes 20–22 | check → propose → check → propose → confirm | +1 row, **20–22 only** |
| 3 | Insufficient stock — Camera A ×2, 11–13 Oct | check → `unavailable`; then "book it anyway" makes **no call at all** | **0 rows** |
| 4 | Interruption — cuts in and switches item | check → propose → *(barge-in)* → check → propose → confirm | +1 row, microphone, **no tripod row** |
| 5 | Repeated confirmation | check → propose → confirm(`created: true`) → confirm(`created: false`) | **+1 row total** |
| 6 | Ambiguous date — "the tenth" | check → `needs_clarification`, **no token**; then "October" → check → propose | **0 rows** (fixture ends before confirming) |

Run `npm test`. Each case writes a report to `reports/<id>.md` containing the transcript, the
**ordered tool-call log**, and the **before/after database tables**. The tool-call log is the thing
that proves the app processes new input rather than replaying canned answers for the demo — so it
is asserted, not just displayed.

Fixtures run through the production `Session` — same state machine, same `ToolRunner`, same guards.
Only the transport changes: turns arrive as messages instead of over a WebSocket from the browser.

### What the audio fixtures do and do not prove

`tests/fixtures/audio/` holds 17 WAV clips, one per user turn, generated locally with the Windows
SAPI voice (`npm run fixtures:audio`) — shareable material, no licence questions, no cloud.

**Be clear about what they are for.** The automated harness asserts at the STT boundary: it injects
the transcript and exercises every layer that carries the acceptance criteria, deterministically.
The WAVs let you drive the microphone path by hand — play a clip at the mic and watch the same flow
run end to end. They are not wired into `npm test`, because Chrome's `SpeechRecognition` accepts
only a live microphone, not an arbitrary audio stream. Closing that gap properly means a
file-capable cloud STT (Deepgram accepts a WAV upload); the adapter seam is there, the adapter is
not written.

To record the clips in your own voice, start the server and open
**http://localhost:8787/recorder.html**. It records from your microphone, encodes 16-bit PCM WAV
and writes it back over the synthesised clip under the same name. The expected outcomes do not
change — only the recording does.

---

## Latency

Six timestamps are recorded per turn to `metrics/turns.jsonl`. STT and TTS run in the browser, so
three of them are on the client clock; a five-ping exchange at session start measures the offset
and every client stamp is converted to server time before it is written. Otherwise the headline
number is partly measuring clock skew.

Measured on the deterministic planner, end of user input → first audible word:

| stage | p50 | p95 |
| --- | --- | --- |
| end of input → final transcript | 0 ms | 2 ms |
| final transcript → first token | 6 ms | 9 ms |
| first token → first TTS byte | 0 ms | 0 ms |
| **first TTS byte → first audio frame** | **301 ms** | **325 ms** |
| **total** | **305 ms** | **330 ms** |

The dominant term is not the agent — it is `speechSynthesis` start-up, about 300 ms before the
browser's local voice produces its first audio frame. The whole server-side turn, availability
check and all, is under 10 ms.

Two honest qualifications:

- These are **typed turns**. `npm run latency` separates voice turns from typed ones and refuses to
  subtract the VAD threshold from typed ones, because they never waited for silence. I have no
  microphone in this environment, so the voice column is empty until you run it. Press
  **Start talking**, hold a conversation, then `npm run latency`.
- The **end-of-turn silence threshold is 600 ms** (`VAD_SILENCE_MS`). For a real voice turn that is
  additive and dominant: expect roughly **900–950 ms** end of speech → first audible word, of which
  600 ms is a tuning choice rather than a system limit. The report prints the figure both ways.

With Haiku 4.5 driving instead of the planner, add time-to-first-token — realistically 200–400 ms,
and a second round trip on turns that call a tool. That is an estimate, not a measurement, because
I could not run the model.

---

## Cost

`npm run cost` reads the real token and character counts from the run and the rate table in
[`rates.yaml`](rates.yaml). Rates were **fetched on 2026-09-15**, not recalled — each entry carries
its source URL and a `verified` flag.

On a five-turn booking conversation (0.76 conversation minutes):

| component | browser cascade (shipped) | cloud cascade | speech-to-speech |
| --- | --- | --- | --- |
| STT | $0.0000 (Web Speech) | $0.0009 (Nova-3) | included |
| TTS | $0.0000 (speechSynthesis) | $0.0153 (Aura-2) | included |
| LLM | $0.0055 (Haiku 4.5) | $0.0055 | — |
| audio model | — | — | $0.0354 (gpt-realtime) |
| **per conversation minute** | **$0.0073** | **$0.0286** | **$0.0465** |

Caveats the script prints for itself: the LLM tokens are **estimated** from transcript length
(4 chars/token) because this run had no key to count them exactly; and the speech-to-speech column
assumes 600 audio tokens per minute, which is not stated on the vendor pricing page. Treat that
column as order-of-magnitude.

The interesting structural point is not the ratio at one minute, it is the shape. Realtime audio
tokens **accumulate in context**, so every turn re-pays for all prior audio and the gap widens with
conversation length. The cascade's LLM input grows too, but from a much smaller base, and text
tokens are 32× cheaper than audio input tokens on the rates above.

---

## The tradeoff I chose

**A cascaded pipeline — streaming STT → LLM with tools → streaming TTS — not a realtime
speech-to-speech model.** Speech-to-speech would be faster, roughly 300–800 ms to first audio
against 700–1200 ms for a cascade. I gave up that ~400 ms deliberately:

- **Measurability.** The brief asks for the delay from end of user turn to first audible answer. In
  a speech-to-speech model the turn boundary is internal, so that number can only be approximated.
  The cascade gives a real timestamp at every stage, which is how the table above can say the
  bottleneck is TTS start-up rather than guessing.
- **Testability.** The brief asks for a reproducible recorded test set whose expected outcomes are
  written first. A cascade lets fixtures run through the production code path with the transport
  swapped, at temperature 0, with zero variance. 145 tests run in under a second with no network.
- **Cost shape.** Audio tokens accumulating in context makes cost per minute rise non-linearly
  across a conversation. For a booking desk where calls run several minutes, that is the wrong
  curve.
- **Correctness under interruption.** The failure this brief is really probing is saving an
  obsolete choice. A cascade gives explicit seams to stamp turn generations and drop stale tool
  results. Inside a speech-to-speech model those seams are not exposed.

Within the cascade I then chose the **cheapest, fastest components that keep quality adequate**:
Haiku-class rather than a frontier model, because the reasoning here is trivial slot-filling and
time-to-first-token is what the user feels; and browser-native STT/TTS over cloud services, because
it costs nothing, needs no keys, and — as the latency table shows — its 300 ms TTS start-up is
comparable to a cloud round trip anyway. Cartesia or Aura would buy better-sounding audio and
sub-100 ms time-to-first-byte; they would cost about 4× per conversation minute, almost entirely in
TTS. For a rental desk, I would take the free voice until someone complains about it.

The quality cost of these choices is concentrated in one place, and it is worth naming: **the
deterministic planner understands less English than a model would.** Unusual phrasing gets a
clarifying question rather than a correct guess. That is the honest price of a demo that runs with
no key and gives identical results every time. Adding `ANTHROPIC_API_KEY` swaps in the model
without touching a single guard.

---

## Reused vs. my own work

**Reused as-is:** `better-sqlite3`, `express`, `ws`, `@anthropic-ai/sdk`, `yaml`, `vitest`, `tsx`,
`dotenv`. The browser's Web Speech API and `speechSynthesis`. Windows SAPI for fixture audio. The
architecture and acceptance criteria come from the supplied `ARCHITECTURE.md`.

**Written for this brief:** the whole booking domain layer (schema, per-day availability algebra,
the deterministic date parser), the hold-token mint/verify gate, the three tool contracts, the
conversation state machine and confirmation matcher, the barge-in and stale-result handling, the
browser voice layer (turn-end detection, echo guard, TTS queue and cancellation), the clock-sync
and latency instrumentation, the deterministic planner, the Anthropic driver and its sentence
chunker, the test harness and all 145 tests, the fixture recorder, and the latency/cost/snapshot
scripts.

**No third-party date library.** `dateparser` was specified; I wrote the parser instead so that the
three-way `resolved`/`ambiguous`/`invalid` contract is explicit rather than bolted onto a library
that always returns a best guess. Returning a best guess is the failure mode criterion 6 tests for.

---

## Deviations from ARCHITECTURE.md

The spec targets Python and Pipecat. Three deviations, all deliberate:

1. **Node/TypeScript instead of Python + Pipecat.** There is no working Python on the target
   machine — only the Windows Store stub. Rather than make the deliverable depend on an install,
   the pipeline is Node over a WebSocket. Everything that carries the acceptance criteria — schema,
   tool contracts, token gate, state machine, metrics fields — is 1:1 with the spec.
2. **Browser Web Speech API / `speechSynthesis` instead of Deepgram + Cartesia.** No API keys were
   available. The provider seam is at the browser boundary: swapping in cloud STT/TTS replaces
   `src/web/app.js` and nothing on the server. `rates.yaml` prices both.
3. **Barge-in does not always discard the hold.** §9 says an interruption from `held` drops the
   token. It does — *unless the interrupting utterance is itself an explicit confirmation*. A "yes,
   confirm" spoken over the read-back is confirming the very thing being read out; that choice is
   not obsolete. Every other interruption drops the token. `confirm_booking` re-verifies signature,
   TTL and availability regardless.

---

## What is unfinished

Stated plainly, as the spec asks:

- **The Anthropic driver has never been run.** Written, typechecked, wired through the same guards,
  but unverified against the live API. Add a key and expect to spend some time on prompt iteration.
- **The audio fixtures do not run in CI.** `SpeechRecognition` takes only a live mic. Assertions are
  at the STT boundary; the WAVs are for manual verification. A file-capable cloud STT would close
  this.
- **Voice latency numbers are not measured.** No microphone in my environment. The typed numbers and
  the VAD threshold are reported separately and honestly; press Start talking and re-run
  `npm run latency` for the real figure.
- **LLM token counts in the cost model are estimated**, not measured, for the same reason.
- **Hold tokens are advisory, not a real inventory hold.** A second concurrent user could take stock
  between check and confirm. The re-check inside `confirm_booking` narrows the window but does not
  close it. One conversation at a time; no locking.
- **No cancellation or modification** of an already-confirmed booking.
- **One language, one set of phrasings.** The date parser covers English, and the equipment resolver
  knows three categories and their obvious synonyms.
- **Barge-in needs an echo-cancelled capture.** If the browser refuses the second microphone
  stream, the agent still cannot hear itself (the recogniser is suspended regardless), but you
  cannot cut in by voice while it speaks — press Stop or type. The app says so when it happens.
- **A word or two is clipped from the start of an interruption**, because the recogniser restarts
  only once the barge-in is detected. The energy detector knows someone started talking about
  140 ms before the first word is transcribable.
- **`created_at` uses wall-clock time** while dates are anchored to an injectable `now`, so with
  `NOW_OVERRIDE` set the two disagree. Harmless here, confusing later.
- **A dropped socket restarts the conversation.** The server builds a fresh `Session` per
  connection, so reconnecting loses the conversation context (the database is untouched). The page
  says so rather than letting the agent appear to forget. Persisting sessions across reconnects
  would need a session id in the URL and server-side retention.
- **No auth, no payments, no phone, no real rental backend** — all out of scope per the brief.

---

## License

[MIT](LICENSE).
