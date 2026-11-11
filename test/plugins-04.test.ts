import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { defineConfig, disposePlugins, preparePlugins, resetConfig, retryPlugin } from '../src/config/index.ts';
import { definePlugin, PLUGIN_API_VERSION, type KokoPlugin, type LogEntry, type ProgressEvent, type SynthResult } from '../src/plugin/index.ts';
import { KokoAss, listFormats, sniffFormat } from '../src/ass/index.ts';
import { KokoPack, KokoErrors } from '../src/pack/index.ts';
import { kokoFormats, SPEC_VERSION } from '../src/index.ts';
import { nobleCrypto, randomPrivateKey } from '../src/crypto-noble/index.ts';
import { ffmpegEncoder, mockG2p, mockSynth, synthCalls } from './helpers/plugins.ts';

const SRC = readFileSync(new URL('./fixtures/spec-example.ass', import.meta.url), 'utf8');
const ass = (config?: Parameters<typeof KokoAss.parse>[1]) => KokoAss.parse(SRC, config) as KokoAss;
const ok = <T>(x: T | KokoErrors): T => {
  if (x instanceof KokoErrors) throw new Error(`${x.summary} ${JSON.stringify(x.all.map((d) => [d.code, d.params]))}`);
  return x;
};
const codes = (xs: readonly { code: string }[]) => xs.map((d) => d.code);

beforeEach(() => resetConfig());
afterEach(() => resetConfig());

describe('A1 — wersja API', () => {
  test('wersje', () => {
    expect(PLUGIN_API_VERSION).toBe('0.4');
    expect(SPEC_VERSION).toBe('0.4.0');
    expect(kokoFormats.specVersion).toBe('0.4.0');
  });

  test('brak api → KF007 warning, plugin działa; zła wersja → KF007 error, plugin pominięty', async () => {
    const legacy = { name: 'legacy', fs: { readText: async () => SRC, readBlob: async () => new Blob(), exists: async () => false, resolve: (a: string, b: string) => `${a}/${b}` } } as unknown as KokoPlugin;
    const future = definePlugin({ name: 'future', api: '0.5', g2p: mockG2p().g2p });
    defineConfig({ plugins: [legacy, future] });
    expect(kokoFormats.diagnostics.map((d) => [d.code, d.level, d.params.plugin])).toEqual([
      ['KF007', 'warning', 'legacy'],
      ['KF007', 'error', 'future'],
    ]);
    expect(await KokoAss.load('/a.ass')).toBeInstanceOf(KokoAss);
    expect(codes(await ass().check())).toContain('KF002'); // g2p z pominiętego pluginu
  });
});

describe('A2 — cykl życia', () => {
  test('setup leniwie, raz; dispose przy resetConfig', async () => {
    const log: string[] = [];
    const p = definePlugin({
      name: 'model', api: '0.4',
      setup: async (ctx) => { log.push(`setup ${ctx.api}`); await Bun.sleep(5); },
      dispose: () => { log.push('dispose'); },
      g2p: mockG2p().g2p,
    });
    defineConfig({ plugins: [p] });
    expect(log).toEqual([]);
    const doc = ass();
    await Promise.all([doc.check(), doc.check()]);
    expect(log).toEqual(['setup 0.4']);
    resetConfig();
    await Bun.sleep(1);
    expect(log).toEqual(['setup 0.4', 'dispose']);
  });

  test('błąd setup → KF008, capability jak nieobecna, retryPlugin', async () => {
    let fail = true;
    const p = definePlugin({ name: 'flaky', api: '0.4', setup: () => { if (fail) throw new Error('brak modelu'); }, g2p: mockG2p().g2p });
    defineConfig({ plugins: [p] });
    const r = await preparePlugins(['g2p']);
    expect((r as KokoErrors).map((d) => [d.code, d.params.plugin])).toEqual([['KF008', 'flaky']]);
    expect(codes(await ass().check())).toContain('KF002');
    fail = false;
    expect(await retryPlugin('flaky')).toBeUndefined();
    expect(codes(await ass().check())).not.toContain('KF002');
  });

  test('KF008 z wywołania capability', async () => {
    defineConfig({ plugins: [definePlugin({ name: 'bad', api: '0.4', setup: () => Promise.reject(new Error('x')), g2p: mockG2p().g2p })] });
    const r = await ass().resolveUtterances();
    expect((r as KokoErrors)[0]!.code).toBe('KF008');
  });

  test('plugin o tej samej nazwie zastępuje poprzedni (dispose)', async () => {
    const log: string[] = [];
    const mk = (v: string) => definePlugin({ name: 'same', api: '0.4', version: v, dispose: () => { log.push(`dispose ${v}`); } });
    defineConfig({ plugins: [mk('1')] });
    defineConfig({ plugins: [mk('2')] });
    await Bun.sleep(1);
    expect(log).toEqual(['dispose 1']);
    expect(kokoFormats.config.plugins!.map((p) => p.version)).toEqual(['2']);
    await disposePlugins();
    expect(log).toEqual(['dispose 1', 'dispose 2']);
  });
});

