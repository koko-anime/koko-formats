/**
 * Rozwijanie liczb (Koko-ASS §4.3), wersja reguł 2.
 * Deterministyczne: wynik wchodzi do kluczy wypowiedzi Koko-Pack.
 */
import { foldCase } from '../core/text.ts';

/** Wersja reguł liczb (Koko-ASS §4.3.7) — wchodzi do klucza wypowiedzi przy `Numbers = auto`. */
export const NUMBERS_RULES_VERSION = 2;

/** Przypadki: mianownik, dopełniacz, celownik, biernik, narzędnik, miejscownik. */
export type Case = 'M' | 'D' | 'C' | 'B' | 'N' | 'Ms';

/** Jedno rozpoznanie liczby. */
export interface NumberExpansion {
  /** Indeksy UTF-16 w tekście wejściowym. */
  from: number;
  /** Koniec (wyłącznie). */
  to: number;
  /** Tekst źródłowy. */
  original: string;
  /** Tekst po rozwinięciu (bez zmian dla KK202). */
  replacement: string;
  /** Numer wzorca z tabeli §4.3.2 (1–11). */
  pattern: number;
  /** `KK202` (bez zmian), `KK203` (rozwinięte), `KK204` (rozwinięcie niepewne). */
  code: 'KK202' | 'KK203' | 'KK204';
}

/** Wynik `expandNumbers`. */
export interface ExpandResult {
  /** Tekst z rozwiniętymi liczbami. */
  text: string;
  /** Rozpoznane liczby z kodami diagnostyk. */
  expansions: NumberExpansion[];
}

// ---------------------------------------------------------------- tabele liczebników głównych

type Forms = readonly [M: string, D: string, C: string, N: string, Ms: string];

const ZERO: Forms = ['zero', 'zera', 'zeru', 'zerem', 'zerze'];

const UNITS: Record<number, Forms> = {
  1: ['jeden', 'jednego', 'jednemu', 'jednym', 'jednym'],
  2: ['dwa', 'dwóch', 'dwóm', 'dwoma', 'dwóch'],
  3: ['trzy', 'trzech', 'trzem', 'trzema', 'trzech'],
  4: ['cztery', 'czterech', 'czterem', 'czterema', 'czterech'],
  5: ['pięć', 'pięciu', 'pięciu', 'pięcioma', 'pięciu'],
  6: ['sześć', 'sześciu', 'sześciu', 'sześcioma', 'sześciu'],
  7: ['siedem', 'siedmiu', 'siedmiu', 'siedmioma', 'siedmiu'],
  8: ['osiem', 'ośmiu', 'ośmiu', 'ośmioma', 'ośmiu'],
  9: ['dziewięć', 'dziewięciu', 'dziewięciu', 'dziewięcioma', 'dziewięciu'],
  10: ['dziesięć', 'dziesięciu', 'dziesięciu', 'dziesięcioma', 'dziesięciu'],
};

const TEENS_M = ['jedenaście', 'dwanaście', 'trzynaście', 'czternaście', 'piętnaście', 'szesnaście', 'siedemnaście', 'osiemnaście', 'dziewiętnaście'];
const TEENS_STEM = ['jedenast', 'dwunast', 'trzynast', 'czternast', 'piętnast', 'szesnast', 'siedemnast', 'osiemnast', 'dziewiętnast'];
for (let i = 0; i < 9; i++) {
  const st = TEENS_STEM[i]!;
  UNITS[11 + i] = [TEENS_M[i]!, `${st}u`, `${st}u`, `${st}oma`, `${st}u`];
}

