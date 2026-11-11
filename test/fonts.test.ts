import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { inflateSync } from 'fflate';
import { defineConfig, resetConfig } from '../src/config/index.ts';
import { KokoAss } from '../src/ass/index.ts';
import { KokoPack, KokoErrors, readFontNames } from '../src/pack/index.ts';
import { nobleCrypto } from '../src/crypto-noble/index.ts';
import { readZip, writeZip } from '../src/pack/zip.ts';
import { ffmpegEncoder, mockG2p, mockSynth } from './helpers/plugins.ts';

/** Minimalny TTF: nagłówek sfnt + tabela `name` (platforma 3, UTF-16BE). */
function makeFont(family: string, full = `${family} Regular`, ps = family.replace(/\s/g, '') + '-Regular', magic: 'ttf' | 'otf' = 'ttf'): Uint8Array {
  const recs: [number, string][] = [[1, family], [4, full], [6, ps]];
  const strings = recs.map(([, s]) => {
    const b = new Uint8Array(s.length * 2);
    for (let i = 0; i < s.length; i++) (b[i * 2] = s.charCodeAt(i) >> 8), (b[i * 2 + 1] = s.charCodeAt(i) & 0xff);
    return b;
  });
  const nameLen = 6 + recs.length * 12 + strings.reduce((n, s) => n + s.length, 0);
  const out = new Uint8Array(12 + 16 + nameLen);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, magic === 'otf' ? 0x4f54544f : 0x00010000);
  dv.setUint16(4, 1);
  out.set([0x6e, 0x61, 0x6d, 0x65], 12); // 'name'
  dv.setUint32(12 + 8, 28);
  dv.setUint32(12 + 12, nameLen);
  const n = 28;
  dv.setUint16(n + 2, recs.length);
  dv.setUint16(n + 4, 6 + recs.length * 12);
  let off = 0;
  recs.forEach(([id], i) => {
    const r = n + 6 + i * 12;
    dv.setUint16(r, 3);
    dv.setUint16(r + 2, 1);
    dv.setUint16(r + 4, 0x415);
    dv.setUint16(r + 6, id);
    dv.setUint16(r + 8, strings[i]!.length);
    dv.setUint16(r + 10, off);
    out.set(strings[i]!, n + 6 + recs.length * 12 + off);
    off += strings[i]!.length;
  });
  return out;
}

const SRC = readFileSync(new URL('./fixtures/spec-example.ass', import.meta.url), 'utf8');
const ok = <T>(x: T | KokoErrors): T => {
  if (x instanceof KokoErrors) throw new Error(`${x.summary} ${JSON.stringify(x.all.map((d) => [d.code, d.params]))}`);
  return x;
};
const blobOf = (b: Uint8Array) => new Blob([b as Uint8Array<ArrayBuffer>]);

beforeEach(() => {
  resetConfig();
  defineConfig({ plugins: [nobleCrypto(), mockG2p(), mockSynth(), ffmpegEncoder()] });
});
afterEach(() => resetConfig());

async function built(): Promise<KokoPack> {
  const p = KokoPack.create({ subtitles: KokoAss.parse(SRC.replace('pan Jinshi{\\i0}', '{\\fnGandhi Sans}pan Jinshi{\\i0}')) as KokoAss });
  ok(await p.rebuild());
  return p;
}

/** Przepakowuje paczkę, zmieniając pliki funkcją `f` (nazwa → bajty albo null = usuń). */
async function repack(blob: Blob, f: (name: string, data: Uint8Array) => Uint8Array | null, extra: { name: string; data: Uint8Array }[] = []): Promise<Blob> {
  const z = await readZip(blob);
  const files = [];
  for (const e of z.entries) {
    let data = new Uint8Array(await blob.slice(e.dataOffset, e.dataOffset + e.compressedSize).arrayBuffer());
    if (e.method === 8) data = inflateSync(data);
    const d = f(e.name, data);
    if (d) files.push({ name: e.name, data: d, method: e.name === 'mimetype' || e.name.startsWith('audio/') ? ('store' as const) : ('deflate' as const) });
  }
  for (const x of extra) files.push({ ...x, method: 'deflate' as const });
  return writeZip(files);
}
const manifestOf = async (blob: Blob) => {
  let m: unknown;
  await repack(blob, (n, d) => ((n === 'manifest.json' ? (m = JSON.parse(new TextDecoder().decode(d))) : 0), d));
  return m as { fonts?: { path: string; sha256: string }[] };
};

