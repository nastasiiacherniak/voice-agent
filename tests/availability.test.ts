import { beforeEach, describe, expect, it } from 'vitest';
import { createSeededDb, type Db } from '../src/booking/db.js';
import { checkAvailability, inventoryState, usageByDay } from '../src/booking/availability.js';
import { NOW } from './helpers.js';

let db: Db;
beforeEach(() => {
  db = createSeededDb(':memory:');
});

const opts = { now: NOW };

function addReservation(
  id: string,
  equipment: string,
  start: string,
  end: string,
  qty: number,
): void {
  db.prepare(
    `INSERT INTO reservations (id, equipment_id, start_date, end_date, quantity, status, hold_hash, created_at)
     VALUES (?, ?, ?, ?, ?, 'confirmed', ?, '2026-09-01T00:00:00.000Z')`,
  ).run(id, equipment, start, end, qty, `hash_${id}`);
}

describe('overlap, both bounds inclusive', () => {
  it('counts the seeded booking on its own last day', () => {
    const usage = usageByDay(db, 'camera_a', '2026-10-12', '2026-10-12', 2);
    expect(usage).toEqual([{ date: '2026-10-12', used: 1, remaining: 1 }]);
  });

  it('treats an adjacent range as not overlapping', () => {
    const usage = usageByDay(db, 'camera_a', '2026-10-13', '2026-10-15', 2);
    expect(usage.every((u) => u.used === 0)).toBe(true);
  });

  it('counts a single-day request that lands inside the seeded booking', () => {
    const r = checkAvailability(db, 'camera_a', '2026-10-11', '2026-10-11', 2, opts);
    expect(r.status).toBe('unavailable');
  });
});

describe('peak usage is per-day, not a range-level sum', () => {
  it('allows a request that spans two bookings which do not overlap each other', () => {
    // Tripod B has 3 units. Two bookings of 2, back to back but disjoint.
    addReservation('r1', 'tripod_b', '2026-11-01', '2026-11-02', 2);
    addReservation('r2', 'tripod_b', '2026-11-03', '2026-11-04', 2);

    // Naive "sum of overlapping reservations" would compute 4 of 3 and refuse.
    const r = checkAvailability(db, 'tripod_b', '2026-11-01', '2026-11-04', 1, opts);
    expect(r.status).toBe('available');
  });

  it('refuses when two bookings genuinely stack on the same day', () => {
    addReservation('r1', 'tripod_b', '2026-11-01', '2026-11-03', 2);
    addReservation('r2', 'tripod_b', '2026-11-03', '2026-11-05', 1);
    const r = checkAvailability(db, 'tripod_b', '2026-11-03', '2026-11-03', 1, opts);
    expect(r.status).toBe('unavailable');
    if (r.status === 'unavailable') expect(r.first_blocked_date).toBe('2026-11-03');
  });
});

describe('the seeded collision', () => {
  it('refuses Camera A x2 for 11-13 October and names the first blocked day', () => {
    const r = checkAvailability(db, 'camera_a', '2026-10-11', '2026-10-13', 2, opts);
    expect(r.status).toBe('unavailable');
    if (r.status === 'unavailable') {
      expect(r.shortfall).toBe(1);
      expect(r.first_blocked_date).toBe('2026-10-11');
      expect(r.max_available).toBe(1);
    }
  });

  it('allows Camera A x1 across the same dates', () => {
    const r = checkAvailability(db, 'camera_a', '2026-10-11', '2026-10-13', 1, opts);
    expect(r.status).toBe('available');
    if (r.status === 'available') expect(r.remaining_after).toBe(0);
  });

  it('offers a reduced quantity and a later window', () => {
    const r = checkAvailability(db, 'camera_a', '2026-10-11', '2026-10-13', 2, opts);
    if (r.status !== 'unavailable') throw new Error('expected unavailable');
    expect(r.alternatives.map((a) => a.kind)).toContain('reduced_quantity');
    const later = r.alternatives.find((a) => a.kind === 'later_window');
    expect(later?.start_date).toBe('2026-10-13');
  });
});

describe('calendar and quantity guards', () => {
  it('refuses a start date in the past', () => {
    const r = checkAvailability(db, 'camera_a', '2026-09-01', '2026-09-02', 1, opts);
    expect(r).toMatchObject({ status: 'invalid' });
  });

  it('refuses more units than exist at all', () => {
    const r = checkAvailability(db, 'mic_c', '2026-10-20', '2026-10-21', 2, opts);
    expect(r).toMatchObject({ status: 'invalid' });
    if (r.status === 'invalid') expect(r.reason).toMatch(/only carry 1/);
  });

  it('refuses a rental longer than 90 days', () => {
    const r = checkAvailability(db, 'tripod_b', '2026-10-01', '2027-01-30', 1, opts);
    expect(r).toMatchObject({ status: 'invalid' });
  });

  it('refuses a non-positive quantity', () => {
    expect(checkAvailability(db, 'tripod_b', '2026-10-01', '2026-10-02', 0, opts).status).toBe(
      'invalid',
    );
  });

  it('refuses unknown equipment', () => {
    expect(checkAvailability(db, 'drone_x', '2026-10-01', '2026-10-02', 1, opts).status).toBe(
      'invalid',
    );
  });
});

describe('inventory projection for the screen', () => {
  it('reports total stock and the tightest day in the window', () => {
    const items = inventoryState(db, NOW);
    const camera = items.find((i) => i.id === 'camera_a')!;
    expect(camera.total_stock).toBe(2);
    expect(camera.min_remaining).toBe(1); // the seeded 10-12 October booking
    expect(camera.remaining_today).toBe(2);
    expect(camera.reservations).toHaveLength(1);

    const mic = items.find((i) => i.id === 'mic_c')!;
    expect(mic.min_remaining).toBe(1);
    expect(mic.reservations).toHaveLength(0);
  });
});