describe('A4 — logger i postęp', () => {
  test('logger dostaje KF007 i błędy setup', async () => {
    const entries: LogEntry[] = [];
    defineConfig({ plugins: [definePlugin({ name: 'log', api: '0.4', logger: { level: 'debug', write: (e) => entries.push(e) } })] });
    defineConfig({ plugins: [{ name: 'old' } as unknown as KokoPlugin] });
    defineConfig({ plugins: [definePlugin({ name: 'boom', api: '0.4', setup: () => { throw new Error('x'); } })] });
    await preparePlugins();
    expect(entries.map((e) => [e.level, e.source, e.message.slice(0, 5)])).toEqual([
      ['warn', '@koko-anime/formats', 'KF007'],
      ['error', 'boom', 'setup'],
    ]);
  });

  test('rebuild emituje ProgressEvent', async () => {
    defineConfig({ plugins: [nobleCrypto(), mockG2p(), mockSynth(), ffmpegEncoder()] });
    const events: ProgressEvent[] = [];
    ok(await KokoPack.create({ subtitles: ass() }).rebuild(undefined, { onProgress: (e) => events.push(e) }));
    const stages = new Set(events.map((e) => e.stage));
    expect([...stages].sort()).toEqual(['encode', 'measure', 'synth']);
    const synth = events.filter((e) => e.stage === 'synth');
    expect(synth.at(-1)).toMatchObject({ done: 7, total: 7 });
  });
});

describe('B6 — reguły', () => {
  const rulesPlugin = () =>
    definePlugin({
      name: 'studio', api: '0.4',
      rules: {
        ass: [
          { scope: 'line', code: 'X:studio/grzyby', level: 'warning', title: 'Grzyby', check: (l) => (l.spokenText.includes('grzyby') ? [{ targetId: l.id }] : undefined) },
          { scope: 'document', code: 'X:studio/liczba', level: 'info', title: 'Liczba wypowiedzi', check: (d) => [{ targetId: d.lines[0]!.id, params: { n: d.utterances.length } }] },
          { scope: 'line', code: 'X:studio/wadliwa', level: 'info', title: 'Wadliwa', enabled: false, check: () => { throw new Error('ups'); } },
        ],
      },
    });

  test('reguły linii i dokumentu w diagnostics i line.analysis', () => {
    defineConfig({ plugins: [rulesPlugin()] });
    const doc = ass();
    const x = doc.diagnostics.filter((d) => d.code.startsWith('X:'));
    expect(x.map((d) => [d.code, d.level, d.source])).toEqual([
      ['X:studio/grzyby', 'warning', 'ass'],
      ['X:studio/liczba', 'info', 'ass'],
    ]);
    expect(x[1]!.params.n).toBe(7);
    const line = doc.events.dialogues.find((e) => e.text.includes('grzyby'))!;
    expect(codes(line.analysis.diagnostics)).toContain('X:studio/grzyby');
    line.kk.say = 'Zbierają kwiaty.';
    expect(codes(doc.diagnostics)).not.toContain('X:studio/grzyby');
  });

  test('konfiguracja: off, poziom, włączenie wyłączonej → KF009', () => {
    defineConfig({ plugins: [rulesPlugin()], rules: { 'X:studio/liczba': 'off', 'X:studio/grzyby': 'error', 'X:studio/wadliwa': 'on' } });
    const d = ass().diagnostics;
    expect(codes(d)).not.toContain('X:studio/liczba');
    expect(d.find((x) => x.code === 'X:studio/grzyby')!.level).toBe('error');
    expect(d.filter((x) => x.code === 'KF009').length).toBeGreaterThan(0);
  });

  test('reguła dodana po utworzeniu dokumentu działa (konfiguracja czytana przy odczycie)', () => {
    const doc = ass();
    expect(codes(doc.diagnostics)).not.toContain('X:studio/grzyby');
    defineConfig({ plugins: [rulesPlugin()] });
    expect(codes(doc.diagnostics)).toContain('X:studio/grzyby');
  });

  test('KF011: zduplikowany kod reguły', () => {
    defineConfig({ plugins: [rulesPlugin(), { ...rulesPlugin(), name: 'studio-2' }] });
    expect(codes(kokoFormats.diagnostics)).toContain('KF011');
  });
});