const TENS: Record<number, Forms> = {
  20: ['dwadzieścia', 'dwudziestu', 'dwudziestu', 'dwudziestoma', 'dwudziestu'],
  30: ['trzydzieści', 'trzydziestu', 'trzydziestu', 'trzydziestoma', 'trzydziestu'],
  40: ['czterdzieści', 'czterdziestu', 'czterdziestu', 'czterdziestoma', 'czterdziestu'],
  50: ['pięćdziesiąt', 'pięćdziesięciu', 'pięćdziesięciu', 'pięćdziesięcioma', 'pięćdziesięciu'],
  60: ['sześćdziesiąt', 'sześćdziesięciu', 'sześćdziesięciu', 'sześćdziesięcioma', 'sześćdziesięciu'],
  70: ['siedemdziesiąt', 'siedemdziesięciu', 'siedemdziesięciu', 'siedemdziesięcioma', 'siedemdziesięciu'],
  80: ['osiemdziesiąt', 'osiemdziesięciu', 'osiemdziesięciu', 'osiemdziesięcioma', 'osiemdziesięciu'],
  90: ['dziewięćdziesiąt', 'dziewięćdziesięciu', 'dziewięćdziesięciu', 'dziewięćdziesięcioma', 'dziewięćdziesięciu'],
};

const HUNDREDS: Record<number, Forms> = {
  100: ['sto', 'stu', 'stu', 'stu', 'stu'],
  200: ['dwieście', 'dwustu', 'dwustu', 'dwustoma', 'dwustu'],
  300: ['trzysta', 'trzystu', 'trzystu', 'trzystoma', 'trzystu'],
  400: ['czterysta', 'czterystu', 'czterystu', 'czterystoma', 'czterystu'],
  500: ['pięćset', 'pięciuset', 'pięciuset', 'pięciuset', 'pięciuset'],
  600: ['sześćset', 'sześciuset', 'sześciuset', 'sześciuset', 'sześciuset'],
  700: ['siedemset', 'siedmiuset', 'siedmiuset', 'siedmiuset', 'siedmiuset'],
  800: ['osiemset', 'ośmiuset', 'ośmiuset', 'ośmiuset', 'ośmiuset'],
  900: ['dziewięćset', 'dziewięciuset', 'dziewięciuset', 'dziewięciuset', 'dziewięciuset'],
};

const DIGIT_NAMES = ['zero', 'jeden', 'dwa', 'trzy', 'cztery', 'pięć', 'sześć', 'siedem', 'osiem', 'dziewięć'];

function caseIndex(c: Case): number {
  switch (c) {
    case 'M':
    case 'B':
      return 0;
    case 'D':
      return 1;
    case 'C':
      return 2;
    case 'N':
      return 3;
    case 'Ms':
      return 4;
  }
}

function pick(f: Forms, c: Case): string {
  return f[caseIndex(c)]!;
}

/** Składniki 1–999: setki, dziesiątki, jedności (11–19 jako jeden składnik). */
function components(n: number): number[] {
  const out: number[] = [];
  const h = Math.floor(n / 100) * 100;
  const r = n % 100;
  if (h) out.push(h);
  if (r >= 10 && r <= 19) out.push(r);
  else {
    const t = Math.floor(r / 10) * 10;
    const u = r % 10;
    if (t) out.push(t);
    if (u) out.push(u);
  }
  return out;
}

function componentForms(c: number): Forms {
  return (HUNDREDS[c] ?? TENS[c] ?? UNITS[c])!;
}

/** 1–999 w przypadku; `compound` = liczba ma składniki przed tą grupą. */
function under1000(n: number, c: Case, compound: boolean): string[] {
  const comps = components(n);
  const total = comps.length + (compound ? 1 : 0);
  return comps.map((comp, i) => {
    // „Jeden” jako ostatni składnik liczby złożonej jest nieodmienne.
    if (comp === 1 && i === comps.length - 1 && total > 1) return 'jeden';
    return pick(componentForms(comp), c);
  });
}

type Scale = 'tysiąc' | 'milion';

const SCALE_FORMS: Record<Scale, { m1: string; m24: string; mOther: string; D: [string, string]; C: [string, string]; N: [string, string]; Ms: [string, string] }> = {
  tysiąc: {
    m1: 'tysiąc', m24: 'tysiące', mOther: 'tysięcy',
    D: ['tysiąca', 'tysięcy'], C: ['tysiącowi', 'tysiącom'], N: ['tysiącem', 'tysiącami'], Ms: ['tysiącu', 'tysiącach'],
  },
  milion: {
    m1: 'milion', m24: 'miliony', mOther: 'milionów',
    D: ['miliona', 'milionów'], C: ['milionowi', 'milionom'], N: ['milionem', 'milionami'], Ms: ['milionie', 'milionach'],
  },
};

