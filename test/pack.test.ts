import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { defineConfig, resetConfig } from '../src/config/index.ts';
import { definePlugin } from '../src/plugin/index.ts';
import { KokoAss } from '../src/ass/index.ts';
import { KokoPack, KokoErrors, MIMETYPE } from '../src/pack/index.ts';
import { nobleCrypto, randomPrivateKey } from '../src/crypto-noble/index.ts';
import { writeZip, readZip } from '../src/pack/zip.ts';
import { encodeCalls, ffmpegEncoder, mockG2p, mockSynth, synthCalls } from './helpers/plugins.ts';

const SRC = readFileSync(new URL('./fixtures/spec-example.ass', import.meta.url), 'utf8');
const ass = () => KokoAss.parse(SRC) as KokoAss;
const ok = <T>(x: T | KokoErrors): T => {
  if (x instanceof KokoErrors) throw new Error(`${x.summary} ${JSON.stringify(x.all.map((d) => [d.code, d.params]))}`);
  return x;
};

beforeEach(() => {
  resetConfig();
  defineConfig({ plugins: [nobleCrypto(), mockG2p(), mockSynth(), ffmpegEncoder()], generator: { name: 'Koko-Editor', version: '0.4.0' } });
});
afterEach(() => resetConfig());

async function built(): Promise<KokoPack> {
  const p = KokoPack.create({ subtitles: ass(), title: 'Przykład' });
  ok(await p.rebuild());
  return p;
}

describe('Koko-Pack — cykl pracy', () => {
  test('create → rebuild → toBlob → open', async () => {
    const p = await built();
    expect(p.stale).toBe(false);
    expect(p.timeline.clips.length).toBe(7);
    expect(p.audio!.spliceable).toBe(true);
    expect(p.audio!.params.encoderDelay).toBe(1105);
    const blob = ok(await p.toBlob());
    const head = new Uint8Array(await blob.slice(0, 80).arrayBuffer());
    expect(new TextDecoder().decode(head.subarray(30, 38))).toBe('mimetype');
    expect(new TextDecoder().decode(head.subarray(38, 38 + MIMETYPE.length))).toBe(MIMETYPE);
    const q = ok(await KokoPack.open(blob));
    expect(q.diagnostics.filter((d) => d.source === 'pack').map((d) => d.code)).toEqual([]);
    expect(q.stale).toBe(false);
    expect(q.manifest.synthesis?.model).toBe('mock-model');
    expect(q.manifest.generator.name).toBe('Koko-Editor');
    expect(q.timeline.utterances[3]!.lines!.length).toBe(2); // join
    // niezmieniona paczka zapisuje się bajt w bajt
    expect(ok(await q.toBlob())).toBe(blob);
  });

  test('edycja → plan → podmiana ramek', async () => {
    const q = ok(await KokoPack.open(ok(await (await built()).toBlob())));
    const line = q.subtitles.events.dialogues[2]!;
    line.kk.say = 'Idę do Jadeitowego Pałacu.';
    expect(q.stale).toBe(true);
    expect(await q.toBlob()).toBeInstanceOf(KokoErrors);
    const plan = ok(await q.reconcile());
    expect(plan.counts.new).toBe(1);
    expect(plan.counts.orphaned).toBe(1);
    expect(plan.diagnostics.map((d) => d.code)).toContain('KP101');
    const before = new Uint8Array(await q.audio!.blob.arrayBuffer());
    synthCalls.length = 0;
    encodeCalls.length = 0;
    ok(await q.rebuild(plan));
    expect(encodeCalls.length).toBeGreaterThan(0);
    expect(encodeCalls.every((c) => c.raw)).toBe(true); // tylko okna, bez pełnego kodowania
    expect(encodeCalls.reduce((s, c) => s + c.samples, 0)).toBeLessThan(24000 * 10);
    expect(synthCalls.map((c) => c.text)).toContain('Idę do Jadeitowego Pałacu.');
    expect(synthCalls.some((c) => c.text.startsWith('Pani'))).toBe(false);
    const after = new Uint8Array(await q.audio!.blob.arrayBuffer());
    expect(after.length).toBe(before.length); // podmiana ramek w miejscu
    expect(after).not.toEqual(before);
    expect(after.subarray(192, 2000)).toEqual(before.subarray(192, 2000)); // za ramką Info (CRC LAME się zmienia)
    expect(q.audio!.spliceable).toBe(true);
    const r = ok(await KokoPack.open(ok(await q.toBlob())));
    expect(r.diagnostics.filter((d) => d.source === 'pack').map((d) => d.code)).toEqual([]);
  });

  test('zmiana głośności → KP106, przesunięcie → KP102', async () => {
    const q = ok(await KokoPack.open(ok(await (await built()).toBlob())));
    q.subtitles.events.dialogues[3]!.kk.gain = 3;
    const plan = ok(await q.reconcile());
    expect(plan.counts.gain).toBe(1);
    expect(plan.diagnostics.map((d) => d.code)).toContain('KP106');
    q.subtitles.events.dialogues[7]!.start += 300;
    q.subtitles.events.dialogues[7]!.end += 300;
    const plan2 = ok(await q.reconcile());
    expect(plan2.counts.moved).toBe(1);
  });

  test('profil distribution i tryb play', async () => {
    const p = await built();
    p.setCache('peaks.json', new Blob(['[]']));
    const blob = ok(await p.toBlob({ profile: 'distribution' }));
    const z = await readZip(blob);
    expect(z.entries.some((e) => e.name.startsWith('cache/'))).toBe(false);
    const q = ok(await KokoPack.open(blob, { mode: 'play' }));
    expect(q.profile).toBe('distribution');
    expect(q.timeline.clips.length).toBe(7);
    expect(q.timeline.utterances.length).toBe(0);
    expect(q.timeline.valid).toBe(true);
    const e = ok(await KokoPack.open(blob));
    expect(e.diagnostics.map((d) => d.code)).toContain('KP105');
    expect((ok(await e.reconcile())).counts.new).toBe(7);
  });

  test('Opus — kodowanie całości', async () => {
    const p = KokoPack.create({ subtitles: ass() });
    ok(await p.rebuild(undefined, { codec: 'opus' }));
    expect(p.audio!.params.codec).toBe('opus');
    expect(p.audio!.params.sampleRate).toBe(48000);
    expect(p.audio!.spliceable).toBe(false);
    const q = ok(await KokoPack.open(ok(await p.toBlob())));
    expect(q.diagnostics.filter((d) => d.source === 'pack').map((d) => d.code)).toEqual([]);
  });
});