describe('B7 — normalizacja', () => {
  const norm = (activation: 'always' | 'opt-in', order = 400) =>
    definePlugin({
      name: 'studio', api: '0.4',
      normalizers: [{
        id: 'studio/palac', version: 1, order, languages: ['pl'], activation,
        normalize: (t) => {
          const i = t.indexOf('pałacu');
          return i < 0 ? { text: t } : { text: t.replace('pałacu', 'ogrodu'), replacements: [{ from: 'pałacu', to: 'ogrodu', index: i }] };
        },
      }],
    });

  test('always: zmienia tekst mówiony, segmenty i klucz', () => {
    const before = ass().utterances[1]!;
    defineConfig({ plugins: [norm('always')] });
    const doc = ass();
    const u = doc.utterances[1]!;
    expect(u.text).toBe('Idę do ogrodu.');
    expect(u.key({ model: 'm', g2p: 'g' })).not.toBe(before.key({ model: 'm', g2p: 'g' }));
    const line = doc.events.items.find((e) => e.text === 'Idę do pałacu.')!;
    expect(line.analysis.replacements).toEqual([{ normalizer: 'studio/palac', from: 'pałacu', to: 'ogrodu', index: 7 }]);
  });

  test('opt-in wymaga włączenia; always można wyłączyć', () => {
    defineConfig({ plugins: [norm('opt-in')] });
    expect(ass().utterances[1]!.text).toBe('Idę do pałacu.');
    defineConfig({ normalizers: { 'studio/palac': 'on' } });
    expect(ass().utterances[1]!.text).toBe('Idę do ogrodu.');
    resetConfig();
    defineConfig({ plugins: [norm('always')], normalizers: { 'studio/palac': 'off' } });
    expect(ass().utterances[1]!.text).toBe('Idę do pałacu.');
  });

  test('kolejność względem koko/numbers-pl (order 500)', () => {
    const seen: string[] = [];
    const spy = (order: number) => definePlugin({ name: `spy${order}`, api: '0.4', normalizers: [{ id: `spy/o${order}`, version: 1, order, activation: 'always', normalize: (t) => { if (t.includes('pokój')) seen.push(`${order}:${t}`); return { text: t }; } }] });
    defineConfig({ plugins: [spy(600), spy(400)] });
    const doc = KokoAss.parse(SRC.replace('[Koko Rules]', '[Koko Rules]\nNumbers = auto').replace('Idę do pałacu.', 'pokój 3')) as KokoAss;
    void doc.utterances;
    expect(seen).toEqual(['400:pokój 3', '600:pokój trzy']);
  });

  test('wyjątek → KF010, tekst bez zmian', () => {
    defineConfig({ plugins: [definePlugin({ name: 'zly', api: '0.4', normalizers: [{ id: 'zly/n', version: 1, order: 1, activation: 'always', normalize: () => { throw new Error('x'); } }] })] });
    const doc = ass();
    expect(codes(doc.diagnostics)).toContain('KF010');
    expect(doc.utterances[1]!.text).toBe('Idę do pałacu.');
  });
});