function is24(m: number): boolean {
  const l1 = m % 10;
  const l2 = m % 100;
  return l1 >= 2 && l1 <= 4 && !(l2 >= 12 && l2 <= 14);
}

function scaleNoun(scale: Scale, m: number, c: Case): string {
  const f = SCALE_FORMS[scale];
  const one = m === 1 ? 0 : 1;
  switch (c) {
    case 'M':
    case 'B':
      return m === 1 ? f.m1 : is24(m) ? f.m24 : f.mOther;
    case 'D':
      return f.D[one]!;
    case 'C':
      return f.C[one]!;
    case 'N':
      return f.N[one]!;
    case 'Ms':
      return f.Ms[one]!;
  }
}

/** Liczebnik główny (formy niemęskoosobowe), 0 ≤ n < 10⁹. */
export function cardinal(n: number, c: Case): string[] {
  if (n === 0) return [pick(ZERO, c)];
  const words: string[] = [];
  const mil = Math.floor(n / 1_000_000);
  const th = Math.floor(n / 1000) % 1000;
  const rest = n % 1000;
  if (mil) {
    if (mil !== 1) words.push(...under1000(mil, c, false));
    words.push(scaleNoun('milion', mil, c));
  }
  if (th) {
    if (th !== 1) words.push(...under1000(th, c, false));
    words.push(scaleNoun('tysiąc', th, c));
  }
  if (rest) words.push(...under1000(rest, c, words.length > 0));
  return words;
}

// ---------------------------------------------------------------- liczebniki porządkowe

const ORD_BASE: Record<number, string> = {
  1: 'pierwszy', 2: 'drugi', 3: 'trzeci', 4: 'czwarty', 5: 'piąty', 6: 'szósty', 7: 'siódmy', 8: 'ósmy', 9: 'dziewiąty',
  10: 'dziesiąty', 11: 'jedenasty', 12: 'dwunasty', 13: 'trzynasty', 14: 'czternasty', 15: 'piętnasty', 16: 'szesnasty',
  17: 'siedemnasty', 18: 'osiemnasty', 19: 'dziewiętnasty', 20: 'dwudziesty', 30: 'trzydziesty', 40: 'czterdziesty',
  50: 'pięćdziesiąty', 60: 'sześćdziesiąty', 70: 'siedemdziesiąty', 80: 'osiemdziesiąty', 90: 'dziewięćdziesiąty',
  100: 'setny', 200: 'dwusetny', 300: 'trzechsetny', 400: 'czterechsetny', 500: 'pięćsetny', 600: 'sześćsetny',
  700: 'siedemsetny', 800: 'osiemsetny', 900: 'dziewięćsetny', 1000: 'tysięczny', 2000: 'dwutysięczny',
};

/** Rodzaj liczebnika porządkowego: męski albo żeński (godziny). */
export type Gender = 'm' | 'f';

function declineOrdinal(base: string, g: Gender, c: Case): string {
  if (base === 'trzeci') {
    if (g === 'm') return { M: 'trzeci', B: 'trzeci', D: 'trzeciego', C: 'trzeciemu', N: 'trzecim', Ms: 'trzecim' }[c];
    return { M: 'trzecia', B: 'trzecią', D: 'trzeciej', C: 'trzeciej', N: 'trzecią', Ms: 'trzeciej' }[c];
  }
  if (base.endsWith('i')) {
    const st = base.slice(0, -1); // drug
    if (g === 'm') return { M: base, B: base, D: `${st}iego`, C: `${st}iemu`, N: `${st}im`, Ms: `${st}im` }[c];
    return { M: `${st}a`, B: `${st}ą`, D: `${st}iej`, C: `${st}iej`, N: `${st}ą`, Ms: `${st}iej` }[c];
  }
  const st = base.slice(0, -1);
  if (g === 'm') return { M: base, B: base, D: `${st}ego`, C: `${st}emu`, N: `${st}ym`, Ms: `${st}ym` }[c];
  return { M: `${st}a`, B: `${st}ą`, D: `${st}ej`, C: `${st}ej`, N: `${st}ą`, Ms: `${st}ej` }[c];
}

