/**
 * Hashe i kanoniczny JSON (RFC 8785 / JCS).
 */
import { sha256 as nobleSha256 } from '@noble/hashes/sha2.js';
import { resolveConfig, type CallConfig } from './config-store.ts';
import { utf8 } from './text.ts';

export function toHex(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

export function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** sha256 przez plugin `crypto` (jeśli jest), inaczej wbudowane (@noble/hashes). Synchroniczne. */
export function sha256Bytes(data: Uint8Array, call?: CallConfig): Uint8Array {
  const crypto = resolveConfig(call).cap('crypto');
  if (crypto) {
    try {
      return crypto.sha256(data);
    } catch {
      // awaria pluginu → implementacja wbudowana (wynik identyczny)
    }
  }
  return nobleSha256(data);
}

/** `sha256:<64 hex>` z bajtów albo tekstu UTF-8. */
export function sha256Tag(data: Uint8Array | string, call?: CallConfig): string {
  const bytes = typeof data === 'string' ? utf8(data) : data;
  return `sha256:${toHex(sha256Bytes(bytes, call))}`;
}

/** Inkrementalny sha256 dla dużych Blobów. */
export async function sha256Blob(blob: Blob, call?: CallConfig): Promise<string> {
  const crypto = resolveConfig(call).cap('crypto');
  if (crypto) {
    return sha256Tag(new Uint8Array(await blob.arrayBuffer()), call);
  }
  const h = nobleSha256.create();
  const CHUNK = 4 * 1024 * 1024;
  for (let off = 0; off < blob.size; off += CHUNK) {
    h.update(new Uint8Array(await blob.slice(off, off + CHUNK).arrayBuffer()));
  }
  return `sha256:${toHex(h.digest())}`;
}

function jcsNumber(n: number): string {
  if (!Number.isFinite(n)) throw new Error('JCS: liczba nieskończona');
  if (Object.is(n, -0)) return '0';
  return String(n);
}

function jcsString(s: string): string {
  return JSON.stringify(s);
}

/** Serializacja kanoniczna RFC 8785: klucze sortowane po jednostkach UTF-16, liczby jak ECMAScript. */
export function jcs(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return jcsNumber(value);
  if (typeof value === 'string') return jcsString(value);
  if (Array.isArray(value)) return `[${value.map((v) => jcs(v)).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined);
    entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${jcsString(k)}:${jcs(v)}`).join(',')}}`;
  }
  throw new Error(`JCS: nieobsługiwany typ ${typeof value}`);
}

/** round4 z PACK §6.2: połówki od zera. */
export function round4(x: number): number {
  const r = (Math.sign(x) * Math.floor(Math.abs(x) * 10000 + 0.5)) / 10000;
  return Object.is(r, -0) ? 0 : r;
}
