# Voice equipment booking agent — architecture

Handoff spec. Build in the order given in §15. Everything before that is reference.

---

## 1. What this is

A browser voice agent for a small equipment rental desk. One person at a time speaks to it, asks for equipment and dates, changes their mind, and confirms. The agent checks real inventory in a local database and writes exactly one reservation, only after explicit spoken confirmation.

### Acceptance criteria

These are the things that must be demonstrably true. Each maps to a test in §14.

1. A normal booking produces exactly one reservation row with correct item, dates and quantity.
2. A mid-conversation date correction results in a reservation on the **new** dates and no row for the old ones.
3. A request exceeding available stock never produces a reservation row, under any phrasing.
4. Interrupting the agent mid-sentence stops its audio within ~200 ms and the agent does not finish its old sentence afterwards.
5. Saying "yes, confirm" twice produces one row, not two.
6. An ambiguous item or date produces a spoken clarifying question, not a guess.

### Non-goals

No auth, no payments, no phone, no multi-language, no multi-user concurrency, no real rental backend, no hour-level granularity. Day-based rentals, inclusive of both end dates.

---

## 2. The central design decision

**Cascaded pipeline** (streaming STT → LLM with tools → streaming TTS), not a realtime speech-to-speech model.

A speech-to-speech model would be faster — roughly 300–800 ms to first audio versus 700–1200 ms for a cascade. It was rejected because:

- Turn boundaries are internal to the model, so the required end-of-turn → first-audio measurement can only be approximated.
- Audio tokens accumulate in context, so cost per minute rises nonlinearly across a conversation.
- Deterministic replay of recorded WAV fixtures through the same code path is awkward, and the brief requires a reproducible recorded test set.

The cascade trades ~400 ms of latency for per-stage timestamps, swappable components, and a headless test harness that exercises the production code path. That tradeoff is the answer to the brief's "explain the quality/speed/cost tradeoff you chose" — write it up with the measured numbers from §12 and §13.

---

## 3. Stack

| Layer | Choice | Why |
|---|---|---|
| Orchestration | **Pipecat** (Python) | Frame-based pipeline, interruption is a first-class frame type, `SmallWebRTCTransport` needs no cloud SFU, transport is swappable for file input in tests |
| Transport | `SmallWebRTCTransport` | Browser ↔ local Python over WebRTC, no external infra |
| STT | **Deepgram Nova-3** streaming (or AssemblyAI Universal-Streaming) | Interim + final results, word timings, configurable endpointing |
| LLM | A small fast model with reliable tool calling (Claude Haiku class or GPT-4o-mini class) | Reasoning here is trivial; time-to-first-token is what matters |
| TTS | **Cartesia Sonic** (or ElevenLabs Flash v2.5) | Sub-100 ms time-to-first-byte, streams, cancellable mid-utterance |
| Database | **SQLite** via `aiosqlite` | Single file, trivially snapshottable for before/after diffs |
| Date parsing | `dateparser` + a small deterministic wrapper | Must not be the LLM's job — see §6.2 |
| Frontend | Plain HTML + vanilla JS, no framework | One page: mic button, transcript, inventory table, booking card |
| Tests | `pytest` + YAML fixtures | Same pipeline, file transport instead of WebRTC |

**Reused vs. own work** (the brief asks you to identify this): Pipecat, the STT/TTS/LLM SDKs, `dateparser` and SQLite are reused as-is. Your own work is the booking domain layer (§6), the hold-token gate (§7–8), the conversation state machine (§9), the interruption/staleness handling (§10.2), the latency instrumentation (§12) and the test harness (§14). Say so explicitly in the submission.

---

## 4. Repo layout

```
voice-booking/
  README.md
  ARCHITECTURE.md          this file
  .env.example
  pyproject.toml
  src/
    app.py                 entrypoint, wires transport + pipeline
    pipeline.py            Pipecat pipeline construction
    state.py               conversation state machine (§9)
    booking/
      db.py                schema, connection, seed
      availability.py      overlap + stock algebra (§6.1)
      dates.py             deterministic date parsing (§6.2)
      tokens.py            hold token mint/verify (§8)
      tools.py             the three LLM-facing tools (§7)
    voice/
      prompt.py            system prompt
      interrupt.py         barge-in + stale-result handling (§10.2)
      metrics.py           turn timing (§12)
    web/
      index.html
      app.js
      styles.css
  tests/
    fixtures/
      audio/               *.wav — your own recorded voice
      expected/            *.yaml — written BEFORE running anything
    test_availability.py   pure unit tests, no audio
    test_tools.py          gate behaviour, no audio
    test_conversations.py  end-to-end over WAV fixtures
    conftest.py
  scripts/
    seed_db.py
    snapshot_db.py         dumps tables as markdown for before/after
    report_latency.py      reads metrics JSONL, prints percentiles
    cost_model.py          §13 calculator
```

