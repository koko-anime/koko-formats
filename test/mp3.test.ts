import { describe, expect, test } from 'bun:test';
import { checkSpliceable, indexFramesSync, spliceRange } from '../src/mp3/index.ts';
import { KokoErrors } from '../src/index.ts';
import { SR, decodeRaw, encodeMp3, tone } from './helpers/audio.ts';

function compose(total: number, clips: { at: number; pcm: Float32Array }[]): Float32Array {
  const out = new Float32Array(Math.round((total * SR) / 1000));
  for (const c of clips) out.set(c.pcm, Math.round((c.at * SR) / 1000));
  return out;
}

function rms(a: Float32Array, b: Float32Array, from: number, to: number): number {
  let s = 0;
  for (let i = from; i < to; i++) s += ((a[i] ?? 0) - (b[i] ?? 0)) ** 2;
  return Math.sqrt(s / (to - from));
}

describe('MP3 (Koko-Pack §4.1)', () => {
  test('indeks, gapless i warunki spliceable', () => {
    const b = encodeMp3(tone(3000));
    const i = indexFramesSync(b)!;
    expect(i.version).toBe(2);
    expect(i.frames[0]!.size).toBe(192);
    expect(i.encoderDelay).toBe(1105);
    expect(i.encoderDelay! + 72000 + i.padding!).toBe(i.totalSamples);
    expect(checkSpliceable(i, b)).toEqual([]);
  });

  test('podmiana ramek daje to samo co pełne kodowanie', async () => {
    const before = compose(5000, [{ at: 1000, pcm: tone(500, 440) }, { at: 3000, pcm: tone(500, 440) }]);
    const after = compose(5000, [{ at: 1000, pcm: tone(500, 440) }, { at: 3000, pcm: tone(500, 660) }]);
    const orig = encodeMp3(before);
    const idx = indexFramesSync(orig)!;
    const r = await spliceRange(
      orig,
      idx,
      { range: [3000, 3500], encoderDelay: idx.encoderDelay!, offset: 0, sampleRate: SR, clips: [{ start: 1000, duration: 500 }, { start: 3000, duration: 500 }] },
      async (from, frames) => encodeMp3(after.subarray(from, from + (frames + 4) * 576), { rawFrames: true }),
    );
    expect(r).not.toBeInstanceOf(KokoErrors);
    const res = r as Exclude<typeof r, KokoErrors>;
    expect(res.bytes.length).toBe(orig.length);
    // ramki poza zakresem bez zmian
    const S = 192;
    const start = idx.firstAudioOffset;
    expect(res.bytes.subarray(start, start + res.frames[0] * S)).toEqual(orig.subarray(start, start + res.frames[0] * S));
    const spliced = decodeRaw(res.bytes);
    const full = decodeRaw(encodeMp3(after));
    const d = idx.encoderDelay!;
    const e = rms(spliced, full, d, d + after.length);
    expect(e).toBeLessThan(0.01);
    // nowy ton faktycznie jest w środku
    expect(rms(spliced, decodeRaw(orig), d + 3000 * 24, d + 3500 * 24)).toBeGreaterThan(0.05);
  });
});
