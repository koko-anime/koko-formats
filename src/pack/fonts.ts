/**
 * Czcionki paczki (Koko-Pack §3.1): rozpoznanie pliku TrueType/OpenType/kolekcji
 * i odczyt nazw z tabeli `name` — dopasowanie do `Fontname` i `\fn` idzie po nazwach z pliku, nie po nazwie pliku.
 */

/** Nazwy kroju z tabeli `name` (wszystkie czcionki kolekcji `.ttc`). */
export interface FontNames {
  /** Rodziny (nameID 1 i 16). */
  readonly families: readonly string[];
  /** Pełne nazwy (nameID 4). */
  readonly fullNames: readonly string[];
  /** Nazwy PostScript (nameID 6). */
  readonly postscriptNames: readonly string[];
}

/** Dozwolone rozszerzenia plików w `fonts/` (bez rozróżniania wielkości liter). */
export const FONT_EXTENSIONS = ['.ttf', '.otf', '.ttc'] as const;

/** Czy nazwa pliku jest dozwolona bezpośrednio w `fonts/` (bez podkatalogów, rozszerzenie z listy). */
export function isFontFileName(name: string): boolean {
  if (!name || name.includes('/') || name.includes('\\') || name === '.' || name === '..') return false;
  const lower = name.toLowerCase();
  return FONT_EXTENSIONS.some((e) => lower.endsWith(e) && lower.length > e.length);
}

const tag = (b: Uint8Array, o: number) => String.fromCharCode(b[o]!, b[o + 1]!, b[o + 2]!, b[o + 3]!);

/** Rodzaj pliku po sygnaturze: `ttf`, `otf`, `ttc` albo null (to nie czcionka). */
export function fontKind(b: Uint8Array): 'ttf' | 'otf' | 'ttc' | null {
  if (b.length < 12) return null;
  const t = tag(b, 0);
  if (t === 'OTTO') return 'otf';
  if (t === 'ttcf') return 'ttc';
  if (t === 'true' || (b[0] === 0 && b[1] === 1 && b[2] === 0 && b[3] === 0)) return 'ttf';
  return null;
}

// Mac Roman 0x80–0xFF (platforma 1, kodowanie 0).
const MAC_ROMAN =
  'ÄÅÇÉÑÖÜáàâäãåçéèêëíìîïñóòôöõúùûü†°¢£§•¶ß®©™´¨≠ÆØ∞±≤≥¥µ∂∑∏π∫ªºΩæø¿¡¬√ƒ≈∆«»… ÀÃÕŒœ–—“”‘’÷◊ÿŸ⁄€‹›ﬁﬂ‡·‚„‰ÂÊÁËÈÍÎÏÌÓÔÒÚÛÙıˆ˜¯˘˙˚¸˝˛ˇ';

function decodeName(b: Uint8Array, from: number, len: number, platform: number, encoding: number): string | null {
  if (platform === 0 || (platform === 3 && (encoding === 0 || encoding === 1 || encoding === 10))) {
    if (len % 2) return null;
    let s = '';
    for (let i = 0; i < len; i += 2) s += String.fromCharCode((b[from + i]! << 8) | b[from + i + 1]!);
    return s;
  }
  if (platform === 1 && encoding === 0) {
    let s = '';
    for (let i = 0; i < len; i++) {
      const c = b[from + i]!;
      s += c < 0x80 ? String.fromCharCode(c) : MAC_ROMAN[c - 0x80]!;
    }
    return s;
  }
  return null;
}

function readFace(b: Uint8Array, dv: DataView, at: number, out: { f: Set<string>; n: Set<string>; p: Set<string> }): boolean {
  if (at + 12 > b.length) return false;
  const numTables = dv.getUint16(at + 4);
  if (at + 12 + numTables * 16 > b.length) return false;
  for (let i = 0; i < numTables; i++) {
    const r = at + 12 + i * 16;
    if (tag(b, r) !== 'name') continue;
    const off = dv.getUint32(r + 8);
    const len = dv.getUint32(r + 12);
    if (off + len > b.length || len < 6) return false;
    const count = dv.getUint16(off + 2);
    const strings = off + dv.getUint16(off + 4);
    if (off + 6 + count * 12 > b.length) return false;
    for (let k = 0; k < count; k++) {
      const rec = off + 6 + k * 12;
      const nameId = dv.getUint16(rec + 6);
      const target = nameId === 1 || nameId === 16 ? out.f : nameId === 4 ? out.n : nameId === 6 ? out.p : null;
      if (!target) continue;
      const sLen = dv.getUint16(rec + 8);
      const sOff = strings + dv.getUint16(rec + 10);
      if (sOff + sLen > b.length) continue;
      const s = decodeName(b, sOff, sLen, dv.getUint16(rec), dv.getUint16(rec + 2));
      if (s && s.trim()) target.add(s.trim());
    }
    return true;
  }
  return false;
}

/** Nazwy z tabeli `name` pliku czcionki; null, gdy pliku nie da się wczytać jako czcionki. */
export function readFontNames(b: Uint8Array): FontNames | null {
  const kind = fontKind(b);
  if (!kind) return null;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const out = { f: new Set<string>(), n: new Set<string>(), p: new Set<string>() };
  try {
    if (kind === 'ttc') {
      const n = dv.getUint32(8);
      if (n === 0 || 12 + n * 4 > b.length) return null;
      for (let i = 0; i < n; i++) if (!readFace(b, dv, dv.getUint32(12 + i * 4), out)) return null;
    } else if (!readFace(b, dv, 0, out)) return null;
  } catch {
    return null;
  }
  if (!out.f.size && !out.n.size && !out.p.size) return null;
  return Object.freeze({ families: Object.freeze([...out.f]), fullNames: Object.freeze([...out.n]), postscriptNames: Object.freeze([...out.p]) });
}

/** Wszystkie nazwy kroju złożone do porównania bez rozróżniania wielkości liter. */
export function fontNameKeys(n: FontNames): string[] {
  return [...n.families, ...n.fullNames, ...n.postscriptNames].map((x) => x.toLowerCase());
}