---

## 5. Data model

```sql
CREATE TABLE equipment (
  id           TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  total_stock  INTEGER NOT NULL CHECK (total_stock > 0)
);

CREATE TABLE reservations (
  id            TEXT PRIMARY KEY,
  equipment_id  TEXT NOT NULL REFERENCES equipment(id),
  start_date    TEXT NOT NULL,        -- ISO yyyy-mm-dd, inclusive
  end_date      TEXT NOT NULL,        -- ISO yyyy-mm-dd, inclusive
  quantity      INTEGER NOT NULL CHECK (quantity > 0),
  status        TEXT NOT NULL DEFAULT 'confirmed',
  hold_hash     TEXT NOT NULL,        -- see §8
  created_at    TEXT NOT NULL,
  CHECK (end_date >= start_date)
);

CREATE UNIQUE INDEX idx_reservations_hold ON reservations(hold_hash);
CREATE INDEX idx_reservations_lookup ON reservations(equipment_id, start_date, end_date);
```

`idx_reservations_hold` is the entire duplicate-confirmation defence. Do not rely on the model remembering it already booked.

### Seed

```
equipment:  camera_a   "Camera A"      total_stock 2
            tripod_b   "Tripod B"      total_stock 3
            mic_c      "Microphone C"  total_stock 1

reservations: camera_a, 2026-10-10 .. 2026-10-12, qty 1, status confirmed
```

`scripts/seed_db.py` must be idempotent — drop and recreate, so every test run starts identical.

---

## 6. Domain layer

### 6.1 Availability

Two date ranges overlap when `NOT (end_a < start_b OR start_a > end_b)`. Both bounds inclusive.

```
available(equipment_id, start, end, qty) ->
    stock = equipment.total_stock
    for each day d in [start..end]:
        used[d] = sum(r.quantity for r in confirmed reservations
                      on equipment_id where r.start <= d <= r.end)
    peak = max(used[d])
    return stock - peak >= qty
```

Compute per-day peak usage, not a single range-level sum. A naive "sum of overlapping reservations" over-counts when two bookings overlap the request but not each other, and will wrongly refuse valid bookings. Also return `shortfall` and the first blocked date so the agent can say something useful ("Camera A is fully booked on the 11th").

Guard the calendar too: reject start dates in the past, ranges longer than 90 days, and quantity above `total_stock` outright.

### 6.2 Dates — keep this away from the LLM

Parse deterministically in `dates.py`. The function returns one of three outcomes:

- `resolved(start, end)` — unambiguous
- `ambiguous(reason, candidates)` — e.g. "the 10th" with no month, a date that already passed this year, "next week" with no explicit end
- `invalid(reason)` — end before start, unparseable

The agent must ask about `ambiguous` by voice. Never let the model fill in a missing month or year. This is the single most likely place a demo silently books the wrong thing, and acceptance criterion 6 is specifically testing it.

Anchor all relative parsing ("tomorrow", "next Friday") to an injectable `now`, so fixtures stay reproducible forever. Default it to a fixed date in tests.

---

## 7. Tool contracts

Three tools. The LLM never touches SQL.

### `check_availability`

```json
{
  "equipment": "camera_a | tripod_b | mic_c",
  "start_date_phrase": "raw phrase as the user said it",
  "end_date_phrase":   "raw phrase as the user said it",
  "quantity": 1
}
```

Returns one of:

```json
{"status": "available", "hold_token": "...", "summary": "Camera A, 2 units, 14–16 October 2026"}
{"status": "unavailable", "shortfall": 1, "first_blocked_date": "2026-10-11", "alternatives": [...]}
{"status": "needs_clarification", "field": "start_date", "reason": "no month given"}
```

Read-only. Passing the raw spoken phrases (not pre-parsed dates) keeps normalisation in your deterministic code rather than the model's head.

### `propose_booking`

```json
{"hold_token": "..."}
```

Returns a human-readable read-back string for the agent to speak. **No write.** This exists so the read-back is generated from the token's contents rather than from the model's recollection of the conversation — if the model drifted, the read-back exposes it.

### `confirm_booking`

```json
{"hold_token": "..."}
```

1. Verify token signature and expiry.
2. **Re-run availability** — time passed between read-back and "yes".
3. `INSERT ... ON CONFLICT(hold_hash) DO NOTHING`.
4. `SELECT` the row by `hold_hash` and return it.

Returns `{"status": "confirmed", "reservation": {...}, "created": true|false}`. When `created` is false the caller said yes twice; the agent should acknowledge the existing booking, not announce a new one.