/**
 * Liczebnik porządkowy: dziesiątki i jedności porządkowe (oba odmieniane), wyższe składniki
 * w mianowniku liczebnika głównego. Zwraca null, gdy brak formy w tabelach.
 */
export function ordinal(n: number, g: Gender, c: Case): string[] | null {
  if (n <= 0) return null;
  const tu = n % 100;
  const higher = n - tu;
  if (tu > 0) {
    const prefix = higher > 0 ? cardinal(higher, 'M') : [];
    if (tu < 20 || tu % 10 === 0) return [...prefix, declineOrdinal(ORD_BASE[tu]!, g, c)];
    const t = tu - (tu % 10);
    return [...prefix, declineOrdinal(ORD_BASE[t]!, g, c), declineOrdinal(ORD_BASE[tu % 10]!, g, c)];
  }
  const h = Math.floor(n / 100) % 10;
  if (h > 0) {
    const thPart = n - (n % 1000);
    const prefix = thPart > 0 ? cardinal(thPart, 'M') : [];
    return [...prefix, declineOrdinal(ORD_BASE[h * 100]!, g, c)];
  }
  const base = ORD_BASE[n];
  return base ? [declineOrdinal(base, g, c)] : null;
}

// ---------------------------------------------------------------- przyimki i waluty

const PREP_CASE: Record<string, Case> = {};
for (const p of ['bez', 'dla', 'do', 'koło', 'obok', 'od', 'około', 'oprócz', 'podczas', 'spośród', 'u', 'wśród', 'zamiast']) PREP_CASE[p] = 'D';
for (const p of ['dzięki', 'ku', 'przeciw', 'wbrew']) PREP_CASE[p] = 'C';
for (const p of ['nad', 'przed']) PREP_CASE[p] = 'N';
for (const p of ['o', 'po', 'przy', 'w']) PREP_CASE[p] = 'Ms';
const AMBIGUOUS_PREPS = new Set(['z', 'za', 'pod', 'między', 'na']);

interface CurrencyForms {
  m1: string; m24: string; mOther: string;
  pl: { D: string; C: string; N: string; Ms: string };
  sg: { D: string; C: string; N: string; Ms: string };
  neuter?: true;
}

const CURRENCIES: Record<string, CurrencyForms> = {
  zł: { m1: 'złoty', m24: 'złote', mOther: 'złotych', pl: { D: 'złotych', C: 'złotym', N: 'złotymi', Ms: 'złotych' }, sg: { D: 'złotego', C: 'złotemu', N: 'złotym', Ms: 'złotym' } },
  jen: { m1: 'jen', m24: 'jeny', mOther: 'jenów', pl: { D: 'jenów', C: 'jenom', N: 'jenami', Ms: 'jenach' }, sg: { D: 'jena', C: 'jenowi', N: 'jenem', Ms: 'jenie' } },
  dolar: { m1: 'dolar', m24: 'dolary', mOther: 'dolarów', pl: { D: 'dolarów', C: 'dolarom', N: 'dolarami', Ms: 'dolarach' }, sg: { D: 'dolara', C: 'dolarowi', N: 'dolarem', Ms: 'dolarze' } },
  euro: { m1: 'euro', m24: 'euro', mOther: 'euro', pl: { D: 'euro', C: 'euro', N: 'euro', Ms: 'euro' }, sg: { D: 'euro', C: 'euro', N: 'euro', Ms: 'euro' }, neuter: true },
};

const CURRENCY_SYMBOL: Record<string, keyof typeof CURRENCIES> = {
  zł: 'zł', PLN: 'zł', '¥': 'jen', JPY: 'jen', $: 'dolar', USD: 'dolar', '€': 'euro', EUR: 'euro',
};

function currencyNoun(cur: CurrencyForms, value: number, decimal: boolean, c: Case): string {
  if (decimal) return cur.sg.D;
  if (c === 'M' || c === 'B') return value === 1 ? cur.m1 : is24(value) ? cur.m24 : cur.mOther;
  return value === 1 ? cur.sg[c] : cur.pl[c];
}

const ROK_FORMS: Record<Case, string> = { M: 'rok', B: 'rok', D: 'roku', C: 'rokowi', N: 'rokiem', Ms: 'roku' };

