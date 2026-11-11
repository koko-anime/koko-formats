import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { KokoAss, KokoErrors } from '../src/ass/index.ts';

const SRC = readFileSync(new URL('./fixtures/spec-example.ass', import.meta.url), 'utf8');
// Przykład z Koko-ASS §2 (forma pełna obok prostej).
const LEX = `[Koko Lexicon]
Gyokuyou* = ~Giokujo
Jinshi = { ipa = "dʑinɕi", stem = true, forms = { Jinshiego = "dʑinˈɕiɛɡɔ", Jinshiemu = "dʑinˈɕiɛmu" }, aliases = ["Jinshii"], note = "eunuch", verified = true }
Konkubina Jin = { respell = "konkubina Dżin", forms = { "Konkubiny Jin" = "konkubiny Dżin" } }
`;
const withLex = (lex: string, text?: string) => {
  let s = SRC.replace(/\[Koko Lexicon\][\s\S]*?\n\n/, `${lex}\n`);
  if (text) s = s.replace('Idę do pałacu.', text);
  const d = KokoAss.parse(s);
  if (d instanceof KokoErrors) throw new Error(d.summary);
  return d;
};
const codes = (d: KokoAss) => d.diagnostics.map((x) => x.code);

describe('[Koko Lexicon] — forma pełna (Koko-ASS §2)', () => {
  test('przykład ze specyfikacji: 0 diagnostyk, zapis kanoniczny bez zmian', () => {
    const doc = withLex(LEX);
    expect(codes(doc)).toEqual([]);
    const jin = doc.koko.lexicon.toArray().find((i) => i.key === 'Jinshi')!;
    expect(jin.form).toBe('full');
    expect(jin.stem).toBe(true);
    expect(jin.aliases).toEqual(['Jinshii']);
    expect(jin.toEntry()).toEqual({ ipa: 'dʑinɕi', stem: true, aliases: ['Jinshii'], forms: { Jinshiego: 'dʑinˈɕiɛɡɔ', Jinshiemu: 'dʑinˈɕiɛmu' }, note: 'eunuch', verified: true });
    const out = doc.toString();
    expect(out).toContain(LEX.trimEnd());
    expect((KokoAss.parse(out) as KokoAss).toString()).toBe(out);
  });

  test('dopasowanie: forma wygrywa z rdzeniem, alias, fraza z formą', () => {
    const doc = withLex(LEX, 'Bez Jinshiego, Jinshii i Konkubiny  Jin.');
    expect(doc.events.dialogues[2]!.analysis.spokenText).toBe('Bez /dʑinˈɕiɛɡɔ/, /dʑinɕi/ i konkubiny Dżin.');
  });

  test('KL001 z pozycją pomija tylko ten wpis; klucz z * → KL004; nieznane pole → KL003', () => {
    const doc = withLex(`[Koko Lexicon]
Zły = { ipa = "a",
Jinshi* = { ipa = "dʑinɕi" }
Lakan = { respell = "Lakan", kolor = "x" }
Maomao = ~Maomao
`);
    const d = doc.diagnostics;
    const kl001 = d.find((x) => x.code === 'KL001')!;
    expect(kl001.source).toBe('lexicon');
    expect(kl001.position?.line).toBeGreaterThan(1);
    expect(kl001.position!.column).toBeGreaterThan(6);
    expect(d.filter((x) => x.code === 'KL004').map((x) => x.params.reason)).toEqual(['star-in-full-form']);
    expect(d.find((x) => x.code === 'KL003')!.params.field).toBe('kolor');
    expect(doc.koko.lexicon.toArray().map((i) => i.key)).toEqual(['Lakan', 'Maomao']);
  });

  test('KK010: słowo w kilku wpisach — obowiązuje ostatnie wystąpienie', () => {
    const doc = withLex(`[Koko Lexicon]
Jinshi = { ipa = "dʑinɕi", aliases = ["Pan Jinshi"] }
Pan Jinshi = ~pan Dżinszi
`, 'Pan Jinshi idzie.');
    expect(codes(doc)).toContain('KK010');
    expect(doc.events.dialogues[2]!.analysis.spokenText).toBe('pan Dżinszi idzie.');
  });

  test('edycja: alias przepisuje wpis prosty na pełny; pełny nie wraca do prostego', () => {
    const doc = withLex('[Koko Lexicon]\nMaomao* = ~Maomao\n');
    const it = doc.koko.lexicon.toArray()[0]!;
    expect(it.form).toBe('simple');
    expect(it.setEntry({ respell: 'Maomao', stem: true, aliases: ['Mao'] })).toBeUndefined();
    expect(doc.toString()).toContain('Maomao = { respell = "Maomao", stem = true, aliases = ["Mao"] }');
    it.setEntry({ respell: 'Maomao' });
    expect(it.form).toBe('full');
    expect(doc.toString()).toContain('Maomao = { respell = "Maomao" }');
    expect(it.setEntry({ respell: '~zle' })).toBeInstanceOf(KokoErrors);
    const added = doc.koko.lexicon.add('Lakan', { respell: 'Lakan', note: 'strateg' });
    expect(added).not.toBeInstanceOf(KokoErrors);
    expect(doc.toString()).toContain('Lakan = { respell = "Lakan", note = "strateg" }');
  });

  test('escapowanie w tabeli: znaki kontrolne \\uXXXX wielkimi literami', () => {
    const doc = withLex('[Koko Lexicon]\nX = { ipa = "a", note = "linia\\u0001\\"cytat\\"" }\n');
    expect(doc.toString()).toContain('X = { ipa = "a", note = "linia\\u0001\\"cytat\\"" }');
  });
});
