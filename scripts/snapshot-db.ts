/**
 * Dumps the tables as markdown, for the before/after evidence in §14.
 * Usable as a module by the test harness and as a CLI.
 */
import 'dotenv/config';
import { resolve } from 'node:path';
import { listEquipment, listReservations, openDb, type Db } from '../src/booking/db.js';
import { inventoryState } from '../src/booking/availability.js';

function table(headers: string[], rows: Array<Array<string | number>>): string {
  const head = `| ${headers.join(' | ')} |`;
  const sep = `| ${headers.map(() => '---').join(' | ')} |`;
  if (rows.length === 0) {
    return [head, sep, `| ${headers.map(() => '_(none)_').join(' | ')} |`].join('\n');
  }
  const body = rows.map((r) => `| ${r.join(' | ')} |`).join('\n');
  return [head, sep, body].join('\n');
}

export function snapshotMarkdown(db: Db, now: string, label: string): string {
  const inv = inventoryState(db, now);
  const stock = table(
    ['Item', 'Total', 'Free today', 'Tightest day in next 60'],
    listEquipment(db).map((e) => {
      const i = inv.find((x) => x.id === e.id)!;
      return [e.display_name, e.total_stock, i.remaining_today, i.min_remaining];
    }),
  );
  const res = table(
    ['id', 'item', 'start', 'end', 'qty', 'status'],
    listReservations(db).map((r) => [
      r.id,
      r.equipment_id,
      r.start_date,
      r.end_date,
      r.quantity,
      r.status,
    ]),
  );
  return `**${label}**\n\n${stock}\n\n${res}\n`;
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}`) {
  const path = process.env.DB_PATH ?? resolve(process.cwd(), 'data/booking.db');
  const now = process.env.NOW_OVERRIDE ?? new Date().toISOString().slice(0, 10);
  console.log(snapshotMarkdown(openDb(path), now, `Database at ${new Date().toISOString()}`));
}
