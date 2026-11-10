/**
 * MP3 (MPEG-1/2/2.5 Layer III): indeks ramek, kontrola `spliceable` i podmiana ramek (Koko-Pack §4.1).
 */
import { diag, type Diagnostic } from '../core/diagnostics.ts';
import { KokoErrors } from '../core/errors.ts';
import type { ClipJson } from '../pack/json-types.ts';

/** Ramka audio MPEG Layer III. */
export interface Mp3Frame {
  /** Pozycja w pliku. */
  offset: number;
  /** Rozmiar w bajtach. */
  size: number;
  /** Bitrate. */
  bitrateKbps: number;
  /** Bit dopełnienia. */
  padding: boolean;
  /** Ramka z CRC. */
  crc: boolean;
  /** `main_data_begin` (0 = bez rezerwuaru bitów). */
  mainDataBegin: number;
}

/** Nagłówek LAME/Lavc w ramce Xing/Info. */
export interface LameInfo {
  /** Pozycja napisu `LAME` w pliku. */
  offset: number;
  /** Wartości z nagłówka LAME (bez opóźnienia dekodera). */
  rawDelay: number;
  /** Padding z nagłówka (bez opóźnienia dekodera). */
  rawPadding: number;
}

/** Ramka Xing/Info (pierwsza ramka pliku). */
export interface XingInfo {
  /** Pozycja ramki. */
  offset: number;
  /** Rozmiar ramki. */
  size: number;
  /** `Xing` (VBR) albo `Info` (CBR). */
  tag: 'Xing' | 'Info';
  /** Rozszerzenie LAME. */
  lame?: LameInfo;
}

/** Indeks ramek pliku MP3. */
export interface Mp3Index {
  /** Rozmiar tagu ID3v2 na początku. */
  id3Size: number;
  /** Wersja MPEG. */
  version: 1 | 2 | 2.5;
  /** Częstotliwość próbkowania. */
  sampleRate: number;
  /** Liczba kanałów. */
  channels: 1 | 2;
  /** Próbki na ramkę (1152 MPEG-1, 576 MPEG-2/2.5). */
  samplesPerFrame: 1152 | 576;
  /** Ramka Xing/Info. */
  info?: XingInfo;
  /** Ramki audio (bez Xing/Info). */
  frames: Mp3Frame[];
  /** Pierwsza ramka audio (za ID3v2 i Xing/Info). */
  firstAudioOffset: number;
  /** Koniec ostatniej ramki audio. */
  audioEnd: number;
  /** Liczba zdekodowanych próbek na kanał (ramki × N). */
  totalSamples: number;
  /** encoderDelay wg Koko-Pack (LAME delay + 529 próbek opóźnienia dekodera), jeśli jest nagłówek LAME. */
  encoderDelay?: number;
  /** padding wg Koko-Pack (LAME padding − 529). */
  padding?: number;
}

/** Opóźnienie dekodera MP3 (próbki), dodawane do wartości z nagłówka LAME. */
export const DECODER_DELAY = 529;

const BR_V1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const BR_V2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
const SR: Record<string, number[]> = { '1': [44100, 48000, 32000], '2': [22050, 24000, 16000], '2.5': [11025, 12000, 8000] };

interface Header {
  version: 1 | 2 | 2.5;
  bitrate: number;
  sampleRate: number;
  padding: boolean;
  crc: boolean;
  channels: 1 | 2;
  size: number;
  sideInfo: number;
}

