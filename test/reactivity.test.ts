import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { defineConfig, resetConfig } from '../src/config/index.ts';
import { definePlugin, type Atom } from '../src/plugin/index.ts';
import { KokoAss } from '../src/ass/index.ts';
import { KokoLexicon } from '../src/lexicon/index.ts';

const SRC = readFileSync(new URL('./fixtures/spec-example.ass', import.meta.url), 'utf8');

/** Minimalny system efektów (jak sygnały frameworka). */
function signals() {
  let current: (() => void) | null = null;
  let depth = 0;
  const pending = new Set<() => void>();
  const createAtom = (): Atom => {
    const subs = new Set<() => void>();
    return {
      track() { if (current) subs.add(current); },
      trigger() { for (const s of [...subs]) depth ? pending.add(s) : s(); },
    };
  };
  const effect = (fn: () => void) => {
    const run = () => { const prev = current; current = run; try { fn(); } finally { current = prev; } };
    run();
  };
  const untrack = <T>(fn: () => T): T => { const prev = current; current = null; try { return fn(); } finally { current = prev; } };
  const batch = (fn: () => void) => { depth++; try { fn(); } finally { depth--; if (!depth) { const p = [...pending]; pending.clear(); p.forEach((f) => f()); } } };
  return { plugin: definePlugin({ name: 'signals', reactivity: { createAtom, untrack, batch } }), effect };
}

afterEach(() => resetConfig());

describe('reaktywność (§2.5)', () => {
  test('granulacja: zmiana jednej linii nie odświeża dalekich linii', () => {
    const s = signals();
    defineConfig({ plugins: [s.plugin] });
    const doc = KokoAss.parse(SRC) as KokoAss;
    expect(doc.reactive).toBe(true);
    const d = doc.events.dialogues;
    let nearRuns = 0, farRuns = 0, diagRuns = 0;
    s.effect(() => { void d[2]!.analysis.spokenText; nearRuns++; });
    s.effect(() => { void d[8]!.analysis.spokenText; farRuns++; });
    s.effect(() => { void doc.diagnostics.length; diagRuns++; });
    d[2]!.text = 'Idę do ogrodu.';
    expect(nearRuns).toBe(2);
    expect(farRuns).toBe(1);
    expect(diagRuns).toBe(2);
    // wartość z cache nadal śledzona
    d[2]!.text = 'Idę do domu.';
    expect(nearRuns).toBe(3);
    expect(diagRuns).toBe(3);
  });

  test('zmiana ustawień odświeża wszystkie linie; batch — jedno odświeżenie', () => {
    const s = signals();
    defineConfig({ plugins: [s.plugin] });
    const doc = KokoAss.parse(SRC) as KokoAss;
    let runs = 0;
    s.effect(() => { void doc.events.dialogues[8]!.analysis.read; runs++; });
    doc.koko.rules.set('SkipIfNoActor', false);
    expect(runs).toBe(2);
    expect(doc.events.dialogues[8]!.analysis.read).toBe(true);
    doc.batch('x', () => { doc.koko.rules.set('Join', 'auto'); doc.koko.rules.set('Join', 'no'); });
    expect(runs).toBe(3);
  });

  test('pola elementów i leksykon serii', () => {
    const s = signals();
    defineConfig({ plugins: [s.plugin] });
    const lx = KokoLexicon.create();
    const doc = KokoAss.parse(SRC, { seriesLexicon: lx }) as KokoAss;
    let text = '';
    s.effect(() => { text = doc.events.dialogues[2]!.analysis.spokenText; });
    lx.entries.add('pałacu', { respell: 'pa-ła-cu' });
    expect(text).toBe('Idę do pa-ła-cu.');
    let start = 0;
    s.effect(() => { start = doc.events.dialogues[2]!.start; });
    doc.events.dialogues[2]!.start = 9000;
    expect(start).toBe(9000);
  });

  test('bez pluginu atomy są puste, onChange działa', () => {
    const doc = KokoAss.parse(SRC) as KokoAss;
    expect(doc.reactive).toBe(false);
    let n = 0;
    doc.onChange(() => n++);
    doc.events.dialogues[2]!.text = 'x';
    expect(n).toBe(1);
  });

  test('markRaw: flaga __v_skip dla Vue', () => {
    const doc = KokoAss.parse(SRC) as KokoAss;
    expect((doc as unknown as { __v_skip: boolean }).__v_skip).toBe(true);
    expect((doc.events.dialogues[0] as unknown as { __v_skip: boolean }).__v_skip).toBe(true);
  });
});
