/**
 * Wspólny model wpisu leksykonu (Koko-Lexicon §1) dla `koko-lexicon.toml` i formy pełnej
 * w `[Koko Lexicon]` Koko-ASS (§2): walidacja, tabela TOML w jednej linii, linia spłaszczenia (§3).
 */
import { parse as parseToml, TomlError } from 'smol-toml';
import { compareCodePoints, nfc } from '../core/text.ts';

/** Pola wpisu (KL003 dla innych). */
export const KNOWN_ENTRY = new Set(['ipa', 'respell', 'stem', 'aliases', 'forms', 'note', 'verified']);

/** Klucze, aliasy, formy: niepuste, bez `= ; * [ ]`, bez wiodącego `~` (KL004). */
export function isValidLexiconWord(w: string): boolean {
  return w.trim().length > 0 && !/[=;*[\]]/.test(w) && !w.startsWith('~') && !/[\r\n]/.test(w);
}

/** @internal Wpis po walidacji pól (przed rozstrzygnięciem kolizji słów). */
export interface EntryShape {
  kind: 'ipa' | 'respell';
  value: string;
  stem: boolean;
  aliases: string[];
  forms: [string, string][];
  note: string | undefined;
  verified: boolean;
}

/** @internal Zgłoszenie problemu walidacji (kod KL + parametry). */
export type EntryReport = (code: 'KL003' | 'KL004', params: Record<string, string>) => void;

/**
 * @internal Waliduje tabelę wpisu (KL003, KL004). Zwraca null, gdy wpis jest pomijany w całości;
 * niepoprawne aliasy i formy są pomijane pojedynczo.
 */
export function validateEntryTable(key: string, raw: unknown, report: EntryReport): EntryShape | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    report('KL004', { key, reason: 'type' });
    return null;
  }
  const e = raw as Record<string, unknown>;
  for (const f of Object.keys(e)) if (!KNOWN_ENTRY.has(f)) report('KL003', { key, field: f });
  const hasIpa = 'ipa' in e;
  const hasRespell = 'respell' in e;
  if (hasIpa === hasRespell) {
    report('KL004', { key, reason: 'ipa/respell' });
    return null;
  }
  const value = hasIpa ? e.ipa : e.respell;
  if (typeof value !== 'string' || value.length === 0 || value.startsWith('~')) {
    report('KL004', { key, reason: hasIpa ? 'ipa' : 'respell' });
    return null;
  }
  if (('stem' in e && typeof e.stem !== 'boolean') || ('verified' in e && typeof e.verified !== 'boolean') || ('note' in e && typeof e.note !== 'string')) {
    report('KL004', { key, reason: 'type' });
    return null;
  }
  const aliases: string[] = [];
  if ('aliases' in e) {
    if (!Array.isArray(e.aliases)) {
      report('KL004', { key, reason: 'aliases' });
      return null;
    }
    for (const a of e.aliases) {
      if (typeof a === 'string' && isValidLexiconWord(a)) aliases.push(nfc(a));
      else report('KL004', { key, alias: String(a) });
    }
  }
  const forms: [string, string][] = [];
  if ('forms' in e) {
    if (typeof e.forms !== 'object' || e.forms === null || Array.isArray(e.forms)) {
      report('KL004', { key, reason: 'forms' });
      return null;
    }
    for (const [fk, fv] of Object.entries(e.forms as Record<string, unknown>)) {
      if (isValidLexiconWord(fk) && typeof fv === 'string' && fv.length > 0 && !fv.startsWith('~')) forms.push([nfc(fk), nfc(fv)]);
      else report('KL004', { key, form: fk });
    }
  }
  return {
    kind: hasIpa ? 'ipa' : 'respell',
    value: nfc(value),
    stem: e.stem === true,
    aliases,
    forms,
    note: typeof e.note === 'string' && e.note !== '' ? nfc(e.note) : undefined,
    verified: e.verified === true,
  };
}

/** @internal Tabela TOML w jednej linii (`{ … }`) → obiekt albo błąd z kolumną (od 1, względem wartości). */
export function parseInlineTable(value: string): { table: unknown } | { error: string; column: number } {
  try {
    const data = parseToml(`v = ${value}`) as { v?: unknown };
    if (Object.keys(data).length !== 1 || typeof data.v !== 'object' || data.v === null || Array.isArray(data.v)) return { error: 'not-inline-table', column: 1 };
    return { table: data.v };
  } catch (e) {
    const col = e instanceof TomlError ? Math.max(1, e.column - 4) : 1;
    return { error: e instanceof Error ? e.message.split('\n')[0]! : String(e), column: col };
  }
}

/** @internal TOML basic string (Koko-Lexicon §3 p. 4): escapowane tylko `"`, `\` i znaki kontrolne. */
export function tomlString(s: string): string {
  let out = '"';
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (ch === '"') out += '\\"';
    else if (ch === '\\') out += '\\\\';
    else if (ch === '\b') out += '\\b';
    else if (ch === '\t') out += '\\t';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\f') out += '\\f';
    else if (ch === '\r') out += '\\r';
    else if (cp < 0x20 || cp === 0x7f) out += `\\u${cp.toString(16).toUpperCase().padStart(4, '0')}`;
    else out += ch;
  }
  return out + '"';
}

/** @internal Klucz TOML: goły, gdy pasuje do `[A-Za-z0-9_-]+`, inaczej basic string. */
export function tomlKey(k: string): string {
  return /^[A-Za-z0-9_-]+$/.test(k) ? k : tomlString(k);
}

/** @internal Czy wpis ma tylko wymowę (i ewentualnie `stem`) — wtedy forma prosta. */
export function isSimpleEntry(e: Pick<EntryShape, 'aliases' | 'forms' | 'note' | 'verified'>): boolean {
  return e.aliases.length === 0 && e.forms.length === 0 && e.note === undefined && !e.verified;
}

/**
 * @internal Kanoniczna tabela w jednej linii (Koko-Lexicon §3 p. 4): pola w kolejności
 * `ipa`/`respell`, `stem`, `forms`, `aliases`, `note`, `verified`; wartości domyślne pominięte.
 */
export function formatInlineTable(e: EntryShape): string {
  const parts = [`${e.kind} = ${tomlString(e.value)}`];
  if (e.stem) parts.push('stem = true');
  const forms = [...e.forms].sort(([a], [b]) => compareCodePoints(a, b));
  if (forms.length) parts.push(`forms = { ${forms.map(([k, v]) => `${tomlKey(k)} = ${tomlString(v)}`).join(', ')} }`);
  if (e.aliases.length) parts.push(`aliases = [${e.aliases.map(tomlString).join(', ')}]`);
  if (e.note !== undefined) parts.push(`note = ${tomlString(e.note)}`);
  if (e.verified) parts.push('verified = true');
  return `{ ${parts.join(', ')} }`;
}

/** @internal Linia wpisu: forma prosta `klucz[*] = wartość` albo pełna `klucz = { … }`. */
export function formatEntryLine(key: string, e: EntryShape): string {
  if (isSimpleEntry(e)) return `${key}${e.stem ? '*' : ''} = ${e.kind === 'ipa' ? e.value : `~${e.value}`}`;
  return `${key} = ${formatInlineTable(e)}`;
}
