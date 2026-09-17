/**
 * better-sqlite3's surface, over sql.js (SQLite compiled to WebAssembly).
 *
 * The Pages demo runs the real server code in the page, and the one thing that
 * cannot come along is the native module. This is the whole substitution: the
 * SQL, the schema, the CHECK constraints and the unique index on hold_hash are
 * the same engine, just built for the browser. Nothing in src/booking changes.
 *
 * Only the surface src/ actually uses is implemented - prepare/run/get/all,
 * exec, pragma, transaction - and it is deliberately not a general-purpose
 * shim. `npm run build:pages` aliases 'better-sqlite3' to this file.
 */
import initSqlJs, { type Database as SqlJsDatabase, type SqlJsStatic } from 'sql.js';

type Row = Record<string, unknown>;
type Args = unknown[];

let SQL: SqlJsStatic | null = null;

/** Must be awaited before the first `new Database()`; loads the .wasm. */
export async function initSqlite(wasmUrl: string): Promise<void> {
  SQL = await initSqlJs({ locateFile: () => wasmUrl });
}

function isNamed(args: Args): args is [Row] {
  return (
    args.length === 1 &&
    typeof args[0] === 'object' &&
    args[0] !== null &&
    !Array.isArray(args[0]) &&
    !ArrayBuffer.isView(args[0])
  );
}

/** better-sqlite3 takes `{ id }` for `@id`; sql.js wants the sigil in the key. */
function bindValues(args: Args): unknown {
  if (args.length === 0) return undefined;
  if (isNamed(args)) {
    const out: Row = {};
    for (const [k, v] of Object.entries(args[0])) out[`@${k}`] = v;
    return out;
  }
  return args;
}

class Statement {
  constructor(
    private readonly db: SqlJsDatabase,
    private readonly sql: string,
  ) {}

  /** sql.js statements are stateful, so each call gets a fresh one. */
  private open(args: Args) {
    const stmt = this.db.prepare(this.sql);
    const bound = bindValues(args);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (bound !== undefined) stmt.bind(bound as any);
    return stmt;
  }

  run(...args: Args): { changes: number } {
    const stmt = this.open(args);
    try {
      stmt.step();
    } finally {
      stmt.free();
    }
    return { changes: this.db.getRowsModified() };
  }

  get(...args: Args): Row | undefined {
    const stmt = this.open(args);
    try {
      return stmt.step() ? (stmt.getAsObject() as Row) : undefined;
    } finally {
      stmt.free();
    }
  }

  all(...args: Args): Row[] {
    const stmt = this.open(args);
    const rows: Row[] = [];
    try {
      while (stmt.step()) rows.push(stmt.getAsObject() as Row);
    } finally {
      stmt.free();
    }
    return rows;
  }
}

class Database {
  private readonly db: SqlJsDatabase;

  /** The path is ignored - the page has no filesystem. */
  constructor(_path?: string) {
    if (!SQL) throw new Error('initSqlite() must be awaited before opening a database');
    this.db = new SQL.Database();
  }

  prepare(sql: string): Statement {
    return new Statement(this.db, sql);
  }

  exec(sql: string): this {
    this.db.run(sql);
    return this;
  }

  /** WAL is meaningless in memory; foreign_keys is not, so both are passed on. */
  pragma(source: string): void {
    this.db.run(`PRAGMA ${source}`);
  }

  /**
   * The booking write runs inside this, and its idempotency depends on the
   * whole read-recheck-insert being atomic.
   */
  transaction<T extends (...args: never[]) => unknown>(fn: T): T {
    const wrapped = (...args: Parameters<T>): ReturnType<T> => {
      this.db.run('BEGIN');
      try {
        const out = fn(...(args as never[])) as ReturnType<T>;
        this.db.run('COMMIT');
        return out;
      } catch (err) {
        this.db.run('ROLLBACK');
        throw err;
      }
    };
    return wrapped as unknown as T;
  }

  close(): void {
    this.db.close();
  }
}

export default Database;
