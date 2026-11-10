/**
 * Minimalny czytnik/zapisywacz ZIP dla Koko-Pack (PACK §2): STORED/DEFLATE, UTF-8, ZIP64,
 * odczyt STORED bez kopiowania (Blob.slice), deterministyczny zapis.
 */
import { inflateSync, deflateSync } from 'fflate';

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(data: Uint8Array, crc = 0): number {
  let c = ~crc >>> 0;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8);
  return ~c >>> 0;
}

export async function crc32Blob(blob: Blob): Promise<number> {
  let c = 0;
  const CHUNK = 4 * 1024 * 1024;
  for (let off = 0; off < blob.size; off += CHUNK) c = crc32(new Uint8Array(await blob.slice(off, off + CHUNK).arrayBuffer()), c);
  return c;
}

export interface ZipEntry {
  name: string;
  method: number;
  flags: number;
  crc: number;
  compressedSize: number;
  size: number;
  localOffset: number;
  /** Bajty danych (po nagłówku lokalnym). */
  dataOffset: number;
  extraLength: number;
  isDirectory: boolean;
  isSymlink: boolean;
  encrypted: boolean;
}

export interface ZipReadResult {
  entries: ZipEntry[];
  /** Błędy struktury (np. wieloczęściowe, brak katalogu centralnego). */
  error?: string;
}

const dv = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength);

function readU64(v: DataView, o: number): number {
  return v.getUint32(o, true) + v.getUint32(o + 4, true) * 2 ** 32;
}

