/**
 * Hold tokens - the gate between reading and writing. ARCHITECTURE.md §8.
 *
 * Only check_availability mints a token, and only when the status is
 * "available". There is no other path to a write, which is what makes
 * "an unavailable request never becomes a booking" structural rather than
 * a behaviour we ask the model to respect.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export interface HoldPayload {
  equipment_id: string;
  start_date: string;
  end_date: string;
  quantity: number;
  conversation_id: string;
  issued_at: number;
  nonce: string;
}

/** Identity of a booking, for the unique index. Excludes issued_at and nonce. */
export interface HoldIdentity {
  equipment_id: string;
  start_date: string;
  end_date: string;
  quantity: number;
  conversation_id: string;
}

export const HOLD_TTL_MS = 10 * 60 * 1000;

export type VerifyResult =
  | { ok: true; payload: HoldPayload; hold_hash: string }
  | { ok: false; reason: 'malformed' | 'bad_signature' | 'expired' };

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function unb64url(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

/** Canonical serialisation: fixed key order, so the hash is stable. */
function canonical(id: HoldIdentity): string {
  return JSON.stringify([
    id.equipment_id,
    id.start_date,
    id.end_date,
    id.quantity,
    id.conversation_id,
  ]);
}

export function holdHash(id: HoldIdentity): string {
  return createHash('sha256').update(canonical(id)).digest('hex');
}

export interface MinterOptions {
  secret?: string;
  /** Injectable for deterministic tests. */
  nonceFactory?: () => string;
  /** Injectable clock, milliseconds since epoch. */
  clock?: () => number;
}

export class HoldTokenMinter {
  private readonly secret: Buffer;
  private readonly nonceFactory: () => string;
  private readonly clock: () => number;

  constructor(opts: MinterOptions = {}) {
    this.secret = Buffer.from(opts.secret ?? randomBytes(32).toString('hex'), 'utf8');
    this.nonceFactory = opts.nonceFactory ?? (() => randomBytes(8).toString('hex'));
    this.clock = opts.clock ?? (() => Date.now());
  }

  mint(id: HoldIdentity): { token: string; hold_hash: string; payload: HoldPayload } {
    const payload: HoldPayload = {
      ...id,
      issued_at: this.clock(),
      nonce: this.nonceFactory(),
    };
    const body = b64url(Buffer.from(JSON.stringify(payload), 'utf8'));
    const sig = b64url(createHmac('sha256', this.secret).update(body).digest());
    return { token: `${body}.${sig}`, hold_hash: holdHash(id), payload };
  }

  verify(token: string): VerifyResult {
    if (typeof token !== 'string' || !token.includes('.')) return { ok: false, reason: 'malformed' };
    const [body, sig] = token.split('.');
    if (!body || !sig) return { ok: false, reason: 'malformed' };

    const expected = createHmac('sha256', this.secret).update(body).digest();
    const got = unb64url(sig);
    if (got.length !== expected.length || !timingSafeEqual(got, expected)) {
      return { ok: false, reason: 'bad_signature' };
    }

    let payload: HoldPayload;
    try {
      payload = JSON.parse(unb64url(body).toString('utf8')) as HoldPayload;
    } catch {
      return { ok: false, reason: 'malformed' };
    }
    if (
      typeof payload?.equipment_id !== 'string' ||
      typeof payload?.start_date !== 'string' ||
      typeof payload?.end_date !== 'string' ||
      typeof payload?.quantity !== 'number' ||
      typeof payload?.conversation_id !== 'string'
    ) {
      return { ok: false, reason: 'malformed' };
    }
    if (this.clock() - payload.issued_at > HOLD_TTL_MS) return { ok: false, reason: 'expired' };

    return { ok: true, payload, hold_hash: holdHash(payload) };
  }
}