function parseHeader(b: Uint8Array, o: number): Header | null {
  if (o + 4 > b.length || b[o] !== 0xff || (b[o + 1]! & 0xe0) !== 0xe0) return null;
  const vb = (b[o + 1]! >> 3) & 3;
  const layer = (b[o + 1]! >> 1) & 3;
  if (vb === 1 || layer !== 1) return null;
  const version = vb === 3 ? 1 : vb === 2 ? 2 : 2.5;
  const bi = b[o + 2]! >> 4;
  const si = (b[o + 2]! >> 2) & 3;
  if (bi === 0 || bi === 15 || si === 3) return null;
  const bitrate = (version === 1 ? BR_V1 : BR_V2)[bi]!;
  const sampleRate = SR[String(version)]![si]!;
  const padding = ((b[o + 2]! >> 1) & 1) === 1;
  const crc = (b[o + 1]! & 1) === 0;
  const channels = b[o + 3]! >> 6 === 3 ? 1 : 2;
  const size = Math.floor(((version === 1 ? 144000 : 72000) * bitrate) / sampleRate) + (padding ? 1 : 0);
  const sideInfo = version === 1 ? (channels === 1 ? 17 : 32) : channels === 1 ? 9 : 17;
  return { version, bitrate, sampleRate, padding, crc, channels, size, sideInfo };
}

function id3Size(b: Uint8Array): number {
  if (b.length >= 10 && b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) {
    const sz = ((b[6]! & 0x7f) << 21) | ((b[7]! & 0x7f) << 14) | ((b[8]! & 0x7f) << 7) | (b[9]! & 0x7f);
    const footer = (b[5]! & 0x10) !== 0 ? 10 : 0;
    return 10 + sz + footer;
  }
  return 0;
}

function readTag(b: Uint8Array, o: number): string {
  return String.fromCharCode(b[o]!, b[o + 1]!, b[o + 2]!, b[o + 3]!);
}

/** Indeks ramek pliku MP3. null, gdy nie znaleziono ramek. */
export function indexFramesSync(b: Uint8Array): Mp3Index | null {
  let o = id3Size(b);
  const id3 = o;
  // Synchronizacja do pierwszej poprawnej ramki.
  let first: Header | null = null;
  while (o < b.length - 4) {
    first = parseHeader(b, o);
    if (first && parseHeader(b, o + first.size)) break;
    if (first && o + first.size === b.length) break;
    first = null;
    o++;
  }
  if (!first) return null;
  const idx: Mp3Index = {
    id3Size: id3,
    version: first.version,
    sampleRate: first.sampleRate,
    channels: first.channels,
    samplesPerFrame: first.version === 1 ? 1152 : 576,
    frames: [],
    firstAudioOffset: o,
    audioEnd: o,
    totalSamples: 0,
  };
  // Xing/Info w pierwszej ramce.
  const xo = o + 4 + (first.crc ? 2 : 0) + first.sideInfo;
  const tag = xo + 4 <= b.length ? readTag(b, xo) : '';
  if (tag === 'Xing' || tag === 'Info') {
    const flags = (b[xo + 4]! << 24) | (b[xo + 5]! << 16) | (b[xo + 6]! << 8) | b[xo + 7]!;
    let p = xo + 8;
    if (flags & 1) p += 4;
    if (flags & 2) p += 4;
    if (flags & 4) p += 100;
    if (flags & 8) p += 4;
    const info: NonNullable<Mp3Index['info']> = { offset: o, size: first.size, tag };
    if (p + 36 <= o + first.size && /^[A-Za-z]{4}$/.test(readTag(b, p))) {
      // Rozszerzenie LAME (napis `LAME…` albo `Lavc…` z ffmpeg).
      const d = p + 21;
      const rawDelay = (b[d]! << 4) | (b[d + 1]! >> 4);
      const rawPadding = ((b[d + 1]! & 0x0f) << 8) | b[d + 2]!;
      info.lame = { offset: p, rawDelay, rawPadding };
      idx.encoderDelay = rawDelay + DECODER_DELAY;
      idx.padding = Math.max(0, rawPadding - DECODER_DELAY);
    }
    idx.info = info;
    o += first.size;
    idx.firstAudioOffset = o;
  }
  while (o + 4 <= b.length) {
    const h = parseHeader(b, o);
    if (!h || o + h.size > b.length) break;
    const sideStart = o + 4 + (h.crc ? 2 : 0);
    const mdb = h.version === 1 ? (b[sideStart]! << 1) | (b[sideStart + 1]! >> 7) : b[sideStart]!;
    idx.frames.push({ offset: o, size: h.size, bitrateKbps: h.bitrate, padding: h.padding, crc: h.crc, mainDataBegin: mdb });
    o += h.size;
  }
  idx.audioEnd = o;
  idx.totalSamples = idx.frames.length * idx.samplesPerFrame;
  return idx;
}