describe('Koko-Pack — podpisy', () => {
  test('podpis bez rejestru → KP014, z rejestrem → zweryfikowany, podmiana → KP013', async () => {
    const key = randomPrivateKey();
    const p = await built();
    const blob = ok(await p.toBlob({ sign: { keyId: 'seba9989', registry: 'koko', privateKey: key } }));
    const pub = (await nobleCrypto().crypto.ed25519PublicKey!(key));
    const pubB64 = btoa(String.fromCharCode(...pub));
    // brak rejestru w konfiguracji → nieosiągalny
    let q = ok(await KokoPack.open(blob));
    expect((await q.verifySignatures()).status).toBe('unverified');
    // rejestr
    defineConfig({
      registry: { url: 'https://registry.example' },
      plugins: [definePlugin({ name: 'fake-fetch', fetch: async (url) => {
        if (url.endsWith('/v1/creators/seba9989')) return new Response(JSON.stringify({ creator: 'seba9989', keys: [{ publicKey: pubB64, revoked: null }] }));
        return new Response('', { status: 404 });
      } })],
    });
    q = ok(await KokoPack.open(blob));
    const rep = await q.verifySignatures();
    expect(rep.status).toBe('verified');
    // bez registry → KP014
    const b2 = ok(await p.toBlob({ sign: { keyId: 'ktoś', privateKey: key } }));
    expect((await (ok(await KokoPack.open(b2))).verifySignatures()).diagnostics.map((d) => d.code)).toEqual(['KP014']);
    // zmiana manifestu po podpisaniu → podpis niepoprawny
    const z = await readZip(blob);
    const files = await Promise.all(z.entries.map(async (e) => ({ name: e.name, data: new Uint8Array(await blob.slice(e.dataOffset, e.dataOffset + e.compressedSize).arrayBuffer()), method: e.method })));
    const { inflateSync } = await import('fflate');
    const man = JSON.parse(new TextDecoder().decode(inflateSync(files.find((f) => f.name === 'manifest.json')!.data)));
    man.title = 'Podmieniony';
    const tampered = await writeZip(files.map((f) => f.name === 'manifest.json'
      ? { name: f.name, data: new TextEncoder().encode(JSON.stringify(man)), method: 'deflate' as const }
      : { name: f.name, data: f.method === 8 ? inflateSync(f.data) : f.data, method: f.method === 8 ? 'deflate' as const : 'store' as const }));
    const t = ok(await KokoPack.open(tampered));
    expect(t.diagnostics.map((d) => d.code)).toContain('KP013');
  });
});

