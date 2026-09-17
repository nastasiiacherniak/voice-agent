import 'dotenv/config';
import { resolve } from 'node:path';
import { openDb, seed, listEquipment, listReservations } from '../src/booking/db.js';

const path = process.env.DB_PATH ?? resolve(process.cwd(), 'data/booking.db');
const db = openDb(path);
seed(db);

console.log(`seeded ${path}`);
console.table(listEquipment(db));
console.table(listReservations(db));