/** Indeks ramek (Uint8Array albo Blob). */
export async function indexFrames(input: Uint8Array | Blob): Promise<Mp3Index | null> {
  const b = input instanceof Uint8Array ? input : new Uint8Array(await input.arrayBuffer());
  return indexFramesSync(b);
}

/** CRC-16 ramki MPEG (poly 0x8005, init 0xFFFF). */
function crc16Mpeg(data: Uint8Array): number {
  let crc = 0xffff;
  for (const byte of data) {
    for (let i = 7; i >= 0; i--) {
      const bit = ((byte >> i) & 1) ^ ((crc >> 15) & 1);
      crc = (crc << 1) & 0xffff;
      if (bit) crc ^= 0x8005;
    }
  }
  return crc;
}

/** CRC-16/ARC (nagłówek LAME). */
export function crc16Arc(data: Uint8Array, init = 0): number {
  let crc = init;
  for (const byte of data) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = crc & 1 ? (crc >>> 1) ^ 0xa001 : crc >>> 1;
  }
  return crc & 0xffff;
}

function frameCrcOk(b: Uint8Array, f: Mp3Frame, sideInfo: number): boolean {
  if (!f.crc) return true;
  const data = new Uint8Array(2 + sideInfo);
  data[0] = b[f.offset + 2]!;
  data[1] = b[f.offset + 3]!;
  data.set(b.subarray(f.offset + 6, f.offset + 6 + sideInfo), 2);
  const stored = (b[f.offset + 4]! << 8) | b[f.offset + 5]!;
  return crc16Mpeg(data) === stored;
}

/** Warunki podmiany ramek (Koko-Pack §4.1). Pusta lista = plik spełnia warunki; inaczej KP015. */
export function checkSpliceable(index: Mp3Index, bytes?: Uint8Array): Diagnostic[] {
  const reasons: string[] = [];
  const fr = index.frames;
  if (!fr.length) reasons.push('no-frames');
  const size = fr[0]?.size ?? 0;
  const br = fr[0]?.bitrateKbps ?? 0;
  const exact = ((index.version === 1 ? 144000 : 72000) * br) / index.sampleRate;
  if (!Number.isInteger(exact)) reasons.push('frame-size-not-integer');
  for (const f of fr) {
    if (f.bitrateKbps !== br) { reasons.push('vbr'); break; }
  }
  if (fr.some((f) => f.padding)) reasons.push('padding');
  if (fr.some((f) => f.size !== size)) reasons.push('frame-size');
  if (fr.some((f) => f.mainDataBegin !== 0)) reasons.push('bit-reservoir');
  if (bytes) {
    const side = index.version === 1 ? (index.channels === 1 ? 17 : 32) : index.channels === 1 ? 9 : 17;
    if (fr.some((f) => !frameCrcOk(bytes, f, side))) reasons.push('crc');
  }
  return reasons.length ? [diag('KP015', { params: { reasons: reasons.join(',') } })] : [];
}

/** Opcje podmiany ramek. */
export interface SpliceOptions {
  /** Zmieniony klip `[a, b)` w ms napisów. */
  range: [number, number];
  /** `encoderDelay` ścieżki. */
  encoderDelay: number;
  /** `offset` ścieżki (ms). */
  offset: number;
  /** Częstotliwość próbkowania. */
  sampleRate: number;
  /** Klipy osi czasu (po zmianie) — margines 2 ramek musi leżeć w ciszy. */
  clips?: readonly ClipJson[];
}