describe('Koko-Pack §3.1 — czcionki', () => {
  test('readFontNames: TTF i OTF; śmieci → null', () => {
    expect(readFontNames(makeFont('Gandhi Sans'))).toEqual({ families: ['Gandhi Sans'], fullNames: ['Gandhi Sans Regular'], postscriptNames: ['GandhiSans-Regular'] });
    expect(readFontNames(makeFont('Shin Go', undefined, undefined, 'otf'))!.families).toEqual(['Shin Go']);
    expect(readFontNames(new TextEncoder().encode('to nie jest czcionka'))).toBeNull();
  });

  test('setFont → toBlob → open: fonts/ i manifest.fonts w porządku Unicode', async () => {
    const p = await built();
    ok(await p.setFont('Zeta.ttf', blobOf(makeFont('Zeta'))));
    ok(await p.setFont('Gandhi Sans Bold.ttf', blobOf(makeFont('Gandhi Sans'))));
    const blob = ok(await p.toBlob());
    const m = await manifestOf(blob);
    expect(m.fonts!.map((f) => f.path)).toEqual(['fonts/Gandhi Sans Bold.ttf', 'fonts/Zeta.ttf']);
    const q = ok(await KokoPack.open(blob));
    expect([...q.fonts.keys()]).toEqual(['Gandhi Sans Bold.ttf', 'Zeta.ttf']);
    expect(q.fontNames('Zeta.ttf')!.families).toEqual(['Zeta']);
    expect(q.diagnostics.filter((d) => d.source === 'pack').map((d) => d.code)).toEqual([]);
    expect(ok(await q.toBlob())).toBe(blob); // niezmieniona — bajt w bajt
  });

  test('KP021: kroje użyte w napisach bez pliku w fonts/', async () => {
    const p = await built();
    expect(p.checkFonts().map((d) => d.params.font).sort()).toEqual(['Arial', 'Gandhi Sans']);
    ok(await p.setFont('a.ttf', blobOf(makeFont('Arial'))));
    expect(p.checkFonts().map((d) => [d.code, d.params.font])).toEqual([['KP021', 'Gandhi Sans']]);
  });

  test('setFont: zła nazwa → KP007, nie-czcionka → KP020', async () => {
    const p = await built();
    expect(((await p.setFont('sub/x.ttf', blobOf(makeFont('X')))) as KokoErrors)[0]!.code).toBe('KP007');
    expect(((await p.setFont('x.woff2', blobOf(makeFont('X')))) as KokoErrors)[0]!.code).toBe('KP007');
    expect(((await p.setFont('x.ttf', new Blob(['nie czcionka']))) as KokoErrors)[0]!.code).toBe('KP020');
  });

  test('open: plik spoza manifestu i podkatalog → KP007; zły hash i nie-czcionka → KP020 (paczka otwarta)', async () => {
    const p = await built();
    ok(await p.setFont('a.ttf', blobOf(makeFont('A'))));
    ok(await p.setFont('b.ttf', blobOf(makeFont('B'))));
    const blob = ok(await p.toBlob());
    const font = makeFont('C');
    expect(((await KokoPack.open(await repack(blob, (_n, d) => d, [{ name: 'fonts/c.ttf', data: font }]))) as KokoErrors)[0]!.code).toBe('KP007');
    expect(((await KokoPack.open(await repack(blob, (_n, d) => d, [{ name: 'fonts/x/c.ttf', data: font }]))) as KokoErrors)[0]!.code).toBe('KP007');
    const tampered = await repack(blob, (n, d) => (n === 'fonts/a.ttf' ? makeFont('Inna') : d));
    const q = ok(await KokoPack.open(tampered));
    expect(q.diagnostics.filter((d) => d.code === 'KP020').map((d) => d.params.path)).toEqual(['fonts/a.ttf']);
    expect([...q.fonts.keys()]).toEqual(['b.ttf']);
    const missing = await repack(blob, (n, d) => (n === 'fonts/b.ttf' ? null : d));
    expect(ok(await KokoPack.open(missing)).diagnostics.map((d) => d.code)).toContain('KP004');
  });

  test('limit liczby czcionek → KP020 dla nadmiarowych', async () => {
    const p = await built();
    for (const n of ['a', 'b', 'c']) ok(await p.setFont(`${n}.ttf`, blobOf(makeFont(n.toUpperCase()))));
    const blob = ok(await p.toBlob());
    const q = ok(await KokoPack.open(blob, { config: { limits: { fontsMaxCount: 2 } } }));
    expect([...q.fonts.keys()]).toEqual(['a.ttf', 'b.ttf']);
    expect(q.diagnostics.filter((d) => d.code === 'KP020').map((d) => d.params.reason)).toEqual(['limit']);
  });
});