describe('Koko-Pack — błędy pluginów', () => {
  test('KF004 wskazuje plugin, który zgłosił błąd', async () => {
    const broken = definePlugin({ name: 'broken-encoder', encoder: { mp3: async () => { throw new Error('boom'); } } });
    defineConfig({ plugins: [nobleCrypto(), mockG2p(), mockSynth(), broken] });
    const r = await KokoPack.create({ subtitles: ass() }).rebuild();
    expect(r).toBeInstanceOf(KokoErrors);
    expect((r as KokoErrors).all.map((d) => [d.code, d.params.plugin])).toEqual([['KF004', 'broken-encoder']]);
  });
});

describe('Koko-Pack — odrzucenia', () => {
  const zipWith = (files: { name: string; data: string | Uint8Array }[]) =>
    writeZip(files.map((f) => ({ name: f.name, data: typeof f.data === 'string' ? new TextEncoder().encode(f.data) : f.data, method: 'store' as const })));

  test('KP001: zły mimetype', async () => {
    const r = await KokoPack.open(await zipWith([{ name: 'mimetype', data: 'application/zip' }]));
    expect((r as KokoErrors)[0]!.code).toBe('KP001');
  });

  test('KP007: zip slip i nieznany plik', async () => {
    const r = await KokoPack.open(await zipWith([{ name: 'mimetype', data: MIMETYPE }, { name: '../evil', data: 'x' }]));
    expect((r as KokoErrors)[0]!.code).toBe('KP007');
    const r2 = await KokoPack.open(await zipWith([{ name: 'mimetype', data: MIMETYPE }, { name: 'readme.txt', data: 'x' }]));
    expect((r2 as KokoErrors)[0]!.code).toBe('KP007');
  });

  test('KP002 i KP003', async () => {
    const r = await KokoPack.open(await zipWith([{ name: 'mimetype', data: MIMETYPE }, { name: 'manifest.json', data: '{' }]));
    expect((r as KokoErrors)[0]!.code).toBe('KP002');
    const r2 = await KokoPack.open(await zipWith([{ name: 'mimetype', data: MIMETYPE }, { name: 'manifest.json', data: '{"format":"koko-pack","version":2}' }]));
    expect((r2 as KokoErrors)[0]!.code).toBe('KP003');
  });

  test('KP005: napisy zmienione poza edytorem', async () => {
    const blob = ok(await (await built()).toBlob());
    const z = await readZip(blob);
    const { inflateSync } = await import('fflate');
    const files = await Promise.all(z.entries.map(async (e) => {
      let data = new Uint8Array(await blob.slice(e.dataOffset, e.dataOffset + e.compressedSize).arrayBuffer());
      if (e.method === 8) data = inflateSync(data);
      if (e.name === 'subtitles.ass') data = new TextEncoder().encode(new TextDecoder().decode(data).replace('Idę do pałacu.', 'Idę do ogrodu.'));
      return { name: e.name, data, method: e.method === 8 ? 'deflate' as const : 'store' as const };
    }));
    const q = ok(await KokoPack.open(await writeZip(files)));
    expect(q.diagnostics.map((d) => d.code)).toContain('KP005');
    expect(q.stale).toBe(true);
    const plan = ok(await q.reconcile());
    expect(plan.counts.new).toBe(1);
  });
});