describe('B8 — import i eksport', () => {
  test('wbudowany ass: import tworzy szkielet, eksport usuwa sekcje Koko', async () => {
    const plain = '[Script Info]\nScriptType: v4.00+\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:01.00,0:00:02.00,Default,A,0,0,0,,Cześć.\n';
    expect(sniffFormat(plain)).toBe('ass');
    const doc = ok(await KokoAss.import('ass', plain));
    expect(doc.scriptInfo.kokoVersion).toBe(1);
    const out = ok(await ass().export('ass')) as string;
    expect(out).not.toContain('[Koko');
    expect(out).not.toContain('KokoAnime Version');
    expect(out).toContain('[Events]');
  });

  test('format z pluginu, KF012, KF004', async () => {
    defineConfig({
      plugins: [definePlugin({
        name: 'studio', api: '0.4',
        formats: [
          { id: 'studio/scenariusz', label: 'Scenariusz', extensions: ['.txt'], export: async (doc: KokoAss) => doc.utterances.map((u) => u.text).join('\n') },
          { id: 'studio/zly', label: 'Zły', extensions: ['.x'], import: async () => { throw new Error('zepsuty'); } },
        ],
      })],
    });
    expect(listFormats().map((f) => [f.id, f.canImport, f.canExport, f.plugin])).toEqual([
      ['ass', true, true, '@koko-anime/formats'],
      ['studio/scenariusz', false, true, 'studio'],
      ['studio/zly', true, false, 'studio'],
    ]);
    expect(((await ass().export('studio/scenariusz')) as string).split('\n')[1]).toBe('Idę do pałacu.');
    expect(((await KokoAss.import('srt', 'x')) as KokoErrors)[0]!.code).toBe('KF012');
    expect(((await KokoAss.import('studio/zly', 'x')) as KokoErrors).map((d) => [d.code, d.params.plugin])).toEqual([['KF004', 'studio']]);
  });
});

describe('B9 — cache syntezy', () => {
  test('drugi rebuild z tym samym cache nie wywołuje synth', async () => {
    const store = new Map<string, SynthResult>();
    const cache = definePlugin({ name: 'cache', api: '0.4', synthCache: { get: async (k) => store.get(k), set: async (k, v) => void store.set(k, v) } });
    defineConfig({ plugins: [nobleCrypto(), mockG2p(), mockSynth(), ffmpegEncoder(), cache] });
    ok(await KokoPack.create({ subtitles: ass() }).rebuild());
    expect(store.size).toBeGreaterThan(0);
    expect([...store.keys()].every((k) => /^sha256:[0-9a-f]{64}@\d/.test(k))).toBe(true);
    synthCalls.length = 0;
    ok(await KokoPack.create({ subtitles: ass() }).rebuild());
    expect(synthCalls.length).toBe(0);
    ok(await KokoPack.create({ subtitles: ass() }).rebuild(undefined, { cache: false }));
    expect(synthCalls.length).toBeGreaterThan(0);
  });

  test('błąd cache nie przerywa przebudowy', async () => {
    const cache = definePlugin({ name: 'cache', api: '0.4', synthCache: { get: async () => { throw new Error('dysk'); }, set: async () => { throw new Error('dysk'); } } });
    defineConfig({ plugins: [nobleCrypto(), mockG2p(), mockSynth(), ffmpegEncoder(), cache] });
    expect(await KokoPack.create({ subtitles: ass() }).rebuild()).toBeUndefined();
  });
});

describe('C11 — signer', () => {
  test('podpis bez klucza prywatnego w bibliotece', async () => {
    const priv = randomPrivateKey();
    const noble = nobleCrypto();
    const pub = await noble.crypto.ed25519PublicKey!(priv);
    const signer = definePlugin({
      name: 'keychain', api: '0.4',
      signer: { keys: async () => [{ keyId: 'seba9989', registry: 'koko', publicKey: pub }], sign: async (_id, msg) => noble.crypto.ed25519Sign(msg, priv) },
    });
    defineConfig({ plugins: [noble, mockG2p(), mockSynth(), ffmpegEncoder(), signer] });
    const p = KokoPack.create({ subtitles: ass() });
    ok(await p.rebuild());
    const blob = ok(await p.toBlob({ sign: { keyId: 'seba9989', registry: 'koko' } }));
    const q = ok(await KokoPack.open(blob));
    expect(q.signatures.length).toBe(1);
    expect(codes((await q.verifySignatures()).signatures[0]!.diagnostics)).not.toContain('KP013');
    const r = await p.toBlob({ sign: { keyId: 'nieznany' } });
    expect((r as KokoErrors).map((d) => [d.code, d.params.capability])).toEqual([['KF002', 'signer']]);
  });
});