---

## 8. Hold tokens

The gate between reading and writing.

Payload: `{equipment_id, start_date, end_date, quantity, conversation_id, issued_at, nonce}`, serialised canonically and HMAC-signed with a process-local secret.

- `hold_hash` = SHA-256 of the payload **excluding** `issued_at` and `nonce`. Two confirmations of the same booking in the same conversation collide on the unique index; a genuinely different booking does not.
- TTL 10 minutes. Expired tokens fail verification and the agent must re-check.
- Only `check_availability` mints tokens, and only when status is `available`. There is no other path to a write. This is what makes acceptance criterion 3 structural.
- Any change to item, dates or quantity mints a **new** token. `state.py` holds at most one active token and drops the previous one on every slot change — that is acceptance criterion 2.

---

## 9. Conversation state machine

States: `idle → gathering → held → confirmed`, plus `clarifying`.

| From | Event | To | Side effect |
|---|---|---|---|
| idle | user speaks | gathering | new `conversation_id` |
| gathering | all slots filled, available | held | token minted |
| gathering | ambiguous slot | clarifying | none |
| clarifying | slot resolved | gathering | none |
| gathering | unavailable | gathering | **no token**, agent offers alternatives |
| held | explicit confirmation | confirmed | `confirm_booking` |
| held | any slot changed | gathering | **token discarded** |
| held | barge-in | gathering | **token discarded**, TTS cancelled |
| confirmed | repeat confirmation | confirmed | idempotent no-op |
| confirmed | new request | gathering | new `conversation_id` |

Two rules to enforce in code, not prose:

- **Only `held` can transition to `confirmed`.** A "yes" in any other state is not a confirmation.
- **Confirmation must be explicit.** "Yes", "confirm", "book it", "that's right, go ahead". Not "yeah" mid-sentence, not silence, not "sounds good" while the agent is still reading back. Keep the matcher in `state.py` and unit-test it against a list of positives and near-misses; do not delegate the judgement to the model alone.

---

## 10. Pipeline and interruption

### 10.1 Pipeline

```
transport.input()
  → STT (interim + final frames)
  → turn aggregator (user turn boundary)
  → context aggregator (conversation history)
  → LLM service (tools registered)
  → TTS (streaming)
  → transport.output()
```

### 10.2 Barge-in

When VAD fires while the agent is speaking:

1. Push an interruption frame — Pipecat cancels downstream TTS and clears the output audio buffer.
2. Abort the in-flight LLM completion (cancel the task, don't just ignore it — you're paying for those tokens).
3. Stamp the current turn as cancelled with a monotonically increasing `turn_id`.
4. **Discard any tool result whose `turn_id` is stale.** A `check_availability` fired before the interruption may land after it, carrying a token for what the user just retracted. This is the subtle failure mode and it needs an explicit guard, not a hope.
5. Truncate the assistant message in context to what was actually spoken, so the model doesn't believe it said something the user never heard.

Set VAD silence threshold to 500–700 ms. Tune it once, write the value down, and report latency both including and excluding it (§12).

---

## 11. Frontend

One page, three regions:

- **Mic control** — push-to-talk or toggle, with a clear speaking/listening indicator.
- **Live transcript** — user and agent turns, with the current partial transcript shown greyed.
- **State panel** — the inventory table with remaining stock per item, and a booking card that appears on confirmation showing item, dates, quantity, reservation id.

The panel must read from the database via a `/api/state` poll or a data channel push, not from anything the model said. That is the on-screen proof that the write actually happened.

---

## 12. Latency instrumentation

Emit one JSONL record per turn to `metrics/turns.jsonl` with these timestamps:

| Field | Meaning |
|---|---|
| `t_speech_end` | VAD detected end of user speech |
| `t_stt_final` | final transcript received |
| `t_llm_first_token` | first token of the response |
| `t_tool_calls` | list of `{name, duration_ms}` |
| `t_tts_first_byte` | first audio byte from TTS |
| `t_audio_first_frame` | first frame scheduled in the browser `AudioContext` |

Headline metric: `t_audio_first_frame − t_speech_end`. Report p50 and p95 across all fixture turns, plus the stage breakdown so the bottleneck is visible. Report the VAD threshold separately — it's the dominant additive term and it's a tuning choice, not a system limit.

The browser-side timestamp needs a clock offset measurement (a few ping round-trips at session start) to be comparable with server timestamps. Do that once and record the offset in the session metadata.

`scripts/report_latency.py` prints the table you paste into the submission.

---

## 13. Cost model

Model user-speaking minutes and agent-speaking minutes separately — they consume different services.