/** Wynik podmiany ramek. */
export interface SpliceResult {
  /** Nowe bajty pliku (ta sama długość). */
  bytes: Uint8Array;
  /** Zakres faktycznie przekodowany (ms), po ewentualnym rozszerzeniu o sąsiednie klipy. */
  range: [number, number];
  /** Podmienione ramki `[fa, fb)`. */
  frames: [number, number];
}

/**
 * Podmiana ramek dla zakresu (Koko-Pack §4.1, kroki 1–5).
 * `encode(fromContentSample, frameCount)` MUSI zakodować PCM treści od próbki `fromContentSample`
 * tym samym enkoderem i ustawieniami co plik i zwrócić co najmniej `frameCount` ramek audio.
 */
export async function spliceRange(
  bytes: Uint8Array,
  index: Mp3Index,
  opts: SpliceOptions,
  encode: (fromContentSample: number, frameCount: number) => Promise<Uint8Array>,
): Promise<SpliceResult | KokoErrors> {
  const N = index.samplesPerFrame;
  const F = index.frames.length;
  const S = index.frames[0]?.size ?? 0;
  const sample = (t: number) => opts.encoderDelay + Math.round(((t - opts.offset) * opts.sampleRate) / 1000);
  const timeOf = (s: number) => opts.offset + ((s - opts.encoderDelay) * 1000) / opts.sampleRate;
  let [a, b] = opts.range;
  let fa = 0;
  let fb = 0;
  for (let guard = 0; guard < 1000; guard++) {
    fa = Math.max(0, Math.floor(sample(a) / N) - 2);
    fb = Math.min(F, Math.ceil(sample(b) / N) + 2);
    const ma = timeOf(fa * N);
    const mb = timeOf(fb * N);
    let changed = false;
    for (const c of opts.clips ?? []) {
      const cs = c.start;
      const ce = c.start + c.duration;
      if (cs >= a && ce <= b) continue;
      const hitsLeft = cs < a && ce > ma;
      const hitsRight = ce > b && cs < mb;
      if (hitsLeft || hitsRight) {
        a = Math.min(a, cs);
        b = Math.max(b, ce);
        changed = true;
      }
    }
    if (!changed) break;
  }
  if (fb <= fa) return { bytes, range: [a, b], frames: [fa, fb] };
  const encoded = await encode(fa * N, fb - fa);
  const enc = indexFramesSync(encoded);
  if (!enc || enc.frames.length < fb - fa) return new KokoErrors([diag('KP015', { level: 'error', params: { reason: 'encoder-frames' } })]);
  const out = new Uint8Array(bytes);
  const start = index.firstAudioOffset;
  for (let k = 0; k < fb - fa; k++) {
    const f = enc.frames[k]!;
    if (f.size !== S) return new KokoErrors([diag('KP015', { level: 'error', params: { reason: 'encoder-frame-size' } })]);
    out.set(encoded.subarray(f.offset, f.offset + S), start + (fa + k) * S);
  }
  updateLameCrc(out, index);
  return { bytes: out, range: [a, b], frames: [fa, fb] };
}

/** Przelicza CRC muzyki i CRC nagłówka LAME po zmianie ramek. */
export function updateLameCrc(b: Uint8Array, index: Mp3Index): void {
  const lame = index.info?.lame;
  if (!lame || !index.info) return;
  const music = crc16Arc(b.subarray(index.firstAudioOffset, index.audioEnd));
  b[lame.offset + 32] = (music >> 8) & 0xff;
  b[lame.offset + 33] = music & 0xff;
  const tagCrc = crc16Arc(b.subarray(index.info.offset, index.info.offset + 190));
  b[lame.offset + 34] = (tagCrc >> 8) & 0xff;
  b[lame.offset + 35] = tagCrc & 0xff;
}