// ---------------------------------------------------------------- skaner

const NUM_RE = /(\d{1,3}(?:[  ]\d{3})+|\d+)(?:,(\d+))?(?!\d)/y;
const RANGE_RE = /\d+(?:,\d+)?[-–]\d+(?:,\d+)?(?!\d)/y;
const DATE_RE = /\d{1,2}\.\d{1,2}\.(?:\d{4}|\d{2})?(?!\d)/y;
const HOUR_RE = /(\d{1,2}):(\d{2})(?!\d)/y;
const YEAR_SUFFIX_RE = /(\d{4})(\s?)(r\.|roku(?![\p{L}\p{M}\p{N}]))/uy;
const YEAR_RE = /(\d{4})(?!\d)/y;
const ORDINAL_RE = /(\d+)\. (?=\p{Ll})/uy;
const LEADING_ZERO_RE = /0\d+(?![\d,])/y;
const ALNUM = /[\p{L}\p{M}\p{N}]/u;
const LETTER = /[\p{L}\p{M}]/u;
const DIGIT = /\d/;

function stickyAt(re: RegExp, s: string, i: number): RegExpExecArray | null {
  re.lastIndex = i;
  return re.exec(s);
}

function prevWord(s: string, i: number): string | null {
  let j = i - 1;
  if (j < 0 || !/\s/u.test(s[j]!)) return null;
  while (j >= 0 && /\s/u.test(s[j]!)) j--;
  let end = j + 1;
  while (j >= 0 && ALNUM.test(s[j]!)) j--;
  const w = s.slice(j + 1, end);
  return w.length ? w : null;
}

interface CaseInfo {
  c: Case;
  /** Przyimek z tabeli. */
  known: boolean;
  /** Przyimek niejednoznaczny (z, za, pod, między, na poza godzinami). */
  ambiguous: boolean;
}

function caseFrom(word: string | null, allowAccusative: boolean): CaseInfo {
  if (!word) return { c: 'M', known: false, ambiguous: false };
  const w = foldCase(word);
  if (allowAccusative && w === 'na') return { c: 'B', known: true, ambiguous: false };
  const c = PREP_CASE[w];
  if (c) return { c, known: true, ambiguous: false };
  return { c: 'M', known: false, ambiguous: AMBIGUOUS_PREPS.has(w) };
}

function digitsToInt(s: string): number {
  return Number(s.replace(/[  ]/g, ''));
}

function digitByDigit(s: string): string[] {
  return [...s].filter((ch) => DIGIT.test(ch)).map((d) => DIGIT_NAMES[Number(d)]!);
}

/** Część dziesiętna: „przecinek” + liczba w mianowniku (wiodące zera czytane jako „zero”). */
function fractionWords(frac: string): string[] {
  const out: string[] = ['przecinek'];
  let i = 0;
  while (i < frac.length - 1 && frac[i] === '0') {
    out.push('zero');
    i++;
  }
  const rest = Number(frac.slice(i));
  out.push(...cardinal(rest, 'M'));
  return out;
}

/** Liczba (część całkowita odmieniana) z ewentualną częścią dziesiętną. */
function numberWords(intStr: string, frac: string | undefined, c: Case, neuterOne = false): { words: string[]; overLimit: boolean } {
  const n = digitsToInt(intStr);
  if (n >= 1_000_000_000) {
    const words = digitByDigit(intStr);
    if (frac) words.push('przecinek', ...digitByDigit(frac));
    return { words, overLimit: true };
  }
  let words = cardinal(n, c);
  if (neuterOne && n === 1 && (c === 'M' || c === 'B') && !frac) words = ['jedno'];
  if (frac) words = [...words, ...fractionWords(frac)];
  return { words, overLimit: false };
}

function isUncertainGender(n: number): boolean {
  if (n === 1) return true;
  const rest = n % 1000;
  return rest % 10 === 2 && rest % 100 !== 12;
}

/**
 * Rozwija liczby w tekście według Koko-ASS §4.3 (wersja reguł 2).
 * Zwraca nowy tekst i listę rozwinięć (KK202/KK203/KK204).
 */
