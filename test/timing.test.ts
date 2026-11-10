import { afterEach, describe, expect, test } from 'bun:test';
import { fitUtterances, reconcileTimeline, type FitInput } from '../src/timing/index.ts';
import { defineConfig, resetConfig } from '../src/config/index.ts';
import { KokoAss } from '../src/ass/index.ts';
import { KokoErrors } from '../src/index.ts';
import { mockG2p } from './helpers/plugins.ts';

const settings = { minGap: 80, borrowGap: true, maxDelay: 700 };
// długość ~ odwrotnie proporcjonalna do prędkości, ale nie dokładnie
const measure = async (u: FitInput, speed: number) => Math.round((Number(u.id) * 1000) / speed ** 0.9);

afterEach(() => resetConfig());

describe('ASS §4.6', () => {
  test('mieści się w slocie → s0', async () => {
    const r = await fitUtterances([{ id: '1', start: 0, end: 2000, offset: 0, s0: 1, smax: 1.3 }], settings, measure);
    expect(r[0]).toMatchObject({ t0: 0, speed: 1, duration: 1000, delay: 0, diagnostics: [] });
  });

  test('przyspieszenie (najwyżej 2 ponowne syntezy) i KK401', async () => {
    let calls = 0;
    const m = async (u: FitInput, s: number) => { calls++; return measure(u, s); };
    const r = await fitUtterances([{ id: '3', start: 0, end: 2500, offset: 0, s0: 1, smax: 1.3 }], { ...settings, borrowGap: false }, m);
    expect(calls).toBeLessThanOrEqual(3);
    expect(r[0]!.speed).toBeGreaterThan(1.15);
    expect(r[0]!.diagnostics.map((d) => d.code)).toContain('KK401');
  });

  test('wyjście poza slot (KK402) opóźnia następną; MinGap; BorrowGap', async () => {
    const r = await fitUtterances(
      [
        { id: '3', start: 0, end: 1000, offset: 0, s0: 1, smax: 1 },
        { id: '1', start: 1500, end: 3000, offset: 0, s0: 1, smax: 1 },
      ],
      settings,
      measure,
    );
    expect(r[0]!.slotEnd).toBe(1500); // pożyczona cisza
    expect(r[0]!.diagnostics.map((d) => d.code)).toContain('KK402');
    expect(r[1]!.t0).toBe(3000 + 80);
    expect(r[1]!.diagnostics.map((d) => d.code)).toContain('KK403');
  });
});

describe('PACK §6.3', () => {
  test('stany: aktualna, przesunięta, do przeliczenia, nowa, osierocona', async () => {
    const prev = [
      { key: 'A', slot: { start: 0, end: 2000 }, clip: { start: 0, duration: 1000 }, baseDuration: 1000, speed: 1, gain: 0, delay: 0 },
      { key: 'B', slot: { start: 3000, end: 5000 }, clip: { start: 3000, duration: 1000 }, baseDuration: 1000, speed: 1, gain: 0, delay: 0 },
      { key: 'C', slot: { start: 6000, end: 7000 }, clip: { start: 6000, duration: 1000 }, baseDuration: 1000, speed: 1, gain: 0, delay: 0 },
      { key: 'Z', slot: { start: 9000, end: 9500 }, clip: { start: 9000, duration: 400 }, baseDuration: 400, speed: 1, gain: 0, delay: 0 },
    ];
    const cur = [
      { id: 'a', key: 'A', start: 0, end: 2000, offset: 0, s0: 1, smax: 1, gain: 0 },
      { id: 'b', key: 'B', start: 3200, end: 5200, offset: 0, s0: 1, smax: 1, gain: 0 },
      { id: 'c', key: 'C', start: 6500, end: 7000, offset: 0, s0: 1, smax: 1.5, gain: 0 },
      { id: 'n', key: 'N', start: 8000, end: 8500, offset: 0, s0: 1, smax: 1, gain: 2 },
    ];
    const d = await reconcileTimeline(cur, prev, { ...settings, borrowGap: false });
    expect(d.map((x) => x.state)).toEqual(['current', 'moved', 'recompute', 'new', 'orphaned']);
  });
});

describe('KK302/KK303 (wymaga g2p)', () => {
  test('rozbicie zbyt długiej grupy', async () => {
    defineConfig({ plugins: [mockG2p()] });
    const long = 'słowo '.repeat(120).trim() + ',';
    const src = `[Script Info]\nKokoAnime Version: 1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:01.00,0:00:04.00,Default,A,0,0,0,,{!kk join}${long}\nDialogue: 0,0:00:04.00,0:00:08.00,Default,A,0,0,0,,${long}\nDialogue: 0,0:00:09.00,0:00:12.00,Default,A,0,0,0,,${'długie '.repeat(200)}\n`;
    const doc = KokoAss.parse(src) as KokoAss;
    expect(doc.utterances.length).toBe(2);
    const r = await doc.resolveUtterances();
    expect(r).not.toBeInstanceOf(KokoErrors);
    expect((r as readonly unknown[]).length).toBe(3);
    const codes = (await doc.check()).map((d) => d.code);
    expect(codes).toContain('KK302');
    expect(codes).toContain('KK303');
  });

  test('KK101 dla IPA spoza słownika', async () => {
    defineConfig({ plugins: [mockG2p()] });
    const doc = KokoAss.parse('[Script Info]\n\n[Koko Lexicon]\nJinshi = dʒinʃi\nOk = ɔk\n') as KokoAss;
    const codes = (await doc.check()).filter((d) => d.code === 'KK101').map((d) => d.params.key);
    expect(codes).toEqual(['Jinshi']);
  });

  test('bez g2p → KF002', async () => {
    const doc = KokoAss.parse('[Script Info]\n') as KokoAss;
    expect(await doc.resolveUtterances()).toBeInstanceOf(KokoErrors);
  });
});
