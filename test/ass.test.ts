import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { KokoAss, KokoErrors, formatAssTime } from '../src/ass/index.ts';
import { KokoLexicon } from '../src/lexicon/index.ts';

const SRC = readFileSync(new URL('./fixtures/spec-example.ass', import.meta.url), 'utf8');
const load = (s = SRC) => {
  const d = KokoAss.parse(s);
  if (d instanceof KokoErrors) throw new Error(d.summary);
  return d;
};

describe('Koko-ASS §7 — przykład kompletny', () => {
  test('oczekiwane wypowiedzi', () => {
    const doc = load();
    const rows = doc.utterances.map((u) => `${formatAssTime(u.start)}–${formatAssTime(u.end)} ${u.params.mode ?? ''} ${u.text}`.replace(/\s+/g, ' '));
    expect(rows).toEqual([
      '0:00:05.00–0:00:07.50 Odcinek pierwszy: Zielarka',
      '0:00:08.00–0:00:10.00 Idę do pałacu.',
      '0:00:13.00–0:00:15.50 Pani Giokujo, przyszedł pan /dʑinɕi/.',
      '0:00:16.00–0:00:20.00 thought Czasami zapominam, że to wewnętrzny pałac.',
      '0:00:21.00–0:00:23.00 Zbierają grzyby i się trują.',
      '0:00:24.00–0:00:26.50 Trujące? [150ms] Wszystkie co do jednego.',
      '0:00:27.00–0:00:29.00 To /ɔɲi/, nie ludzie.',
    ]);
  });

  test('0 diagnostyk', () => {
    expect(load().diagnostics.map((d) => `${d.code} ${JSON.stringify(d.params)}`)).toEqual([]);
  });

  test('powody pominięcia', () => {
    const doc = load();
    const reasons = doc.events.toArray().map((e) => e.analysis.skipReason ?? 'read');
    expect(reasons).toEqual(['comment', 'skipStyle', 'read', 'read', 'read', 'read', 'read', 'read', 'read', 'read', 'noActor']);
  });

  test('segmenty kanoniczne — przykład z PACK §6.2', () => {
    const u = load().utterances.at(-1)!;
    expect(u.segments).toEqual([{ t: 'text', s: 'To' }, { t: 'ipa', s: 'ɔɲi' }, { t: 'text', s: ', nie ludzie.', g: true }]);
    expect(u.key({ model: 'm', g2p: 'g' })).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  test('parametry: gain stylu, prędkość i głos', () => {
    const u = load().utterances[3]!;
    expect(u.params).toMatchObject({ gain: -1, speed: 1, maxSpeed: 1.3, voice: 'pl_lektor_1', mode: 'thought' });
  });

  test('zapis kanoniczny jest stabilny i zachowuje treść', () => {
    const doc = load();
    const out = doc.toString();
    const again = load(out);
    expect(again.toString()).toBe(out);
    expect(again.utterances.map((u) => u.text)).toEqual(doc.utterances.map((u) => u.text));
    expect(out.startsWith('[Script Info]\nScriptType: v4.00+')).toBe(true);
  });
});

describe('edycja', () => {
  test('line.kk i zdarzenia onChange', () => {
    const doc = load();
    const changes: string[] = [];
    doc.onChange((c) => changes.push(c.path.join('/')));
    const line = doc.events.dialogues[2]!; // Idę do pałacu.
    line.kk.say = 'Idę do Jadeitowego Pałacu.';
    expect(line.text).toBe('{!kk say="Idę do Jadeitowego Pałacu."}Idę do pałacu.');
    expect(line.analysis.spokenText).toBe('Idę do Jadeitowego Pałacu.');
    expect(doc.diagnostics.some((d) => d.code === 'KK102' && d.params.word === 'Jadeitowego')).toBe(true);
    line.kk.toggle('skip', true);
    expect(line.text).toBe('{!kk say="Idę do Jadeitowego Pałacu." skip}Idę do pałacu.');
    expect(line.analysis.skipReason).toBe('annotation');
    line.kk.say = undefined;
    line.kk.toggle('skip', false);
    expect(line.text).toBe('Idę do pałacu.');
    expect(changes.length).toBe(4);
  });

  test('zakresy i pauzy', () => {
    const doc = load();
    const line = doc.events.dialogues[2]!;
    const r = line.kk.addRange(7, 13, { sub: 'pałacu' });
    expect(r).not.toBeInstanceOf(KokoErrors);
    expect(line.text).toBe('Idę do {!kk sub=pałacu}pałacu{!kk /}.');
    expect(line.kk.addRange(8, 10, { ipa: 'x' })).toBeInstanceOf(KokoErrors);
    line.kk.insertPause(3, 300);
    expect(line.analysis.spokenText).toBe('Idę [300ms] do pałacu.');
    line.kk.removeRange(line.kk.ranges[0]!.id);
    line.kk.removePause(line.kk.pauses[0]!.id);
    expect(line.text).toBe('Idę do pałacu.');
  });

  test('batch daje jedno zdarzenie', () => {
    const doc = load();
    const changes: string[] = [];
    doc.onChange((c) => changes.push(`${c.kind}:${c.batch}`));
    doc.events.shift(200);
    expect(changes).toEqual(['replace:shift']);
    expect(doc.events.dialogues[0]!.start).toBe(1200);
  });

  test('ustawienia', () => {
    const doc = load();
    expect(doc.koko.rules.get('MaxSpeed')).toBe(1.3);
    doc.koko.rules.set('Numbers', 'auto');
    doc.events.dialogues[2]!.text = 'Mam 3 koty o 15:30.';
    expect(doc.events.dialogues[2]!.analysis.spokenText).toBe('Mam trzy koty o piętnastej trzydzieści.');
    expect(doc.toString()).toContain('Numbers = auto');
  });

  test('KK002 odrzuca nowszą wersję', () => {
    const r = KokoAss.parse('[Script Info]\nKokoAnime Version: 2\n');
    expect(r).toBeInstanceOf(KokoErrors);
    expect((r as KokoErrors)[0]!.code).toBe('KK002');
  });
});

describe('leksykon serii', () => {
  const LEX = `format = "koko-lexicon"
version = 1
[entries.Jinshi]
ipa = "dʑinɕi"
stem = true
[entries."Konkubina Jin"]
respell = "konkubina Dżin"
forms = { "Konkubiny Jin" = "konkubiny Dżin" }
[entries.Lakan]
respell = "Lakan"
stem = true
`;

  test('pierwszeństwo odcinka i spłaszczanie (§7 + LEX §3)', () => {
    const doc = load();
    doc.seriesLexicon = KokoLexicon.parse(LEX) as KokoLexicon;
    doc.events.dialogues[2]!.text = 'Konkubiny  Jin i Lakanowi.';
    expect(doc.events.dialogues[2]!.analysis.spokenText).toBe('konkubiny Dżin i Lakanowi.');
    expect(doc.utterances[1]!.segments).toEqual([{ t: 'text', s: 'konkubiny Dżin i Lakanowi.' }]);
    expect(doc.flattenSeriesLexicon()).toBe(true);
    const out = doc.toString();
    expect(out).toContain('[Koko Lexicon]\nJinshi = dʑinɕi\nGyokuyou* = ~Giokujo\n; @koko-lexicon-begin\nKonkubina Jin = ~konkubina Dżin\nKonkubiny Jin = ~konkubiny Dżin\nLakan* = ~Lakan\n; @koko-lexicon-end');
    expect(out).toContain('SeriesLexicon = none');
    const again = load(out);
    expect(again.koko.lexicon.toArray().filter((i) => i.flattened).length).toBe(5);
    expect(again.unflattenSeriesLexicon()).toBe(true);
    expect(again.toString()).not.toContain('@koko-lexicon');
  });
});
