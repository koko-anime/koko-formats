/**
 * Klucze `[Koko Lektor]` i `[Koko Rules]` (Koko-ASS §2): nazwy kanoniczne, wartości domyślne, walidacja.
 */
import { compileSkipRegex, foldCase, parseBool } from '../core/text.ts';

/** Klucze `[Koko Lektor]` z typami wartości efektywnych (Koko-ASS §2). */
export interface LektorKeys {
  /** Voice pack Kokoro (domyślnie z ustawień aplikacji). */
  Voice: string | undefined;
  /** Bazowa prędkość 0.5–2.0 (domyślnie 1.0). */
  Speed: number;
  /** Głośność lektora w dB (domyślnie 0). */
  Gain: number;
  /** Ściszenie oryginału w czasie wypowiedzi, dB ≤ 0 (domyślnie −12). */
  Duck: number;
  /** Zejście do `Duck` w ms (domyślnie 150). */
  DuckAttack: number;
  /** Powrót po wypowiedzi w ms (domyślnie 400). */
  DuckRelease: number;
  /** Przesunięcie startu każdej wypowiedzi w ms (domyślnie 0). */
  Offset: number;
  /** Minimalna cisza między wypowiedziami w ms (domyślnie 80). */
  MinGap: number;
}

/** Klucze `[Koko Rules]` z typami wartości efektywnych (Koko-ASS §2). */
export interface RulesKeys {
  /** Czytaj tylko pasujące style (brak = wszystkie). */
  ReadStyles: string[] | undefined;
  /** Pomijaj pasujące style. */
  SkipStyles: string[];
  /** Pomijaj linie z niepustym `Effect` (domyślnie tak). */
  SkipIfEffect: boolean;
  /** Pomijaj linie z pustym `Name` (domyślnie nie). */
  SkipIfNoActor: boolean;
  /** Pomijaj, gdy tekst wyświetlany pasuje (podzbiór regex). */
  SkipIfMatch: string | undefined;
  /** Rozwijanie liczb (domyślnie `no`). */
  Numbers: 'no' | 'auto';
  /** Wyrazy bez KK102 (wzorce, bez rozróżniania wielkości liter). */
  IgnoreNames: string[];
  /** Plik leksykonu serii albo `none` (domyślnie `koko-lexicon.toml`). */
  SeriesLexicon: string;
  /** Tryb łączenia (domyślnie `no`). */
  Join: 'no' | 'auto';
  /** Maksymalna przerwa przy `Join = auto` w ms (domyślnie 50). */
  JoinMaxGap: number;
  /** Maksymalne przyspieszenie 1–3 (domyślnie 1). */
  MaxSpeed: number;
  /** Można zająć ciszę do następnej wypowiedzi (domyślnie tak). */
  BorrowGap: boolean;
  /** Maksymalne opóźnienie następnej wypowiedzi w ms (domyślnie 700). */
  MaxDelay: number;
}

type Parser<T> = (raw: string) => T | undefined;

const num = (min = -Infinity, max = Infinity): Parser<number> => (raw) => {
  const s = raw.trim();
  if (!/^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(s)) return undefined;
  const n = Number(s);
  return Number.isFinite(n) && n >= min && n <= max ? n : undefined;
};
const bool: Parser<boolean> = (raw) => parseBool(raw);
const list: Parser<string[]> = (raw) => raw.split(',').map((x) => x.trim()).filter((x) => x.length > 0);
const str: Parser<string> = (raw) => (raw.trim().length ? raw.trim() : undefined);
const enumOf = <T extends string>(...vals: T[]): Parser<T> => (raw) => {
  const f = foldCase(raw.trim());
  return vals.find((v) => v === f);
};

/** @internal */
export interface KeySpec<T> {
  name: string;
  parse: Parser<T>;
  default: T;
  format: (v: T) => string;
}

const fmtNum = (n: number) => String(n);
const fmtBool = (b: boolean) => (b ? 'yes' : 'no');
const fmtList = (l: string[] | undefined) => (l ?? []).join(', ');

/** @internal */
export const LEKTOR_KEYS: { [K in keyof LektorKeys]: KeySpec<LektorKeys[K]> } = {
  Voice: { name: 'Voice', parse: str as Parser<string | undefined>, default: undefined, format: (v) => v ?? '' },
  Speed: { name: 'Speed', parse: num(0.5, 2), default: 1, format: fmtNum },
  Gain: { name: 'Gain', parse: num(), default: 0, format: fmtNum },
  Duck: { name: 'Duck', parse: num(-Infinity, 0), default: -12, format: fmtNum },
  DuckAttack: { name: 'DuckAttack', parse: num(0), default: 150, format: fmtNum },
  DuckRelease: { name: 'DuckRelease', parse: num(0), default: 400, format: fmtNum },
  Offset: { name: 'Offset', parse: num(), default: 0, format: fmtNum },
  MinGap: { name: 'MinGap', parse: num(0), default: 80, format: fmtNum },
};

/** @internal */
export const RULES_KEYS: { [K in keyof RulesKeys]: KeySpec<RulesKeys[K]> } = {
  ReadStyles: { name: 'ReadStyles', parse: ((raw: string) => { const l = list(raw); return l && l.length ? l : undefined; }) as Parser<string[] | undefined>, default: undefined, format: fmtList },
  SkipStyles: { name: 'SkipStyles', parse: list, default: [], format: fmtList },
  SkipIfEffect: { name: 'SkipIfEffect', parse: bool, default: true, format: fmtBool },
  SkipIfNoActor: { name: 'SkipIfNoActor', parse: bool, default: false, format: fmtBool },
  SkipIfMatch: { name: 'SkipIfMatch', parse: ((raw: string) => (compileSkipRegex(raw.trim()) ? raw.trim() : undefined)) as Parser<string | undefined>, default: undefined, format: (v) => v ?? '' },
  Numbers: { name: 'Numbers', parse: enumOf('no', 'auto'), default: 'no', format: (v) => v },
  IgnoreNames: { name: 'IgnoreNames', parse: list, default: [], format: fmtList },
  SeriesLexicon: { name: 'SeriesLexicon', parse: str, default: 'koko-lexicon.toml', format: (v) => v },
  Join: { name: 'Join', parse: enumOf('no', 'auto'), default: 'no', format: (v) => v },
  JoinMaxGap: { name: 'JoinMaxGap', parse: num(0), default: 50, format: fmtNum },
  MaxSpeed: { name: 'MaxSpeed', parse: num(1, 3), default: 1, format: fmtNum },
  BorrowGap: { name: 'BorrowGap', parse: bool, default: true, format: fmtBool },
  MaxDelay: { name: 'MaxDelay', parse: num(0), default: 700, format: fmtNum },
};

/** @internal */
export function canonicalKeyName<T extends Record<string, KeySpec<unknown>>>(table: T, raw: string): keyof T | undefined {
  const f = foldCase(raw.trim());
  return (Object.keys(table) as (keyof T)[]).find((k) => foldCase(String(k)) === f);
}

/** @internal */
export type SectionName = 'Koko Lektor' | 'Koko Rules' | 'Koko Styles' | 'Koko Lexicon' | 'Koko Sources';
/** @internal */
export const KOKO_SECTIONS: readonly SectionName[] = ['Koko Lektor', 'Koko Rules', 'Koko Styles', 'Koko Lexicon', 'Koko Sources'];
