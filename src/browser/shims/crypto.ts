/**
 * The slice of node:crypto that src/ uses, for the browser.
 *
 * Web Crypto's digest is async and the hold-token code is synchronous all the
 * way down, so the hashing comes from @noble/hashes rather than the platform.
 * Randomness still comes from the platform CSPRNG.
 *
 * `npm run build:pages` aliases 'node:crypto' to this file.
 */
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { Buffer } from 'buffer';

type Input = string | Uint8Array | Buffer;

function bytes(data: Input): Uint8Array {
  return typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data);
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/** Matches node's `.update().digest()` chain, including `digest('hex')`. */
class Digester {
  private readonly chunks: Uint8Array[] = [];

  constructor(private readonly compute: (msg: Uint8Array) => Uint8Array) {}

  update(data: Input): this {
    this.chunks.push(bytes(data));
    return this;
  }

  digest(): Buffer;
  digest(encoding: 'hex'): string;
  digest(encoding?: 'hex'): Buffer | string {
    const out = this.compute(concat(this.chunks));
    return encoding === 'hex' ? Buffer.from(out).toString('hex') : Buffer.from(out);
  }
}

export function createHash(algorithm: string): Digester {
  if (algorithm !== 'sha256') throw new Error(`unsupported hash ${algorithm}`);
  return new Digester((msg) => sha256(msg));
}

export function createHmac(algorithm: string, key: Input): Digester {
  if (algorithm !== 'sha256') throw new Error(`unsupported hmac ${algorithm}`);
  const k = bytes(key);
  return new Digester((msg) => hmac(sha256, k, msg));
}

export function randomBytes(size: number): Buffer {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(size)));
}

export function randomUUID(): string {
  return crypto.randomUUID();
}

/** Constant time in the same sense node means it: no early exit on mismatch. */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) throw new RangeError('input length mismatch');
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] as number) ^ (b[i] as number);
  return diff === 0;
}
