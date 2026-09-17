/**
 * There is no filesystem in the page. db.ts creates the directory its database
 * file lives in, and MetricsWriter appends a JSONL line per turn; in the demo
 * the database is in memory and the metrics go nowhere.
 *
 * `npm run build:pages` aliases 'node:fs' to this file.
 */
export function mkdirSync(_path: string, _opts?: unknown): void {}
export function appendFileSync(_path: string, _data: string, _enc?: unknown): void {}
export function existsSync(_path: string): boolean {
  return false;
}
