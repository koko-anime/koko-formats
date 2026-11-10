/**
 * Konwencje tekstu (Koko-ASS §1): NFC, simple case folding, porządek po punktach kodowych,
 * granice słów, wzorce `*`/`?`, podzbiór regex dla `SkipIfMatch`.
 */

export function nfc(s: string): string {
  return s.normalize('NFC');
}

const foldCache = new Map<number, string>();

/**
 * Unicode simple case folding (CaseFolding.txt, statusy C+S) dla pojedynczego punktu kodowego.
 * Realizacja: lower(upper(c)) gdy obie operacje są 1:1, inaczej lower(c) gdy 1:1, inaczej c.
 * Wyjątek Cherokee: folding mapuje małe litery na wielkie.
 */
function foldCodePoint(cp: number): string {
  const hit = foldCache.get(cp);
  if (hit !== undefined) return hit;
  const c = String.fromCodePoint(cp);
  let out = c;
  if ((cp >= 0xab70 && cp <= 0xabbf) || (cp >= 0x13f8 && cp <= 0x13fd)) {
    out = c.toUpperCase();
  } else if (cp >= 0x13a0 && cp <= 0x13f5) {
    out = c;
  } else {
    const up = c.toUpperCase();
    if ([...up].length === 1) {
      const low = up.toLowerCase();
      if ([...low].length === 1) out = low;
      else {
        const l2 = c.toLowerCase();
        out = [...l2].length === 1 ? l2 : c;
      }
    } else {
      const l2 = c.toLowerCase();
      out = [...l2].length === 1 ? l2 : c;
    }
  }
  foldCache.set(cp, out);
  return out;
}

/** Simple case folding całego ciągu (bez reguł zależnych od języka). */
export function foldCase(s: string): string {
  let out = '';
  for (const ch of s) out += foldCodePoint(ch.codePointAt(0)!);
  return out;
}

/** Porównanie po punktach kodowych (nie jednostkach UTF-16). */
export function compareCodePoints(a: string, b: string): number {
  const ia = a[Symbol.iterator]();
  const ib = b[Symbol.iterator]();
  for (;;) {
    const x = ia.next();
    const y = ib.next();
    if (x.done) return y.done ? 0 : -1;
    if (y.done) return 1;
    const d = x.value.codePointAt(0)! - y.value.codePointAt(0)!;
    if (d !== 0) return d;
  }
}

const WORD_CHAR = /[\p{L}\p{M}\p{N}]/u;
export function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && ch !== '' && WORD_CHAR.test(ch);
}

/** Wzorzec z `*` i `?` dopasowany do całej nazwy, z rozróżnianiem wielkości liter. */
export function wildcardMatch(pattern: string, name: string): boolean {
  const p = [...pattern];
  const n = [...name];
  let pi = 0;
  let ni = 0;
  let star = -1;
  let mark = 0;
  while (ni < n.length) {
    if (pi < p.length && (p[pi] === '?' || p[pi] === n[ni])) {
      pi++;
      ni++;
    } else if (pi < p.length && p[pi] === '*') {
      star = pi++;
      mark = ni;
    } else if (star !== -1) {
      pi = star + 1;
      ni = ++mark;
    } else return false;
  }
  while (pi < p.length && p[pi] === '*') pi++;
  return pi === p.length;
}

export function matchesAny(patterns: readonly string[], name: string): boolean {
  return patterns.some((p) => wildcardMatch(p, name));
}

/**
 * Sprawdza podzbiór regex dozwolony w `SkipIfMatch` (Koko-ASS §2): bez odwołań wstecznych,
 * lookahead/lookbehind, grup nazwanych i flag inline. Zwraca RegExp albo null (KK006).
 */
export function compileSkipRegex(src: string): RegExp | null {
  let inClass = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '\\') {
      const n = src[i + 1];
      if (n === undefined) return null;
      if (!inClass && /[1-9]/.test(n)) return null; // odwołanie wsteczne
      if (n === 'k') return null; // \k<name>
      i++;
      continue;
    }
    if (inClass) {
      if (c === ']') inClass = false;
      continue;
    }
    if (c === '[') {
      inClass = true;
      continue;
    }
    if (c === '(' && src[i + 1] === '?') {
      const n2 = src[i + 2];
      if (n2 !== ':') return null; // lookaround, grupy nazwane, flagi inline
    }
  }
  try {
    return new RegExp(src, 'u');
  } catch {
    return null;
  }
}

/** Tekst bool z sekcji Koko: yes/no, true/false, 1/0, tak/nie. */
export function parseBool(v: string): boolean | undefined {
  const s = foldCase(v.trim());
  if (s === 'yes' || s === 'true' || s === '1' || s === 'tak') return true;
  if (s === 'no' || s === 'false' || s === '0' || s === 'nie') return false;
  return undefined;
}

export function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

export function fromUtf8(b: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: false }).decode(b);
}
