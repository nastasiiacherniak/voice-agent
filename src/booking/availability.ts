/**
 * Overlap and stock algebra. ARCHITECTURE.md §6.1.
 *
 * Peak usage is computed per day, not as a single range-level sum. A naive
 * "sum of overlapping reservations" over-counts when two bookings each overlap
 * the request but not each other, and wrongly refuses valid bookings.
 */
import type { Db, EquipmentRow, ReservationRow } from './db.js';
import { addDays, eachDay, humanRange, inclusiveDays, MAX_RENTAL_DAYS } from './dates.js';

export interface Alternative {
  kind: 'reduced_quantity' | 'later_window';
  quantity?: number;
  start_date?: string;
  end_date?: string;
  summary: string;
}

export type AvailabilityResult =
  | {
      status: 'available';
      equipment_id: string;
      display_name: string;
      start_date: string;
      end_date: string;
      quantity: number;
      remaining_after: number;
      summary: string;
    }
  | {
      status: 'unavailable';
      equipment_id: string;
      display_name: string;
      start_date: string;
      end_date: string;
      quantity: number;
      shortfall: number;
      first_blocked_date: string;
      max_available: number;
      alternatives: Alternative[];
      summary: string;
    }
  | { status: 'invalid'; reason: string };

export function getEquipment(db: Db, equipmentId: string): EquipmentRow | undefined {
  return db.prepare('SELECT * FROM equipment WHERE id = ?').get(equipmentId) as
    | EquipmentRow
    | undefined;
}

/** Confirmed reservations for an item that touch [start, end], both bounds inclusive. */
export function overlappingReservations(
  db: Db,
  equipmentId: string,
  start: string,
  end: string,
): ReservationRow[] {
  return db
    .prepare(
      `SELECT * FROM reservations
       WHERE equipment_id = ? AND status = 'confirmed'
         AND NOT (end_date < ? OR start_date > ?)
       ORDER BY start_date`,
    )
    .all(equipmentId, start, end) as ReservationRow[];
}

export interface DayUsage {
  date: string;
  used: number;
  remaining: number;
}

/** Units committed on each day of the window. */
export function usageByDay(
  db: Db,
  equipmentId: string,
  start: string,
  end: string,
  totalStock: number,
): DayUsage[] {
  const rows = overlappingReservations(db, equipmentId, start, end);
  return eachDay(start, end).map((date) => {
    const used = rows
      .filter((r) => r.start_date <= date && date <= r.end_date)
      .reduce((sum, r) => sum + r.quantity, 0);
    return { date, used, remaining: totalStock - used };
  });
}

export interface CheckOptions {
  /** ISO yyyy-mm-dd; start dates before this are refused. */
  now: string;
  /** How far ahead to search when proposing a later window. */
  searchHorizonDays?: number;
}

export function checkAvailability(
  db: Db,
  equipmentId: string,
  start: string,
  end: string,
  quantity: number,
  opts: CheckOptions,
): AvailabilityResult {
  const item = getEquipment(db, equipmentId);
  if (!item) return { status: 'invalid', reason: `unknown equipment "${equipmentId}"` };

  // ---- calendar and quantity guards
  if (!Number.isInteger(quantity) || quantity < 1) {
    return { status: 'invalid', reason: 'quantity must be a whole number of at least 1' };
  }
  if (end < start) {
    return { status: 'invalid', reason: 'the end date is before the start date' };
  }
  if (start < opts.now) {
    return { status: 'invalid', reason: 'that start date is in the past' };
  }
  if (inclusiveDays(start, end) > MAX_RENTAL_DAYS) {
    return { status: 'invalid', reason: `rentals are limited to ${MAX_RENTAL_DAYS} days` };
  }
  if (quantity > item.total_stock) {
    return {
      status: 'invalid',
      reason: `we only carry ${item.total_stock} ${item.display_name} in total`,
    };
  }

  const usage = usageByDay(db, equipmentId, start, end, item.total_stock);
  const peak = Math.max(...usage.map((u) => u.used));
  const maxAvailable = item.total_stock - peak;

  if (maxAvailable >= quantity) {
    return {
      status: 'available',
      equipment_id: equipmentId,
      display_name: item.display_name,
      start_date: start,
      end_date: end,
      quantity,
      remaining_after: maxAvailable - quantity,
      summary: `${item.display_name}, ${quantity} ${quantity === 1 ? 'unit' : 'units'}, ${humanRange(start, end)}`,
    };
  }

  const blocked = usage.find((u) => item.total_stock - u.used < quantity)!;
  return {
    status: 'unavailable',
    equipment_id: equipmentId,
    display_name: item.display_name,
    start_date: start,
    end_date: end,
    quantity,
    shortfall: quantity - maxAvailable,
    first_blocked_date: blocked.date,
    max_available: maxAvailable,
    alternatives: buildAlternatives(db, item, start, end, quantity, opts),
    summary: `${item.display_name} is short by ${quantity - maxAvailable} on ${humanRange(blocked.date, blocked.date)}`,
  };
}

function buildAlternatives(
  db: Db,
  item: EquipmentRow,
  start: string,
  end: string,
  quantity: number,
  opts: CheckOptions,
): Alternative[] {
  const out: Alternative[] = [];
  const usage = usageByDay(db, item.id, start, end, item.total_stock);
  const maxAvailable = item.total_stock - Math.max(...usage.map((u) => u.used));

  if (maxAvailable > 0) {
    out.push({
      kind: 'reduced_quantity',
      quantity: maxAvailable,
      start_date: start,
      end_date: end,
      summary: `${maxAvailable} ${maxAvailable === 1 ? 'unit' : 'units'} on the same dates`,
    });
  }

  const length = inclusiveDays(start, end);
  const horizon = opts.searchHorizonDays ?? 60;
  for (let offset = 1; offset <= horizon; offset++) {
    const s = addDays(start, offset);
    const e = addDays(s, length - 1);
    const u = usageByDay(db, item.id, s, e, item.total_stock);
    if (item.total_stock - Math.max(...u.map((x) => x.used)) >= quantity) {
      out.push({
        kind: 'later_window',
        quantity,
        start_date: s,
        end_date: e,
        summary: `the same ${length === 1 ? 'day' : `${length} days`} starting ${humanRange(s, e)}`,
      });
      break;
    }
  }

  return out;
}

// ------------------------------------------------------------- UI projection

export interface InventoryItem {
  id: string;
  display_name: string;
  total_stock: number;
  /** Lowest number of free units on any day of the reporting window. */
  min_remaining: number;
  /** Free units today. */
  remaining_today: number;
  window_start: string;
  window_end: string;
  reservations: ReservationRow[];
}

/** What the on-screen state panel renders. Reads the database, never the model. */
export function inventoryState(db: Db, now: string, windowDays = 60): InventoryItem[] {
  const items = db.prepare('SELECT * FROM equipment ORDER BY id').all() as EquipmentRow[];
  const windowEnd = addDays(now, windowDays);
  return items.map((item) => {
    const usage = usageByDay(db, item.id, now, windowEnd, item.total_stock);
    return {
      id: item.id,
      display_name: item.display_name,
      total_stock: item.total_stock,
      min_remaining: Math.min(...usage.map((u) => u.remaining)),
      remaining_today: usage[0]!.remaining,
      window_start: now,
      window_end: windowEnd,
      reservations: db
        .prepare(
          `SELECT * FROM reservations WHERE equipment_id = ? AND status = 'confirmed'
             AND end_date >= ? ORDER BY start_date`,
        )
        .all(item.id, now) as ReservationRow[],
    };
  });
}