```
cost_per_minute =
    stt_rate × user_audio_minutes
  + llm_input_rate  × input_tokens        (grows with turn count)
  + llm_output_rate × output_tokens
  + tts_rate × agent_characters_or_seconds
```

`scripts/cost_model.py` should take the real token and character counts logged during the fixture runs and a rate table in `rates.yaml`, and print cost per conversation minute with the per-component split. Include the speech-to-speech alternative as a second column for the tradeoff discussion.

**Do not hardcode prices from memory, mine included.** Pull current rate cards at build time and put them in `rates.yaml` with the date you fetched them. For Anthropic model pricing see https://docs.claude.com/en/docs/about-claude/pricing — verify rather than assume.

Expect a cascade to land materially below a realtime speech-to-speech setup per conversation minute; report your own measured figure rather than a range.

---

## 14. Test harness

### Method

1. Record WAV fixtures in your own voice (shareable material).
2. Write `expected/*.yaml` **before running anything**. Commit them in a separate commit so the timestamps prove it.
3. Run fixtures through the production pipeline with the transport swapped for file input.
4. Assert on three things: final transcript intent, the **ordered tool-call log**, and the **database diff**.

The tool-call log is what proves the app processes new input rather than replaying canned answers — assert it, and show it in the submission.

### The five cases

| # | Fixture | Expected tool calls | Expected DB delta |
|---|---|---|---|
| 1 | Normal booking — Tripod B, 14–16 Oct 2026, qty 1 | `check_availability` → `propose_booking` → `confirm_booking` | +1 row, tripod_b 14–16 Oct |
| 2 | Corrected dates — asks 14–16, switches to 20–22 before confirming | `check_availability`(14–16) → `check_availability`(20–22) → `propose_booking` → `confirm_booking` | +1 row, **20–22 only**; token from the first check unused |
| 3 | Insufficient stock — Camera A × 2 for 11–13 Oct (collides with seed) | `check_availability` returns `unavailable`; **no** `confirm_booking` | **0 rows added** |
| 4 | Interruption — user cuts in during read-back and changes item | TTS cancelled; stale tool result discarded; new `check_availability` | +1 row matching the corrected request, or 0 if the fixture ends before confirmation |
| 5 | Repeated confirmation — says "yes, confirm" twice | `confirm_booking` twice, second returns `created: false` | **+1 row total** |

Add a sixth if time allows: ambiguous date ("book the camera for the tenth") → `needs_clarification`, spoken question, no token minted.

For each case, `scripts/snapshot_db.py` dumps the tables before and after into the test report. That's the before/after evidence the brief asks for.

### Determinism

Set LLM temperature to 0, pin the model version, inject a fixed `now` for date parsing, and fix the random seed for token nonces in test mode. Expect STT transcription to vary slightly run to run — assert on extracted intent and tool arguments, not on exact transcript strings.

---

## 15. Build order

Roughly eight hours. Sequenced so that running out of time degrades gracefully.

1. **(1.5 h) Domain core, no audio.** Schema, seed, availability algebra, date parser. Unit tests for overlap edge cases (adjacent ranges, single-day, the exact seed collision) and for ambiguous date handling. This must be green before anything else starts.
2. **(1 h) Tools and the gate.** Three tools, hold tokens, the unique index. Test double-confirm and unavailable-never-writes at this layer, in plain Python. Acceptance criteria 1, 2, 3 and 5 are provable here with no microphone involved.
3. **(1.5 h) Pipecat pipeline.** STT → LLM → TTS over WebRTC, tools registered, system prompt. Get one booking working end to end by voice.
4. **(1 h) State machine and interruption.** Barge-in cancellation, stale-result guard, token invalidation on slot change.
5. **(1 h) Frontend.** Transcript, inventory table, booking card, all reading from the database.
6. **(1.5 h) Test harness.** Record fixtures, write expected YAML first, wire the file transport, snapshot script.
7. **(0.5 h) Metrics and cost.** Latency report, cost model.

If you run out of time, a fully tested booking core with a rough voice front-end demos far better than a smooth voice loop that double-books. Cut in reverse order: frontend polish, then alternatives suggestions, then the sixth test case.

---

## 16. Things to state as unfinished

Be explicit in the README about whatever you didn't get to. Likely candidates:

- Single conversation at a time; no locking for concurrent sessions.
- Hold tokens are advisory, not a real inventory hold — a second concurrent user could take the stock between check and confirm. The re-check in `confirm_booking` narrows but does not close this.
- No cancellation or modification of an existing confirmed booking.
- Date parsing covers one language and a fixed set of phrasings.
- STT variance means transcript-level assertions are intent-based, not exact-match.
