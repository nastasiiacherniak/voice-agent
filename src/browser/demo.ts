/**
 * The Pages demo: the server, in the page.
 *
 * GitHub Pages serves static files, so there is no Node process to hold the
 * session and no disk to hold the database. Everything else is the code that
 * runs on the server - the same `Session`, the same `DeterministicPlanner`,
 * the same SQL against the same schema, via sql.js (see shims/sqlite.ts).
 *
 * What app.js talks to is a socket-shaped object rather than a WebSocket. The
 * protocol across it is unchanged, which is why app.js needs one branch and
 * nothing else.
 *
 * Differences from `npm start`, all of them consequences of having no server:
 *   - the database lives in the tab, so a reload reseeds it;
 *   - the deterministic planner always drives (a static page cannot hold an
 *     API key - anything shipped here is public);
 *   - per-turn metrics are dropped instead of appended to metrics/turns.jsonl.
 */
import { isoOf } from '../booking/dates.js';
import { openDb, seed } from '../booking/db.js';
import { DeterministicPlanner } from '../agent/planner.js';
import { Session, DEFAULT_VAD_SILENCE_MS, type Inbound, type Outbound } from '../pipeline.js';
import { initSqlite } from './shims/sqlite.js';

/** The subset of WebSocket app.js touches. */
export interface DemoSocket {
  readyState: number;
  onopen: (() => void) | null;
  onmessage: ((ev: { data: string }) => void) | null;
  onclose: (() => void) | null;
  onerror: ((err: unknown) => void) | null;
  send(raw: string): void;
  close(): void;
}

export interface DemoBackend {
  /** Stands in for `new WebSocket('/ws')`. */
  connect(): DemoSocket;
  /** Stands in for `POST /api/reset`: reseeds the database itself. */
  resetData(): void;
}

const OPEN = 1;
const CLOSED = 3;

export async function createBackend(wasmUrl: string): Promise<DemoBackend> {
  await initSqlite(wasmUrl);

  const db = openDb(':memory:');
  seed(db);
  const now = isoOf(new Date());

  return {
    connect() {
      const socket: DemoSocket = {
        readyState: OPEN,
        onopen: null,
        onmessage: null,
        onclose: null,
        onerror: null,
        send(raw: string) {
          let msg: Inbound;
          try {
            msg = JSON.parse(raw) as Inbound;
          } catch {
            return;
          }
          // A real socket never delivers a reply inside the send() call.
          void Promise.resolve()
            .then(() => session.handle(msg))
            .catch((err) => console.error('session error', err));
        },
        close() {
          socket.readyState = CLOSED;
          socket.onclose?.();
        },
      };

      const deliver = (msg: Outbound) => {
        if (socket.readyState !== OPEN) return;
        queueMicrotask(() => socket.onmessage?.({ data: JSON.stringify(msg) }));
      };

      const session = new Session(deliver, {
        db,
        now,
        driver: new DeterministicPlanner(),
        vadSilenceMs: DEFAULT_VAD_SILENCE_MS,
      });

      /* The caller assigns its handlers after this returns, and it gets there
       * through an await - so the assignment is itself a microtask. Opening on
       * queueMicrotask would beat it and call an onopen that is still null,
       * leaving the page connected but with its controls disabled forever.
       * setTimeout is a macrotask: every pending microtask runs first. */
      setTimeout(() => {
        socket.onopen?.();
        session.start();
      }, 0);

      return socket;
    },

    resetData() {
      seed(db);
    },
  };
}

declare global {
  interface Window {
    __voiceBookingDemo?: Promise<DemoBackend>;
  }
}

// Set synchronously, so app.js can await it whatever order the modules run in.
window.__voiceBookingDemo = createBackend(new URL('./sql-wasm.wasm', import.meta.url).href);