/** Czyta katalog centralny archiwum. */
export async function readZip(blob: Blob): Promise<ZipReadResult> {
  const size = blob.size;
  if (size < 22) return { entries: [], error: 'too-small' };
  const tailLen = Math.min(size, 65535 + 22 + 20);
  const tail = new Uint8Array(await blob.slice(size - tailLen).arrayBuffer());
  const tv = dv(tail);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tv.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return { entries: [], error: 'no-eocd' };
  const disk = tv.getUint16(eocd + 4, true);
  const cdDisk = tv.getUint16(eocd + 6, true);
  let count = tv.getUint16(eocd + 10, true);
  let cdSize = tv.getUint32(eocd + 12, true);
  let cdOffset = tv.getUint32(eocd + 16, true);
  if (disk !== 0 || cdDisk !== 0) return { entries: [], error: 'multi-part' };
  // ZIP64
  if (eocd >= 20 && tv.getUint32(eocd - 20, true) === 0x07064b50) {
    const z64off = readU64(tv, eocd - 20 + 8);
    const z = new Uint8Array(await blob.slice(z64off, z64off + 56).arrayBuffer());
    const zv = dv(z);
    if (zv.getUint32(0, true) === 0x06064b50) {
      count = readU64(zv, 32);
      cdSize = readU64(zv, 40);
      cdOffset = readU64(zv, 48);
    }
  }
  const cd = new Uint8Array(await blob.slice(cdOffset, cdOffset + cdSize).arrayBuffer());
  const cv = dv(cd);
  const entries: ZipEntry[] = [];
  let p = 0;
  const dec = new TextDecoder('utf-8', { fatal: false });
  for (let i = 0; i < count; i++) {
    if (p + 46 > cd.length || cv.getUint32(p, true) !== 0x02014b50) return { entries, error: 'bad-central-directory' };
    const madeBy = cv.getUint16(p + 4, true);
    const flags = cv.getUint16(p + 8, true);
    const method = cv.getUint16(p + 10, true);
    const crc = cv.getUint32(p + 16, true);
    let compressedSize = cv.getUint32(p + 20, true);
    let usize = cv.getUint32(p + 24, true);
    const nameLen = cv.getUint16(p + 28, true);
    const extraLen = cv.getUint16(p + 30, true);
    const commentLen = cv.getUint16(p + 32, true);
    const ext = cv.getUint32(p + 38, true);
    let localOffset = cv.getUint32(p + 42, true);
    const nameBytes = cd.subarray(p + 46, p + 46 + nameLen);
    const name = dec.decode(nameBytes);
    // ZIP64 extra
    let e = p + 46 + nameLen;
    const eEnd = e + extraLen;
    while (e + 4 <= eEnd) {
      const id = cv.getUint16(e, true);
      const len = cv.getUint16(e + 2, true);
      if (id === 0x0001) {
        let q = e + 4;
        if (usize === 0xffffffff) { usize = readU64(cv, q); q += 8; }
        if (compressedSize === 0xffffffff) { compressedSize = readU64(cv, q); q += 8; }
        if (localOffset === 0xffffffff) { localOffset = readU64(cv, q); q += 8; }
      }
      e += 4 + len;
    }
    const unix = madeBy >> 8 === 3;
    const mode = unix ? (ext >>> 16) & 0o170000 : 0;
    entries.push({
      name,
      method,
      flags,
      crc,
      compressedSize,
      size: usize,
      localOffset,
      dataOffset: -1,
      extraLength: 0,
      isDirectory: name.endsWith('/'),
      isSymlink: mode === 0o120000,
      encrypted: (flags & 1) !== 0,
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  // Nagłówki lokalne → przesunięcia danych.
  for (const en of entries) {
    const h = new Uint8Array(await blob.slice(en.localOffset, en.localOffset + 30).arrayBuffer());
    if (h.length < 30 || dv(h).getUint32(0, true) !== 0x04034b50) return { entries, error: 'bad-local-header' };
    const nl = dv(h).getUint16(26, true);
    const el = dv(h).getUint16(28, true);
    en.extraLength = el;
    en.dataOffset = en.localOffset + 30 + nl + el;
  }
  return { entries };
}

/** Dane wpisu: STORED → Blob.slice (bez kopiowania), DEFLATE → rozpakowanie (z limitem rozmiaru). */
export async function entryBlob(blob: Blob, e: ZipEntry, maxBytes = Infinity): Promise<Blob | null> {
  const raw = blob.slice(e.dataOffset, e.dataOffset + e.compressedSize);
  if (e.method === 0) return raw;
  if (e.method !== 8) return null;
  if (e.size > maxBytes) return null;
  const out = inflateSync(new Uint8Array(await raw.arrayBuffer()), { out: new Uint8Array(e.size) });
  return new Blob([out as Uint8Array<ArrayBuffer>]);
}

export interface ZipWriteEntry {
  name: string;
  data: Blob | Uint8Array;
  method: 'store' | 'deflate';
}

/**
 * Zapis archiwum: bez deskryptorów danych, nazwy UTF-8 (bit 11), stała data (determinizm),
 * ZIP64 dla dużych plików. Dane STORED Blob nie są kopiowane.
 */
export async function writeZip(entries: readonly ZipWriteEntry[]): Promise<Blob> {
  const enc = new TextEncoder();
  const parts: BlobPart[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const DOS_TIME = 0;
  const DOS_DATE = (0 << 9) | (1 << 5) | 1; // 1980-01-01
  for (const en of entries) {
    const nameBytes = enc.encode(en.name);
    let data: Blob | Uint8Array = en.data;
    let crc: number;
    let size: number;
    let method = 0;
    if (en.method === 'deflate') {
      const bytes = data instanceof Uint8Array ? data : new Uint8Array(await data.arrayBuffer());
      crc = crc32(bytes);
      size = bytes.length;
      data = deflateSync(bytes, { level: 9 });
      method = 8;
    } else if (data instanceof Uint8Array) {
      crc = crc32(data);
      size = data.length;
    } else {
      crc = await crc32Blob(data);
      size = data.size;
    }
    const csize = data instanceof Uint8Array ? data.length : data.size;
    const zip64 = size >= 0xffffffff || csize >= 0xffffffff || offset >= 0xffffffff;
    const isMimetype = en.name === 'mimetype';
    const localExtra = zip64 && !isMimetype ? 20 : 0;
    const lh = new Uint8Array(30 + nameBytes.length + localExtra);
    const lv = dv(lh);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, zip64 ? 45 : 20, true);
    lv.setUint16(6, 0x0800, true);
    lv.setUint16(8, method, true);
    lv.setUint16(10, DOS_TIME, true);
    lv.setUint16(12, DOS_DATE, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, zip64 ? 0xffffffff : csize, true);
    lv.setUint32(22, zip64 ? 0xffffffff : size, true);
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, localExtra, true);
    lh.set(nameBytes, 30);
    if (localExtra) {
      lv.setUint16(30 + nameBytes.length, 1, true);
      lv.setUint16(32 + nameBytes.length, 16, true);
      lv.setBigUint64(34 + nameBytes.length, BigInt(size), true);
      lv.setBigUint64(42 + nameBytes.length, BigInt(csize), true);
    }
    parts.push(lh as Uint8Array<ArrayBuffer>, data as BlobPart);
    const cExtra = zip64 ? 28 : 0;
    const ch = new Uint8Array(46 + nameBytes.length + cExtra);
    const cv = dv(ch);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, (3 << 8) | (zip64 ? 45 : 20), true);
    cv.setUint16(6, zip64 ? 45 : 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, method, true);
    cv.setUint16(12, DOS_TIME, true);
    cv.setUint16(14, DOS_DATE, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, zip64 ? 0xffffffff : csize, true);
    cv.setUint32(24, zip64 ? 0xffffffff : size, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint16(30, cExtra, true);
    cv.setUint32(38, (0o100644 << 16) >>> 0, true);
    cv.setUint32(42, zip64 ? 0xffffffff : offset, true);
    ch.set(nameBytes, 46);
    if (zip64) {
      const q = 46 + nameBytes.length;
      cv.setUint16(q, 1, true);
      cv.setUint16(q + 2, 24, true);
      cv.setBigUint64(q + 4, BigInt(size), true);
      cv.setBigUint64(q + 12, BigInt(csize), true);
      cv.setBigUint64(q + 20, BigInt(offset), true);
    }
    central.push(ch);
    offset += lh.length + csize;
  }
  const cdSize = central.reduce((s, c) => s + c.length, 0);
  const cdOffset = offset;
  for (const c of central) parts.push(c as Uint8Array<ArrayBuffer>);
  const needZip64 = cdOffset >= 0xffffffff || entries.length >= 0xffff;
  if (needZip64) {
    const z = new Uint8Array(56 + 20);
    const zv = dv(z);
    zv.setUint32(0, 0x06064b50, true);
    zv.setBigUint64(4, 44n, true);
    zv.setUint16(12, 45, true);
    zv.setUint16(14, 45, true);
    zv.setBigUint64(24, BigInt(entries.length), true);
    zv.setBigUint64(32, BigInt(entries.length), true);
    zv.setBigUint64(40, BigInt(cdSize), true);
    zv.setBigUint64(48, BigInt(cdOffset), true);
    zv.setUint32(56, 0x07064b50, true);
    zv.setBigUint64(64, BigInt(cdOffset + cdSize), true);
    zv.setUint32(72, 1, true);
    parts.push(z);
  }
  const end = new Uint8Array(22);
  const ev = dv(end);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, Math.min(entries.length, 0xffff), true);
  ev.setUint16(10, Math.min(entries.length, 0xffff), true);
  ev.setUint32(12, Math.min(cdSize, 0xffffffff), true);
  ev.setUint32(16, needZip64 ? 0xffffffff : cdOffset, true);
  parts.push(end);
  return new Blob(parts);
}