export function expandNumbers(text: string, opts: { version?: number } = {}): ExpandResult {
  if (opts.version !== undefined && opts.version !== NUMBERS_RULES_VERSION) {
    // Obsługiwana jest wyłącznie bieżąca wersja reguł.
  }
  const s = text;
  const expansions: NumberExpansion[] = [];
  let out = '';
  let i = 0;
  let last = 0;

  const emit = (from: number, to: number, replacement: string | null, pattern: number, code: NumberExpansion['code']) => {
    const original = s.slice(from, to);
    expansions.push({ from, to, original, replacement: replacement ?? original, pattern, code });
    out += s.slice(last, from) + (replacement ?? original);
    last = to;
    i = to;
  };

  while (i < s.length) {
    const ch = s[i]!;
    const prev = i > 0 ? s[i - 1] : undefined;

    // Waluta przed liczbą: ¥ lub $ (opcjonalnie spacja).
    if ((ch === '$' || ch === '¥') && (prev === undefined || !ALNUM.test(prev))) {
      let j = i + 1;
      if (s[j] === ' ') j++;
      const m = DIGIT.test(s[j] ?? '') ? stickyAt(NUM_RE, s, j) : null;
      if (m && !(m.index + m[0].length < s.length && LETTER.test(s[m.index + m[0].length]!))) {
        const cur = CURRENCIES[CURRENCY_SYMBOL[ch]!]!;
        const ci = caseFrom(prevWord(s, i), false);
        const c = ci.ambiguous ? 'M' : ci.c;
        const nw = numberWords(m[1]!, m[2], c, cur.neuter);
        const noun = currencyNoun(cur, digitsToInt(m[1]!), m[2] !== undefined, c);
        emit(i, m.index + m[0].length, [...nw.words, noun].join(' '), 9, nw.overLimit || ci.ambiguous ? 'KK204' : 'KK203');
        continue;
      }
    }

    if (!DIGIT.test(ch) || (prev !== undefined && DIGIT.test(prev))) {
      i++;
      continue;
    }

    // Wzorzec 1: cyfry sklejone z literą (cały ciąg alfanumeryczny).
    let rs = i;
    while (rs > 0 && ALNUM.test(s[rs - 1]!)) rs--;
    let re = i;
    while (re < s.length && ALNUM.test(s[re]!)) re++;
    const run = s.slice(rs, re);
    if (LETTER.test(run)) {
      emit(Math.max(rs, last), re, null, 1, 'KK202');
      continue;
    }

    // Minus bezpośrednio przed cyframi.
    let start = i;
    let minus = false;
    if ((prev === '-' || prev === '−') && (i - 2 < 0 || !ALNUM.test(s[i - 2]!)) && i - 1 >= last) {
      minus = true;
      start = i - 1;
    }

    let m: RegExpExecArray | null;
    // Wzorzec 2: zakres.
    if ((m = stickyAt(RANGE_RE, s, i))) {
      emit(i, i + m[0].length, null, 2, 'KK202');
      continue;
    }
    // Wzorzec 3: data.
    if ((m = stickyAt(DATE_RE, s, i))) {
      emit(i, i + m[0].length, null, 3, 'KK202');
      continue;
    }
    // Wzorzec 4: godzina.
    if ((m = stickyAt(HOUR_RE, s, i))) {
      const hh = Number(m[1]);
      const mm = Number(m[2]);
      if (hh <= 23 && mm <= 59) {
        const ci = caseFrom(prevWord(s, start), true);
        const c = ci.ambiguous ? 'M' : ci.c;
        const hourWords = hh === 0 ? ['zero'] : ordinal(hh, 'f', c)!;
        const minWords = mm === 0 ? [] : mm < 10 ? ['zero', ...cardinal(mm, 'M')] : cardinal(mm, 'M');
        emit(i, i + m[0].length, [...hourWords, ...minWords].join(' '), 4, ci.ambiguous ? 'KK204' : 'KK203');
        continue;
      }
    }
    // Wzorzec 5: rok z „r.” / „roku”.
    if ((m = stickyAt(YEAR_SUFFIX_RE, s, i))) {
      const y = Number(m[1]);
      if (y >= 1000 && y <= 2999) {
        const ci = caseFrom(prevWord(s, start), false);
        const c = ci.known ? ci.c : 'M';
        const words = ordinal(y, 'm', c)!;
        let end = i + m[0].length;
        let rok = ROK_FORMS[c];
        if (m[3] === 'r.') {
          const after = s.slice(end);
          if (/^\s*$/u.test(after) || /^\s+\p{Lu}/u.test(after)) rok += '.';
        }
        emit(i, end, [...words, rok].join(' '), 5, ci.known ? 'KK203' : 'KK204');
        continue;
      }
    }
    // Wzorzec 6: rok po słowie „rok”/„roku”.
    {
      const pw = prevWord(s, start);
      const pf = pw ? foldCase(pw) : '';
      if ((pf === 'rok' || pf === 'roku') && (m = stickyAt(YEAR_RE, s, i))) {
        const y = Number(m[1]);
        if (y >= 1000 && y <= 2999) {
          const words = ordinal(y, 'm', pf === 'rok' ? 'M' : 'D')!;
          emit(i, i + m[0].length, words.join(' '), 6, 'KK203');
          continue;
        }
      }
    }
    // Wzorzec 7: liczebnik porządkowy „27. odcinek”.
    if ((m = stickyAt(ORDINAL_RE, s, i))) {
      const n = Number(m[1]);
      const ci = caseFrom(prevWord(s, start), false);
      const c = ci.ambiguous ? 'M' : ci.c;
      const words = ordinal(n, 'm', c) ?? cardinal(Math.min(n, 999_999_999), 'M');
      // Kropka usuwana, spacja przed rzeczownikiem zostaje.
      emit(i, i + m[1]!.length + 1, words.join(' '), 7, 'KK204');
      continue;
    }
    // Wzorce 8, 9: procent i waluta po liczbie.
    const nm = stickyAt(NUM_RE, s, i);
    if (nm) {
      const end = i + nm[0].length;
      const tail = s.slice(end);
      const pct = /^\s?%/.exec(tail);
      if (pct) {
        const ci = caseFrom(prevWord(s, start), false);
        const c = ci.ambiguous ? 'M' : ci.c;
        const nw = numberWords(nm[1]!, nm[2], c);
        const words = [...(minus ? ['minus'] : []), ...nw.words, 'procent'];
        emit(start, end + pct[0].length, words.join(' '), 8, nw.overLimit || ci.ambiguous ? 'KK204' : 'KK203');
        continue;
      }
      const cur = /^\s?(zł|PLN|JPY|USD|EUR|¥|\$|€)(?![\p{L}\p{M}\p{N}])/u.exec(tail);
      if (cur) {
        const forms = CURRENCIES[CURRENCY_SYMBOL[cur[1]!]!]!;
        const ci = caseFrom(prevWord(s, start), false);
        const c = ci.ambiguous ? 'M' : ci.c;
        const nw = numberWords(nm[1]!, nm[2], c, forms.neuter);
        const noun = currencyNoun(forms, digitsToInt(nm[1]!), nm[2] !== undefined, c);
        const words = [...(minus ? ['minus'] : []), ...nw.words, noun];
        emit(start, end + cur[0].length, words.join(' '), 9, nw.overLimit || ci.ambiguous ? 'KK204' : 'KK203');
        continue;
      }
    }
    // Wzorzec 10: wiodące zero.
    if ((m = stickyAt(LEADING_ZERO_RE, s, i))) {
      emit(start, i + m[0].length, [...(minus ? ['minus'] : []), ...digitByDigit(m[0])].join(' '), 10, 'KK204');
      continue;
    }
    // Wzorzec 11: każda inna liczba.
    if (nm) {
      const ci = caseFrom(prevWord(s, start), false);
      const c = ci.ambiguous ? 'M' : ci.c;
      const nw = numberWords(nm[1]!, nm[2], c);
      const n = digitsToInt(nm[1]!);
      const uncertain = nw.overLimit || !ci.known || (nm[2] === undefined && isUncertainGender(n));
      const words = [...(minus ? ['minus'] : []), ...nw.words];
      emit(start, i + nm[0].length, words.join(' '), 11, uncertain ? 'KK204' : 'KK203');
      continue;
    }
    i++;
  }
  out += s.slice(last);
  return { text: out, expansions };
}
