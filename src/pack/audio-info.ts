/**
 * Informacje o plikach audio: Ogg Opus (pre-skip, granule) i MP3 (przez indeks ramek).
 */
import { indexFramesSync, type Mp3Index } from '../mp3/mp3.ts';

export interface OpusInfo {
  channels: number;
  preSkip: number;
  /** Ostatnia pozycja granule (próbki 48 kHz, łącznie z pre-skip). */
  granule: number;
  /** Długość treści w próbkach 48 kHz (granule − pre-skip). */
  contentSamples: number;
}

/** Odczyt nagłówka OpusHead i ostatniej pozycji granule (RFC 7845). */
export function opusInfo(b: Uint8Array): OpusInfo | null {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let p = 0;
  let head: { channels: number; preSkip: number } | null = null;
  let granule = 0;
  while (p + 27 <= b.length) {
    if (b[p] !== 0x4f || b[p + 1] !== 0x67 || b[p + 2] !== 0x67 || b[p + 3] !== 0x53) return null;
    const g = dv.getUint32(p + 6, true) + dv.getUint32(p + 10, true) * 2 ** 32;
    const segs = b[p + 26]!;
    let size = 0;
    for (let i = 0; i < segs; i++) size += b[p + 27 + i]!;
    const data = p + 27 + segs;
    if (!head) {
      const magic = String.fromCharCode(...b.subarray(data, data + 8));
      if (magic !== 'OpusHead') return null;
      head = { channels: b[data + 9]!, preSkip: dv.getUint16(data + 10, true) };
    }
    if (g !== 0xffffffff + 0xffffffff * 2 ** 32 && g > granule) granule = g;
    p = data + size;
  }
  if (!head) return null;
  return { channels: head.channels, preSkip: head.preSkip, granule, contentSamples: Math.max(0, granule - head.preSkip) };
}

export interface ProbedAudio {
  codec: 'mp3' | 'opus';
  sampleRate: number;
  channels: number;
  encoderDelay: number;
  padding: number;
  /** Długość treści (ms). */
  duration: number;
  mp3?: Mp3Index;
  opus?: OpusInfo;
}

/** Odczyt parametrów pliku (do KP012 i po zakodowaniu). */
export function probeAudio(b: Uint8Array, codec: 'mp3' | 'opus'): ProbedAudio | null {
  if (codec === 'opus') {
    const o = opusInfo(b);
    if (!o) return null;
    return { codec, sampleRate: 48000, channels: o.channels, encoderDelay: o.preSkip, padding: 0, duration: Math.round((o.contentSamples * 1000) / 48000), opus: o };
  }
  const m = indexFramesSync(b);
  if (!m) return null;
  const delay = m.encoderDelay ?? 0;
  const padding = m.padding ?? 0;
  const content = Math.max(0, m.totalSamples - delay - padding);
  return { codec, sampleRate: m.sampleRate, channels: m.channels, encoderDelay: delay, padding, duration: Math.round((content * 1000) / m.sampleRate), mp3: m };
}
