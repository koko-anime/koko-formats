/**
 * Tokenizacja pola Text i składnia adnotacji `{!kk …}` (Koko-ASS §3, §5).
 */
import { foldCase } from '../core/text.ts';

export type KkItem =
  | { type: 'flag'; name: string; raw: string }
  | { type: 'pair'; name: string; value: string; quoted: boolean; raw: string }
  | { type: 'close' };

/** Fragment pola Text. Pozycje to indeksy UTF-16 w `text`. */
export type TextToken =
  | { kind: 'text'; from: number; to: number; s: string }
  /** Blok `{…}` inny niż poprawna adnotacja (tagi override, komentarze, błędne `{!kk`). */
  | { kind: 'block'; from: number; to: number; s: string; badKk: boolean }
  | { kind: 'kk'; from: number; to: number; items: KkItem[] };

const IDENT = /^[\p{L}][\p{L}\p{N}_]*$/u;

/** Parsuje treść bloku po `{` (bez nawiasów), zaczynającą się od `!kk`. null = błędna składnia. */
export function parseKkBody(body: string): KkItem[] | null {
  if (!body.startsWith('!kk')) return null;
  let rest = body.slice(3);
  if (rest.length > 0 && !/^\s/u.test(rest)) return null;
  const items: KkItem[] = [];
  let i = 0;
  const n = rest.length;
  while (i < n) {
    while (i < n && /\s/u.test(rest[i]!)) i++;
    if (i >= n) break;
    if (rest[i] === '/') {
      // zamknięcie musi być osobnym elementem
      if (i + 1 < n && !/\s/u.test(rest[i + 1]!)) return null;
      items.push({ type: 'close' });
      i++;
      continue;
    }
    let j = i;
    while (j < n && !/[\s=]/u.test(rest[j]!)) j++;
    const ident = rest.slice(i, j);
    if (!IDENT.test(ident)) return null;
    const name = foldCase(ident);
    if (j < n && rest[j] === '=') {
      j++;
      if (j < n && rest[j] === '"') {
        const end = rest.indexOf('"', j + 1);
        if (end < 0) return null;
        const value = rest.slice(j + 1, end);
        if (/[{}]/.test(value)) return null;
        items.push({ type: 'pair', name, value, quoted: true, raw: rest.slice(i, end + 1) });
        i = end + 1;
        if (i < n && !/\s/u.test(rest[i]!)) return null;
      } else {
        let k = j;
        while (k < n && !/[\s"{}]/u.test(rest[k]!)) k++;
        if (k === j) return null;
        if (k < n && !/\s/u.test(rest[k]!)) return null;
        items.push({ type: 'pair', name, value: rest.slice(j, k), quoted: false, raw: rest.slice(i, k) });
        i = k;
      }
    } else {
      items.push({ type: 'flag', name, raw: ident });
      i = j;
    }
  }
  return items;
}

/** Dzieli Text na tekst, bloki `{…}` i adnotacje. */
export function tokenizeText(text: string): TextToken[] {
  const out: TextToken[] = [];
  let i = 0;
  let textStart = 0;
  const flush = (to: number) => {
    if (to > textStart) out.push({ kind: 'text', from: textStart, to, s: text.slice(textStart, to) });
  };
  while (i < text.length) {
    if (text[i] === '{') {
      const end = text.indexOf('}', i + 1);
      if (end < 0) break; // niezamknięty blok = zwykły tekst
      flush(i);
      const body = text.slice(i + 1, end);
      if (body.startsWith('!kk') && (body.length === 3 || /^\s/u.test(body.slice(3)))) {
        const items = parseKkBody(body);
        if (items) out.push({ kind: 'kk', from: i, to: end + 1, items });
        else out.push({ kind: 'block', from: i, to: end + 1, s: text.slice(i, end + 1), badKk: true });
      } else {
        out.push({ kind: 'block', from: i, to: end + 1, s: text.slice(i, end + 1), badKk: false });
      }
      i = end + 1;
      textStart = i;
      continue;
    }
    i++;
  }
  flush(text.length);
  return out;
}

/** Zapis wartości: w `"…"`, gdy zawiera biały znak lub jest pusta. */
export function formatKkValue(v: string): string {
  return v === '' || /\s/u.test(v) ? `"${v}"` : v;
}

export function formatKkItem(it: KkItem): string {
  if (it.type === 'close') return '/';
  if (it.type === 'flag') return it.name;
  return `${it.name}=${formatKkValue(it.value)}`;
}

export function formatKkBlock(items: readonly KkItem[]): string {
  return items.length ? `{!kk ${items.map(formatKkItem).join(' ')}}` : '{!kk}';
}

/** Wartość dopuszczalna w adnotacji (bez `{`, `}`, `"`). */
export function isValidKkValue(v: string): boolean {
  return !/[{}"]/.test(v);
}

export const LINE_FLAGS = ['skip', 'read', 'join', 'nojoin'] as const;
export type LineFlag = (typeof LINE_FLAGS)[number];
export const LINE_PAIRS = ['say', 'speed', 'maxspeed', 'gain', 'offset'] as const;
export type LinePair = (typeof LINE_PAIRS)[number];
export const TEXT_PAIRS = ['ipa', 'sub', 'pause'] as const;

export function isLineFlag(n: string): n is LineFlag {
  return (LINE_FLAGS as readonly string[]).includes(n);
}
export function isLinePair(n: string): n is LinePair {
  return (LINE_PAIRS as readonly string[]).includes(n);
}
