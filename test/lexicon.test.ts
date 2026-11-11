import { describe, expect, test } from 'bun:test';
import { KokoLexicon, KokoErrors } from '../src/lexicon/index.ts';

const SRC = `format = "koko-lexicon"   # wymagane
version = 1
title = "Kusuriya no Hitorigoto"

[entries.Gyokuyou]
respell = "Giokujo"
stem = true
forms = { Gyokuyouji = "Giokujoji" }

[entries.Jinshi]
ipa = "dʑinɕi"
stem = true
forms = { Jinshiego = "dʑinˈɕiɛɡɔ", Jinshiemu = "dʑinˈɕiɛmu" }
aliases = ["Jinshi-sama"]
note = "eunuch nadzorujący pałac wewnętrzny"
verified = true

[entries."Konkubina Jin"]
respell = "konkubina Dżin"
forms = { "Konkubiny Jin" = "konkubiny Dżin" }
`;

// Przykład z Koko-Lexicon §3 (jeden wpis = jedna linia).
const EXPECTED_FLAT = `; @koko-lexicon-begin
Gyokuyou = { respell = "Giokujo", stem = true, forms = { Gyokuyouji = "Giokujoji" } }
Jinshi = { ipa = "dʑinɕi", stem = true, forms = { Jinshiego = "dʑinˈɕiɛɡɔ", Jinshiemu = "dʑinˈɕiɛmu" }, aliases = ["Jinshi-sama"], note = "eunuch nadzorujący pałac wewnętrzny", verified = true }
Konkubina Jin = { respell = "konkubina Dżin", forms = { "Konkubiny Jin" = "konkubiny Dżin" } }
; @koko-lexicon-end`;

describe('Koko-Lexicon', () => {
  test('spłaszczenie — przykład z LEX §3', () => {
    const lx = KokoLexicon.parse(SRC);
    expect(lx).toBeInstanceOf(KokoLexicon);
    expect((lx as KokoLexicon).flatten()).toBe(EXPECTED_FLAT);
  });

  test('wpisy przegrywające z odcinkiem są pomijane', () => {
    const lx = KokoLexicon.parse(SRC) as KokoLexicon;
    expect(lx.flatten({ episodeKeys: ['Jinshi', 'Gyokuyou*'] })).toBe(
      '; @koko-lexicon-begin\nKonkubina Jin = { respell = "konkubina Dżin", forms = { "Konkubiny Jin" = "konkubiny Dżin" } }\n; @koko-lexicon-end',
    );
  });

  test('round-trip kanoniczny', () => {
    const lx = KokoLexicon.parse(SRC) as KokoLexicon;
    const out = lx.toString();
    const again = KokoLexicon.parse(out) as KokoLexicon;
    expect(again.toString()).toBe(out);
    expect(again.flatten()).toBe(EXPECTED_FLAT);
  });

  test('KL001 i KL002 → KokoErrors', () => {
    expect(KokoLexicon.parse('format = ')).toBeInstanceOf(KokoErrors);
    const r = KokoLexicon.parse('format = "koko-lexicon"\nversion = 2\n[entries]\n');
    expect(r).toBeInstanceOf(KokoErrors);
    expect((r as KokoErrors)[0]!.code).toBe('KL002');
  });

  test('KL004, KL005, KL006', () => {
    const lx = KokoLexicon.parse(`format = "koko-lexicon"
version = 1
[entries.A]
ipa = "a"
respell = "a"
[entries.B]
ipa = "b"
aliases = ["c"]
verified = true
[entries.C]
ipa = "c"
verified = true
`) as KokoLexicon;
    const codes = lx.diagnostics.map((d) => d.code).sort();
    expect(codes).toEqual(['KL004', 'KL005']);
  });

  test('edycja i zdarzenia', () => {
    const lx = KokoLexicon.parse(SRC) as KokoLexicon;
    const changes: string[] = [];
    lx.onChange((c) => changes.push(c.path.join('/')));
    const e = lx.entries.add('Lakan', { respell: 'Lakan', stem: true, note: 'strateg' });
    expect(e).not.toBeInstanceOf(KokoErrors);
    expect(lx.entries.add('jinshi-SAMA', { ipa: 'x' })).toBeInstanceOf(KokoErrors);
    lx.entries.get('Jinshiego')!.forms.set('Jinshim', 'dʑinˈɕim');
    expect(changes.length).toBe(2);
    expect(lx.toString()).toContain('[entries.Lakan]');
    expect(lx.entries.get('jinshi-sama')!.key).toBe('Jinshi');
  });
});
