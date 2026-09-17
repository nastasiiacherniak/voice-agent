/**
 * Schema, connection and seed. ARCHITECTURE.md §5.
 *
 * The unique index on hold_hash is the entire duplicate-confirmation defence:
 * it is a database constraint, not a behaviour we hope the model remembers.
 */
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type Db = Database.Database;

export interface EquipmentRow {
  id: string;
  display_name: string;
  total_stock: number;
}

export interface ReservationRow {
  id: string;
  equipment_id: string;
  start_date: string;
  end_date: string;
  quantity: number;
  status: string;
  hold_hash: string;
  created_at: string;
}

const SCHEMA = `
CREATE TABLE equipment (
  id           TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  total_stock  INTEGER NOT NULL CHECK (total_stock > 0)
);

CREATE TABLE reservations (
  id            TEXT PRIMARY KEY,
  equipment_id  TEXT NOT NULL REFERENCES equipment(id),
  start_date    TEXT NOT NULL,
  end_date      TEXT NOT NULL,
  quantity      INTEGER NOT NULL CHECK (quantity > 0),
  status        TEXT NOT NULL DEFAULT 'confirmed',
  hold_hash     TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  CHECK (end_date >= start_date)
);

CREATE UNIQUE INDEX idx_reservations_hold ON reservations(hold_hash);
CREATE INDEX idx_reservations_lookup ON reservations(equipment_id, start_date, end_date);
`;

export const SEED_EQUIPMENT: EquipmentRow[] = [
  { id: 'camera_a', display_name: 'Camera A', total_stock: 2 },
  { id: 'tripod_b', display_name: 'Tripod B', total_stock: 3 },
  { id: 'mic_c', display_name: 'Microphone C', total_stock: 1 },
];

/** The pre-existing booking the brief specifies: Camera A, 10-12 Oct 2026 inclusive. */
export const SEED_RESERVATION = {
  id: 'seed-camera-a-oct',
  equipment_id: 'camera_a',
  start_date: '2026-10-10',
  end_date: '2026-10-12',
  quantity: 1,
  status: 'confirmed',
  hold_hash: 'seed:camera_a:2026-10-10:2026-10-12:1',
  created_at: '2026-09-01T00:00:00.000Z',
};

export function openDb(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

/** Idempotent: drops and recreates, so every run starts from an identical state. */
export function seed(db: Db): void {
  db.exec('DROP INDEX IF EXISTS idx_reservations_hold');
  db.exec('DROP INDEX IF EXISTS idx_reservations_lookup');
  db.exec('DROP TABLE IF EXISTS reservations');
  db.exec('DROP TABLE IF EXISTS equipment');
  db.exec(SCHEMA);

  const insEq = db.prepare(
    'INSERT INTO equipment (id, display_name, total_stock) VALUES (@id, @display_name, @total_stock)',
  );
  for (const e of SEED_EQUIPMENT) insEq.run(e);

  db.prepare(
    `INSERT INTO reservations (id, equipment_id, start_date, end_date, quantity, status, hold_hash, created_at)
     VALUES (@id, @equipment_id, @start_date, @end_date, @quantity, @status, @hold_hash, @created_at)`,
  ).run(SEED_RESERVATION);
}

export function createSeededDb(path = ':memory:'): Db {
  const db = openDb(path);
  seed(db);
  return db;
}

export function listEquipment(db: Db): EquipmentRow[] {
  return db.prepare('SELECT * FROM equipment ORDER BY id').all() as EquipmentRow[];
}

export function listReservations(db: Db): ReservationRow[] {
  return db
    .prepare('SELECT * FROM reservations ORDER BY created_at, id')
    .all() as ReservationRow[];
}
