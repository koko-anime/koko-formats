/**
 * Elementy modelu Koko-ASS: `[Script Info]`, style, zdarzenia, sekcje Koko, widok `line.kk`.
 */
import { diag } from '../core/diagnostics.ts';
import { ItemCollection, type Collection } from '../core/collections.ts';
import { markRaw, newId } from '../core/doc-core.ts';
import { KokoErrors } from '../core/errors.ts';
import type { Atom } from '../core/plugin-types.ts';
import { foldCase, nfc } from '../core/text.ts';
import {
  formatKkBlock,
  isLineFlag,
  isLinePair,
  isValidKkValue,
  tokenizeText,
  type KkItem,
  type LineFlag,
  type LinePair,
} from './kk.ts';
import type { LineAnalysis } from './analysis.ts';
import { LEKTOR_KEYS, RULES_KEYS, canonicalKeyName, type KeySpec } from './settings.ts';
import { isValidLexiconWord, type EntryShape } from '../lexicon/entry.ts';
import type { LexiconEntryData } from '../lexicon/lexicon.ts';

/** Interfejs właściciela (KokoAss) widziany przez elementy modelu. */
/** @internal */
export interface AssOwner {
  /** Zmiana w obrębie jednej linii zdarzenia. */
  _lineChanged(ev: AssEvent, atoms: Atom[], path: string[], kind?: 'update' | 'replace'): void;
  /** Zmiana wpływająca na całą analizę. */
  _globalChanged(atoms: Atom[], targetId: string | null, path: string[], kind: 'insert' | 'remove' | 'update' | 'move' | 'replace'): void;
  _atom(name: string): Atom;
  _lineAnalysis(id: string): LineAnalysis;
}

// ---------------------------------------------------------------- [Script Info]

export interface ScriptInfoItem {
  readonly id: string;
  kind: 'pair' | 'comment';
  key: string;
  value: string;
  sourceLine?: number;
}

/** Sekcja `[Script Info]`: uporządkowane pary `Klucz: wartość` i komentarze. */
export class ScriptInfo {
  /** @internal */ items: ScriptInfoItem[] = [];
  /** @internal */ readonly atom: Atom;
  /** @internal */ readonly owner: AssOwner;

  /** @internal */
  constructor(owner: AssOwner) {
    this.owner = owner;
    this.atom = owner._atom('scriptInfo');
    markRaw(this);
  }

  /** Wartość klucza (bez rozróżniania wielkości liter), ostatnie wystąpienie. */
  get(key: string): string | undefined {
    this.atom.track();
    const f = foldCase(key);
    for (let i = this.items.length - 1; i >= 0; i--) {
      const it = this.items[i]!;
      if (it.kind === 'pair' && foldCase(it.key) === f) return it.value;
    }
    return undefined;
  }

  /** Ustawia klucz; `undefined` usuwa. */
  set(key: string, value: string | undefined): void {
    const f = foldCase(key);
    const idx = this.items.findIndex((it) => it.kind === 'pair' && foldCase(it.key) === f);
    if (value === undefined) {
      if (idx < 0) return;
      this.items = this.items.filter((it) => !(it.kind === 'pair' && foldCase(it.key) === f));
    } else if (idx >= 0) {
      this.items[idx]!.value = nfc(value);
      this.items = this.items.filter((it, i) => i === idx || !(it.kind === 'pair' && foldCase(it.key) === f));
    } else this.items.push({ id: newId('si'), kind: 'pair', key, value: nfc(value) });
    this.owner._globalChanged([this.atom], null, ['scriptInfo', key], 'update');
  }

  /** Pary klucz–wartość w kolejności pliku (bez komentarzy). */
  entries(): [string, string][] {
    this.atom.track();
    return this.items.filter((i) => i.kind === 'pair').map((i) => [i.key, i.value]);
  }

  /** `KokoAnime Version` jako liczba albo null (zwykły ASS). */
  get kokoVersion(): number | null {
    const v = this.get('KokoAnime Version');
    if (v === undefined) return null;
    const n = Number(v.trim());
    return Number.isInteger(n) ? n : null;
  }
  set kokoVersion(v: number | null) {
    this.set('KokoAnime Version', v === null ? undefined : String(v));
  }
}

// ---------------------------------------------------------------- [V4+ Styles]

/** Kolumny `Format:` sekcji `[V4+ Styles]` (ASS v4.00+), w kolejności zapisu. */
export const STYLE_FORMAT = [
  'Name', 'Fontname', 'Fontsize', 'PrimaryColour', 'SecondaryColour', 'OutlineColour', 'BackColour', 'Bold', 'Italic',
  'Underline', 'StrikeOut', 'ScaleX', 'ScaleY', 'Spacing', 'Angle', 'BorderStyle', 'Outline', 'Shadow', 'Alignment',
  'MarginL', 'MarginR', 'MarginV', 'Encoding',
] as const;

/** @internal Wartości domyślne kolumn stylu (libass). */
export const STYLE_DEFAULTS: Record<string, string> = {
  Name: 'Default', Fontname: 'Arial', Fontsize: '20', PrimaryColour: '&H00FFFFFF', SecondaryColour: '&H000000FF',
  OutlineColour: '&H00000000', BackColour: '&H00000000', Bold: '0', Italic: '0', Underline: '0', StrikeOut: '0',
  ScaleX: '100', ScaleY: '100', Spacing: '0', Angle: '0', BorderStyle: '1', Outline: '2', Shadow: '2', Alignment: '2',
  MarginL: '10', MarginR: '10', MarginV: '10', Encoding: '1',
};

/** Styl ASS (`Style:` w `[V4+ Styles]`) — wszystkie kolumny z `Format:` pliku. */
export class AssStyle {
  /** Stabilne ID (tylko w pamięci). */
  readonly id: string;
  /** @internal */ fields: Map<string, string>;
  /** @internal */ readonly atom: Atom;
  /** @internal */ readonly owner: AssOwner;
  /** @internal */ sourceLine?: number;

  /** @internal */
  constructor(owner: AssOwner, fields: Map<string, string>) {
    this.id = newId('st');
    this.owner = owner;
    this.fields = fields;
    this.atom = owner._atom('style');
    markRaw(this);
  }

  /** Nazwa stylu (`Name`; przecinki są zamieniane na `;`). */
  get name(): string {
    return this.get('Name') ?? '';
  }
  set name(v: string) {
    this.set('Name', v);
  }

  /** Pole wg nazwy kolumny `Format:` (np. `Fontname`, `PrimaryColour`). */
  get(field: string): string | undefined {
    this.atom.track();
    const f = foldCase(field);
    for (const [k, v] of this.fields) if (foldCase(k) === f) return v;
    return undefined;
  }

  /** Ustawia pole (przecinki w wartości są zamieniane na `;`). */
  set(field: string, value: string): void {
    const f = foldCase(field);
    const existing = [...this.fields.keys()].find((k) => foldCase(k) === f);
    this.fields.set(existing ?? field, nfc(value).replace(/,/g, ';'));
    this.owner._globalChanged([this.atom], this.id, ['styles', this.id, field], 'update');
  }

  /** Kolumny spoza standardowego formatu V4+. */
  get extra(): Record<string, string> {
    this.atom.track();
    const std = new Set(STYLE_FORMAT.map((x) => foldCase(x)));
    return Object.fromEntries([...this.fields].filter(([k]) => !std.has(foldCase(k))));
  }

  /** Pola jako obiekt. */
  toJSON(): Record<string, string> {
    return Object.fromEntries(this.fields);
  }
}

/** Style `[V4+ Styles]`. */
export class StyleCollection extends ItemCollection<AssStyle> implements Collection<AssStyle> {
  /** @internal */ readonly owner: AssOwner;
  /** @internal */
  constructor(owner: AssOwner) {
    super({ atom: (n?: string) => owner._atom(n ?? 'styles') } as never, 'styles');
    this.owner = owner;
  }

  /** Styl o nazwie (z rozróżnianiem wielkości liter). */
  byName(name: string): AssStyle | undefined {
    this.atom.track();
    return this.items.find((s) => s.fields.get('Name') === name);
  }

  /** Dodaje styl; brakujące kolumny dostają wartości domyślne libass. */
  add(name: string, fields: Record<string, string> = {}): AssStyle {
    const map = new Map<string, string>();
    for (const f of STYLE_FORMAT) map.set(f, f === 'Name' ? name : (fields[f] ?? STYLE_DEFAULTS[f]!));
    for (const [k, v] of Object.entries(fields)) if (!map.has(k)) map.set(k, v);
    const st = new AssStyle(this.owner, map);
    this.items.push(st);
    this.owner._globalChanged([this.atom], st.id, ['styles', st.id], 'insert');
    return st;
  }

  /** Usuwa styl. */
  remove(id: string): boolean {
    const i = this.items.findIndex((x) => x.id === id);
    if (i < 0) return false;
    this.items.splice(i, 1);
    this.owner._globalChanged([this.atom], id, ['styles', id], 'remove');
    return true;
  }
}

// ---------------------------------------------------------------- [Events]

/** Typ zdarzenia: `Dialogue`, `Comment` albo inny z pliku (zachowywany). */
export type EventType = 'Dialogue' | 'Comment' | (string & {});

/** Dane nowego zdarzenia (`EventList.insert`). */
export interface AssEventData {
  /** Typ (domyślnie `Dialogue`). */
  type?: EventType;
  /** Warstwa. */
  layer?: number;
  /** Start w ms. */
  start?: number;
  /** Koniec w ms. */
  end?: number;
  /** Styl (domyślnie `Default`). */
  style?: string;
  /** Aktor (`Name`). */
  name?: string;
  /** Margines lewy. */
  marginL?: number;
  /** Margines prawy. */
  marginR?: number;
  /** Margines pionowy. */
  marginV?: number;
  /** Efekt. */
  effect?: string;
  /** Pole Text (z tagami i adnotacjami). */
  text?: string;
}

/** Zakres `{!kk ipa=…}…{!kk /}` albo `{!kk sub=…}…{!kk /}` w `line.text`. */
export interface KkRange {
  /** ID (pozycyjne — zmienia się po edycji tekstu). */
  readonly id: string;
  /** Rodzaj zakresu. */
  readonly kind: 'ipa' | 'sub';
  /** IPA albo pisownia fonetyczna. */
  readonly value: string;
  /** Początek objętego tekstu (UTF-16 w `line.text`). */
  readonly from: number;
  /** Koniec objętego tekstu. */
  readonly to: number;
}

/** Pauza `{!kk pause=…}` w `line.text`. */
export interface KkPause {
  /** ID (pozycyjne). */
  readonly id: string;
  /** Pozycja bloku `{!kk pause=…}` w `line.text`. */
  readonly at: number;
  /** Długość w ms. */
  readonly ms: number;
}

/** Klucz linii z wartością (`say`, `speed`, `maxspeed`, `gain`, `offset`). */
export type KkValueKey = LinePair;

/** Widok adnotacji `{!kk …}` nad `line.text` (specyfikacja API §4.3). */
export class KkView {
  /** @internal */ readonly ev: AssEvent;
  /** @internal */
  constructor(ev: AssEvent) {
    this.ev = ev;
    markRaw(this);
  }

  #tokens() {
    return tokenizeText(this.ev.text);
  }

  #lineItems(): KkItem[] {
    const out: KkItem[] = [];
    for (const t of this.#tokens()) if (t.kind === 'kk') out.push(...t.items);
    return out;
  }

  #pair(name: string): string | undefined {
    let v: string | undefined;
    for (const it of this.#lineItems()) if (it.type === 'pair' && it.name === name) v = it.value;
    return v;
  }

  #num(name: string): number | undefined {
    const v = this.#pair(name);
    if (v === undefined) return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }

  /** `say=` — tekst mówiony zamiast wyświetlanego. */
  get say(): string | undefined {
    return this.#pair('say');
  }
  set say(v: string | undefined) {
    this.set('say', v === undefined ? undefined : sanitize(v));
  }
  /** `speed=` — mnożnik prędkości linii. */
  get speed(): number | undefined {
    return this.#num('speed');
  }
  set speed(v: number | undefined) {
    this.set('speed', v === undefined ? undefined : String(v));
  }
  /** `maxspeed=` — nadpisuje `MaxSpeed`. */
  get maxspeed(): number | undefined {
    return this.#num('maxspeed');
  }
  set maxspeed(v: number | undefined) {
    this.set('maxspeed', v === undefined ? undefined : String(v));
  }
  /** `gain=` — dB, dodawane. */
  get gain(): number | undefined {
    return this.#num('gain');
  }
  set gain(v: number | undefined) {
    this.set('gain', v === undefined ? undefined : String(v));
  }
  /** `offset=` — ms, dodawane do `Offset`. */
  get offset(): number | undefined {
    return this.#num('offset');
  }
  set offset(v: number | undefined) {
    this.set('offset', v === undefined ? undefined : String(v));
  }

  /** Czy linia ma flagę (`skip`, `read`, `join`, `nojoin`). */
  has(flag: LineFlag): boolean {
    return this.#lineItems().some((it) => it.type === 'flag' && it.name === flag);
  }

  /** Ustawia klucz linii; `undefined` usuwa. Wartość z `{`, `}` lub `"` → KK006. */
  set(key: KkValueKey, value: string | undefined): void | KokoErrors {
    if (!isLinePair(key)) return new KokoErrors([diag('KK001', { level: 'error', params: { key } })]);
    if (value !== undefined && !isValidKkValue(value)) return new KokoErrors([diag('KK006', { level: 'error', params: { key, value } })]);
    this.#rewriteLineKeys((items) => {
      const rest = items.filter((it) => !(it.type === 'pair' && it.name === key));
      return value === undefined ? rest : [...rest, { type: 'pair', name: key, value: nfc(value), quoted: false, raw: '' }];
    }, key);
  }

  /** Włącza/wyłącza flagę (bez `on` — przełącza). */
  toggle(flag: LineFlag, on?: boolean): void {
    if (!isLineFlag(flag)) return;
    const want = on ?? !this.has(flag);
    this.#rewriteLineKeys((items) => {
      const rest = items.filter((it) => !(it.type === 'flag' && it.name === flag));
      return want ? [...rest, { type: 'flag', name: flag, raw: flag }] : rest;
    }, flag);
  }

  /**
   * Usuwa klucze linii z istniejących bloków (puste bloki znikają) i zapisuje wynik
   * w pierwszym bloku na początku tekstu (tworząc go, gdy trzeba).
   */
  #rewriteLineKeys(update: (items: KkItem[]) => KkItem[], touched: string): void {
    const text = this.ev.text;
    const tokens = this.#tokens();
    const lineKeyItems: KkItem[] = [];
    for (const t of tokens) {
      if (t.kind !== 'kk') continue;
      for (const it of t.items) {
        if ((it.type === 'flag' && isLineFlag(it.name)) || (it.type === 'pair' && isLinePair(it.name))) lineKeyItems.push(it);
      }
    }
    // Ostatnia wartość każdej pary wygrywa — zachowujemy jedną kopię.
    const dedup: KkItem[] = [];
    for (const it of lineKeyItems) {
      if (it.type === 'pair') {
        const i = dedup.findIndex((x) => x.type === 'pair' && x.name === it.name);
        if (i >= 0) dedup.splice(i, 1);
      } else if (it.type === 'flag' && dedup.some((x) => x.type === 'flag' && x.name === it.name)) continue;
      dedup.push(it);
    }
    const next = update(dedup);
    let out = '';
    let pos = 0;
    for (const t of tokens) {
      if (t.kind !== 'kk') continue;
      const kept = t.items.filter((it) => !((it.type === 'flag' && isLineFlag(it.name)) || (it.type === 'pair' && isLinePair(it.name))));
      out += text.slice(pos, t.from);
      if (kept.length) out += formatKkBlock(kept);
      pos = t.to;
    }
    out += text.slice(pos);
    const result = next.length ? formatKkBlock(next) + out : out;
    void touched;
    this.ev.text = result;
  }

  /** Zakresy `ipa=`/`sub=` w kolejności tekstu. */
  get ranges(): readonly KkRange[] {
    const out: KkRange[] = [];
    let open: { kind: 'ipa' | 'sub'; value: string; from: number } | null = null;
    let n = 0;
    const tokens = this.#tokens();
    for (const t of tokens) {
      if (t.kind !== 'kk') continue;
      for (const it of t.items) {
        if (it.type === 'close' && open) {
          out.push({ id: `${this.ev.id}:r${n++}`, kind: open.kind, value: open.value, from: open.from, to: t.from });
          open = null;
        } else if (it.type === 'pair' && (it.name === 'ipa' || it.name === 'sub')) {
          if (open) out.push({ id: `${this.ev.id}:r${n++}`, kind: open.kind, value: open.value, from: open.from, to: t.from });
          open = { kind: it.name, value: it.value, from: t.to };
        }
      }
    }
    if (open) out.push({ id: `${this.ev.id}:r${n++}`, kind: open.kind, value: open.value, from: open.from, to: this.ev.text.length });
    return out;
  }

  /** Pauzy `pause=` w kolejności tekstu. */
  get pauses(): readonly KkPause[] {
    const out: KkPause[] = [];
    let n = 0;
    for (const t of this.#tokens()) {
      if (t.kind !== 'kk') continue;
      for (const it of t.items) {
        if (it.type === 'pair' && it.name === 'pause') {
          const ms = Number(it.value);
          if (Number.isFinite(ms)) out.push({ id: `${this.ev.id}:p${n++}`, at: t.from, ms });
        }
      }
    }
    return out;
  }

  #insideBlock(pos: number): boolean {
    return this.#tokens().some((t) => t.kind !== 'text' && pos > t.from && pos < t.to);
  }

  /** Dodaje zakres `ipa=`/`sub=` nad tekstem `[from, to)`. */
  addRange(from: number, to: number, value: { ipa: string } | { sub: string }): KkRange | KokoErrors {
    const kind: 'ipa' | 'sub' = 'ipa' in value ? 'ipa' : 'sub';
    const v = 'ipa' in value ? value.ipa : value.sub;
    const text = this.ev.text;
    if (!(from >= 0 && to >= from && to <= text.length) || this.#insideBlock(from) || this.#insideBlock(to))
      return new KokoErrors([diag('KK003', { level: 'error', targetId: this.ev.id, params: { reason: 'range-position' } })]);
    if (!isValidKkValue(v) || v.trim() === '') return new KokoErrors([diag('KK006', { level: 'error', targetId: this.ev.id, params: { key: kind, value: v } })]);
    if (this.ranges.some((r) => from < r.to && to > r.from))
      return new KokoErrors([diag('KK003', { level: 'error', targetId: this.ev.id, params: { reason: 'nested-range' } })]);
    const open = formatKkBlock([{ type: 'pair', name: kind, value: nfc(v), quoted: false, raw: '' }]);
    const close = '{!kk /}';
    this.ev.text = text.slice(0, from) + open + text.slice(from, to) + close + text.slice(to);
    const r = this.ranges.find((x) => x.from === from + open.length);
    return r ?? new KokoErrors([diag('KK003', { level: 'error', targetId: this.ev.id })]);
  }

  /** Zmienia wartość zakresu. */
  updateRange(id: string, value: { ipa: string } | { sub: string }): void | KokoErrors {
    const kind: 'ipa' | 'sub' = 'ipa' in value ? 'ipa' : 'sub';
    const v = 'ipa' in value ? value.ipa : value.sub;
    if (!isValidKkValue(v) || v.trim() === '') return new KokoErrors([diag('KK006', { level: 'error', targetId: this.ev.id, params: { key: kind, value: v } })]);
    this.#editRangeOpen(id, (items, idx) => {
      items[idx] = { type: 'pair', name: kind, value: nfc(v), quoted: false, raw: '' };
      return items;
    });
  }

  /** Usuwa zakres (zostaje objęty tekst). */
  removeRange(id: string): void {
    const r = this.ranges.find((x) => x.id === id);
    if (!r) return;
    const text = this.ev.text;
    const tokens = this.#tokens();
    const openTok = tokens.find((t) => t.kind === 'kk' && t.to === r.from);
    const closeTok = tokens.find((t) => t.kind === 'kk' && t.from === r.to && t.items.some((i) => i.type === 'close'));
    let out = '';
    let pos = 0;
    for (const t of [openTok, closeTok].filter(Boolean) as Extract<(typeof tokens)[number], { kind: 'kk' }>[]) {
      out += text.slice(pos, t.from);
      const kept = t === openTok
        ? t.items.filter((i) => !(i.type === 'pair' && (i.name === 'ipa' || i.name === 'sub')))
        : t.items.filter((i) => i.type !== 'close');
      if (kept.length) out += formatKkBlock(kept);
      pos = t.to;
    }
    out += text.slice(pos);
    this.ev.text = out;
  }

  #editRangeOpen(id: string, fn: (items: KkItem[], idx: number) => KkItem[]): void {
    const r = this.ranges.find((x) => x.id === id);
    if (!r) return;
    const text = this.ev.text;
    const tok = this.#tokens().find((t) => t.kind === 'kk' && t.to === r.from);
    if (!tok || tok.kind !== 'kk') return;
    const items = [...tok.items];
    let idx = -1;
    items.forEach((it, i) => {
      if (it.type === 'pair' && (it.name === 'ipa' || it.name === 'sub')) idx = i;
    });
    if (idx < 0) return;
    this.ev.text = text.slice(0, tok.from) + formatKkBlock(fn(items, idx)) + text.slice(tok.to);
  }

  /** Wstawia pauzę na pozycji `at` (UTF-16 w `line.text`). */
  insertPause(at: number, ms: number): void | KokoErrors {
    const text = this.ev.text;
    if (!(at >= 0 && at <= text.length) || this.#insideBlock(at) || !Number.isInteger(ms) || ms < 0)
      return new KokoErrors([diag('KK006', { level: 'error', targetId: this.ev.id, params: { key: 'pause', value: ms } })]);
    this.ev.text = text.slice(0, at) + `{!kk pause=${ms}}` + text.slice(at);
  }

  /** Usuwa pauzę. */
  removePause(id: string): void {
    const p = this.pauses.find((x) => x.id === id);
    if (!p) return;
    const text = this.ev.text;
    const tok = this.#tokens().find((t) => t.kind === 'kk' && t.from === p.at);
    if (!tok || tok.kind !== 'kk') return;
    let removed = false;
    const kept = tok.items.filter((it) => {
      if (!removed && it.type === 'pair' && it.name === 'pause' && Number(it.value) === p.ms) {
        removed = true;
        return false;
      }
      return true;
    });
    this.ev.text = text.slice(0, tok.from) + (kept.length ? formatKkBlock(kept) : '') + text.slice(tok.to);
  }
}

function sanitize(v: string): string {
  return v.replace(/"/g, '”').replace(/\{/g, '(').replace(/\}/g, ')');
}

/** Zdarzenie `[Events]` (`Dialogue:`/`Comment:`). Czasy w ms. */
export class AssEvent {
  /** Stabilne ID (tylko w pamięci). */
  readonly id: string;
  /** @internal */ _type: EventType;
  /** @internal */ _layer: number;
  /** @internal */ _start: number;
  /** @internal */ _end: number;
  /** @internal */ _style: string;
  /** @internal */ _name: string;
  /** @internal */ _marginL: number;
  /** @internal */ _marginR: number;
  /** @internal */ _marginV: number;
  /** @internal */ _effect: string;
  /** @internal */ _text: string;
  /** @internal */ readonly atom: Atom;
  /** @internal */ readonly analysisAtom: Atom;
  /** @internal */ readonly owner: AssOwner;
  /** @internal */ sourceLine?: number;
  /** Widok adnotacji `{!kk …}` nad `text`. */
  readonly kk: KkView;

  /** @internal */
  constructor(owner: AssOwner, d: AssEventData) {
    this.id = newId('ev');
    this.owner = owner;
    this._type = d.type ?? 'Dialogue';
    this._layer = d.layer ?? 0;
    this._start = d.start ?? 0;
    this._end = d.end ?? this._start;
    this._style = d.style ?? 'Default';
    this._name = d.name ?? '';
    this._marginL = d.marginL ?? 0;
    this._marginR = d.marginR ?? 0;
    this._marginV = d.marginV ?? 0;
    this._effect = d.effect ?? '';
    this._text = nfc(d.text ?? '');
    this.atom = owner._atom('event');
    this.analysisAtom = owner._atom('analysis');
    this.kk = new KkView(this);
    markRaw(this);
  }

  #set<K extends keyof this>(field: K, path: string, v: this[K]): void {
    if (this[field] === v) return;
    this[field] = v;
    this.owner._lineChanged(this, [this.atom], ['events', this.id, path]);
  }

  /** Typ zdarzenia. */
  get type(): EventType { this.atom.track(); return this._type; }
  set type(v: EventType) { this.#set('_type', 'type', v); }
  /** Warstwa. */
  get layer(): number { this.atom.track(); return this._layer; }
  set layer(v: number) { this.#set('_layer', 'layer', Math.trunc(v)); }
  /** Start w ms. */
  get start(): number { this.atom.track(); return this._start; }
  set start(v: number) { this.#set('_start', 'start', Math.max(0, Math.round(v))); }
  /** Koniec w ms. */
  get end(): number { this.atom.track(); return this._end; }
  set end(v: number) { this.#set('_end', 'end', Math.max(0, Math.round(v))); }
  /** Styl. */
  get style(): string { this.atom.track(); return this._style; }
  set style(v: string) { this.#set('_style', 'style', nfc(v).replace(/,/g, ';')); }
  /** Aktor (`Name`). */
  get name(): string { this.atom.track(); return this._name; }
  set name(v: string) { this.#set('_name', 'name', nfc(v).replace(/,/g, ';')); }
  /** Margines lewy. */
  get marginL(): number { this.atom.track(); return this._marginL; }
  set marginL(v: number) { this.#set('_marginL', 'marginL', Math.trunc(v)); }
  /** Margines prawy. */
  get marginR(): number { this.atom.track(); return this._marginR; }
  set marginR(v: number) { this.#set('_marginR', 'marginR', Math.trunc(v)); }
  /** Margines pionowy. */
  get marginV(): number { this.atom.track(); return this._marginV; }
  set marginV(v: number) { this.#set('_marginV', 'marginV', Math.trunc(v)); }
  /** Efekt (niepusty → pomijana przy `SkipIfEffect`). */
  get effect(): string { this.atom.track(); return this._effect; }
  set effect(v: string) { this.#set('_effect', 'effect', nfc(v).replace(/,/g, ';')); }
  /** Surowe pole Text. */
  get text(): string { this.atom.track(); return this._text; }
  set text(v: string) { this.#set('_text', 'text', nfc(v).replace(/\r?\n/g, '\\N')); }

  /** Analiza linii (leniwie). */
  get analysis(): LineAnalysis {
    this.analysisAtom.track();
    return this.owner._lineAnalysis(this.id);
  }

  /** Pola jako obiekt. */
  toJSON(): Required<AssEventData> {
    return {
      type: this._type, layer: this._layer, start: this._start, end: this._end, style: this._style, name: this._name,
      marginL: this._marginL, marginR: this._marginR, marginV: this._marginV, effect: this._effect, text: this._text,
    };
  }
}

// ---------------------------------------------------------------- sekcje Koko

export interface SettingItem {
  readonly id: string;
  kind: 'pair' | 'comment';
  key: string;
  raw: string;
  sourceLine?: number;
}

/** `[Koko Lektor]` i `[Koko Rules]` (specyfikacja API §4.2). */
export class Settings<K extends object> {
  /** @internal */ items: SettingItem[] = [];
  /** @internal */ readonly atom: Atom;
  /** @internal */ readonly owner: AssOwner;
  /** @internal */ readonly table: { [P in keyof K]: KeySpec<K[P]> };
  /** @internal */ readonly section: string;

  /** @internal */
  constructor(owner: AssOwner, section: string, table: { [P in keyof K]: KeySpec<K[P]> }) {
    this.owner = owner;
    this.section = section;
    this.table = table;
    this.atom = owner._atom(section);
    markRaw(this);
  }

  #find(key: keyof K): SettingItem | undefined {
    const f = foldCase(String(key));
    for (let i = this.items.length - 1; i >= 0; i--) {
      const it = this.items[i]!;
      if (it.kind === 'pair' && foldCase(it.key) === f) return it;
    }
    return undefined;
  }

  /** Wartość efektywna (domyślna, gdy brak lub niepoprawna). */
  get<P extends keyof K>(key: P): K[P] {
    this.atom.track();
    const spec = this.table[key];
    const it = this.#find(key);
    if (!it) return spec.default;
    const v = spec.parse(it.raw);
    return v === undefined ? spec.default : v;
  }

  /** Wartość tak jak w pliku. */
  getRaw(key: keyof K): string | undefined {
    this.atom.track();
    return this.#find(key)?.raw;
  }

  /** Czy klucz jest w pliku. */
  isSet(key: keyof K): boolean {
    this.atom.track();
    return this.#find(key) !== undefined;
  }

  /** Ustawia klucz (wartość typowana albo surowy tekst); `undefined` usuwa. */
  set<P extends keyof K>(key: P, value: K[P] | string | undefined): void {
    const spec = this.table[key];
    const f = foldCase(String(key));
    if (value === undefined) {
      this.items = this.items.filter((it) => !(it.kind === 'pair' && foldCase(it.key) === f));
    } else {
      const raw = typeof value === 'string' ? nfc(value) : spec.format(value as K[P]);
      const it = this.#find(key);
      if (it) {
        it.raw = raw;
        it.key = spec.name;
      } else this.items.push({ id: newId('kv'), kind: 'pair', key: spec.name, raw });
    }
    this.owner._globalChanged([this.atom], null, [this.section, String(key)], 'update');
  }

  /** Klucze spoza specyfikacji (KK001), zachowywane przy zapisie. */
  get unknownKeys(): string[] {
    this.atom.track();
    return this.items.filter((it) => it.kind === 'pair' && canonicalKeyName(this.table as never, it.key) === undefined).map((it) => it.key);
  }
}

/** Wpis `[Koko Styles]`: `wzorzec = skip` albo `wzorzec = speed=… gain=… mode=…`. */
export class KokoStyleRule {
  /** Stabilne ID. */
  readonly id: string;
  /** @internal */ _pattern: string;
  /** @internal */ _skip: boolean;
  /** @internal */ params: { key: string; value: string }[];
  /** @internal */ readonly atom: Atom;
  /** @internal */ readonly owner: AssOwner;
  /** @internal */ sourceLine?: number;

  /** @internal */
  constructor(owner: AssOwner, pattern: string, skip: boolean, params: { key: string; value: string }[]) {
    this.id = newId('ks');
    this.owner = owner;
    this._pattern = pattern;
    this._skip = skip;
    this.params = params;
    this.atom = owner._atom('kokoStyle');
    markRaw(this);
  }

  #changed(path: string) {
    this.owner._globalChanged([this.atom], this.id, ['koko', 'styles', this.id, path], 'update');
  }
  #param(k: string): string | undefined {
    this.atom.track();
    return this.params.find((p) => p.key === k)?.value;
  }
  #setParam(k: string, v: string | undefined) {
    this.params = this.params.filter((p) => p.key !== k);
    if (v !== undefined) this.params.push({ key: k, value: v });
    this.#changed(k);
  }

  /** Wzorzec nazwy stylu (`*`, `?`). */
  get pattern(): string { this.atom.track(); return this._pattern; }
  set pattern(v: string) { this._pattern = nfc(v).trim(); this.#changed('pattern'); }
  /** Styl nieczytany. */
  get skip(): boolean { this.atom.track(); return this._skip; }
  set skip(v: boolean) { this._skip = !!v; this.#changed('skip'); }
  /** Mnożnik prędkości. */
  get speed(): number | undefined { const v = this.#param('speed'); return v === undefined ? undefined : Number(v); }
  set speed(v: number | undefined) { this.#setParam('speed', v === undefined ? undefined : String(v)); }
  /** Gain w dB (dodawany). */
  get gain(): number | undefined { const v = this.#param('gain'); return v === undefined ? undefined : Number(v); }
  set gain(v: number | undefined) { this.#setParam('gain', v === undefined ? undefined : String(v)); }
  /** Etykieta: `speech`, `thought`, `flashback`. */
  get mode(): string | undefined { return this.#param('mode'); }
  set mode(v: string | undefined) { this.#setParam('mode', v); }
}

/** Sekcja `[Koko Styles]` — pierwszy pasujący wpis wygrywa. */
export class KokoStyleRules extends ItemCollection<KokoStyleRule> {
  /** @internal */ readonly owner: AssOwner;
  /** @internal */ constructor(owner: AssOwner) {
    super({ atom: (n?: string) => owner._atom(n ?? 'kokoStyles') } as never, 'kokoStyles');
    this.owner = owner;
  }
  /** Dodaje regułę (opcjonalnie na pozycji `at`). */
  add(pattern: string, opts: { skip?: boolean; speed?: number; gain?: number; mode?: string } = {}, at?: number): KokoStyleRule {
    const params: { key: string; value: string }[] = [];
    if (opts.speed !== undefined) params.push({ key: 'speed', value: String(opts.speed) });
    if (opts.gain !== undefined) params.push({ key: 'gain', value: String(opts.gain) });
    if (opts.mode !== undefined) params.push({ key: 'mode', value: opts.mode });
    const r = new KokoStyleRule(this.owner, nfc(pattern).trim(), !!opts.skip, params);
    this.items.splice(at ?? this.items.length, 0, r);
    this.owner._globalChanged([this.atom], r.id, ['koko', 'styles', r.id], 'insert');
    return r;
  }
  /** Usuwa regułę. */
  remove(id: string): boolean {
    const i = this.items.findIndex((x) => x.id === id);
    if (i < 0) return false;
    this.items.splice(i, 1);
    this.owner._globalChanged([this.atom], id, ['koko', 'styles', id], 'remove');
    return true;
  }
}

/** Element `[Koko Lexicon]`: wpis `słowo[*] = wartość` albo komentarz `;`. */
export class EpisodeLexiconItem {
  /** Stabilne ID. */
  readonly id: string;
  /** Wpis albo komentarz. */
  readonly kind: 'entry' | 'comment';
  /** @internal */ _key: string;
  /** @internal */ _stem: boolean;
  /** @internal Wartość jak w formie prostej: IPA albo `~pisownia`. */ _value: string;
  /** @internal */ _text: string;
  /** @internal */ _form: 'simple' | 'full' = 'simple';
  /** @internal */ _aliases: string[] = [];
  /** @internal */ _forms: [string, string][] = [];
  /** @internal */ _note: string | undefined;
  /** @internal */ _verified = false;
  /** @internal */ _flattened = false;
  /** @internal */ readonly atom: Atom;
  /** @internal */ readonly owner: AssOwner;
  /** @internal */ sourceLine?: number;

  /** @internal */
  constructor(owner: AssOwner, kind: 'entry' | 'comment', d: { key?: string; stem?: boolean; value?: string; text?: string; full?: EntryShape }) {
    this.id = newId('kl');
    this.kind = kind;
    this.owner = owner;
    this._key = d.key ?? '';
    this._stem = !!d.stem;
    this._value = d.value ?? '';
    this._text = d.text ?? '';
    if (d.full) this._applyShape(d.full);
    this.atom = owner._atom('lexItem');
    markRaw(this);
  }

  /** @internal */
  _applyShape(e: EntryShape): void {
    this._form = 'full';
    this._stem = e.stem;
    this._value = e.kind === 'ipa' ? e.value : `~${e.value}`;
    this._aliases = [...e.aliases];
    this._forms = e.forms.map(([k, v]) => [k, v] as [string, string]);
    this._note = e.note;
    this._verified = e.verified;
  }

  /** @internal Wpis w modelu Koko-Lexicon (forma prosta = bez aliasów, form, notatki). */
  _shape(): EntryShape {
    const respell = this._value.startsWith('~');
    return {
      kind: respell ? 'respell' : 'ipa',
      value: respell ? this._value.slice(1) : this._value,
      stem: this._stem,
      aliases: [...this._aliases],
      forms: this._forms.map(([k, v]) => [k, v] as [string, string]),
      note: this._note,
      verified: this._verified,
    };
  }

  #changed(path: string) {
    this.owner._globalChanged([this.atom], this.id, ['koko', 'lexicon', this.id, path], 'update');
  }

  /** Klucz bez `*`. */
  get key(): string { this.atom.track(); return this._key; }
  set key(v: string) { if (this._flattened) return; this._key = nfc(v).trim(); this.#changed('key'); }
  /** Dopasowanie form odmienionych (`rdzeń*` albo `stem = true`). */
  get stem(): boolean { this.atom.track(); return this._stem; }
  set stem(v: boolean) { if (this._flattened) return; this._stem = !!v; this.#changed('stem'); }
  /** Wartość: IPA albo `~pisownia` (w formie pełnej — `ipa` albo `~` + `respell`). */
  get value(): string { this.atom.track(); return this._value; }
  set value(v: string) { if (this._flattened) return; this._value = nfc(v).trim(); this.#changed('value'); }
  /** Treść komentarza (bez `;`). */
  get text(): string { this.atom.track(); return this._text; }
  set text(v: string) { if (this._flattened) return; this._text = nfc(v).replace(/[\r\n]+/g, ' '); this.#changed('text'); }
  /** Element bloku spłaszczonego leksykonu serii (tylko do odczytu). */
  get flattened(): boolean { this.atom.track(); return this._flattened; }
  /** `respell` dla wartości z `~`, inaczej `ipa`. */
  get valueKind(): 'ipa' | 'respell' { return this.value.startsWith('~') ? 'respell' : 'ipa'; }
  /** Forma zapisu wpisu (Koko-ASS §2): `simple` (`słowo = wartość`) albo `full` (tabela TOML w jednej linii). */
  get form(): 'simple' | 'full' { this.atom.track(); return this._form; }
  /** Aliasy (forma pełna). */
  get aliases(): readonly string[] { this.atom.track(); return Object.freeze([...this._aliases]); }
  /** Formy z pełną wymową (forma pełna). */
  get forms(): Readonly<Record<string, string>> { this.atom.track(); return Object.freeze(Object.fromEntries(this._forms)); }
  /** Notatka (bez wpływu na dźwięk). */
  get note(): string | undefined { this.atom.track(); return this._note; }
  /** Sprawdzone na słuch (bez wpływu na dźwięk). */
  get verified(): boolean { this.atom.track(); return this._verified; }

  /** Wpis w modelu Koko-Lexicon (`ipa`/`respell`, `stem`, `aliases`, `forms`, `note`, `verified`). */
  toEntry(): LexiconEntryData {
    const e = this._shape();
    const o: LexiconEntryData = e.kind === 'ipa' ? { ipa: e.value } : { respell: e.value };
    if (e.stem) o.stem = true;
    if (e.aliases.length) o.aliases = e.aliases;
    if (e.forms.length) o.forms = Object.fromEntries(e.forms);
    if (e.note !== undefined) o.note = e.note;
    if (e.verified) o.verified = true;
    return o;
  }

  /**
   * Ustawia cały wpis (Koko-Lexicon §1). Aliasy, formy, notatka albo `verified` przepisują wpis na formę pełną;
   * forma pełna nie wraca do prostej (Koko-ASS §2). Niepoprawne dane (KL004) → `KokoErrors`.
   */
  setEntry(data: LexiconEntryData): void | KokoErrors {
    if (this._flattened || this.kind !== 'entry') return;
    const errors = entryDataErrors(this._key, data);
    if (errors) return errors;
    const shape = shapeOf(data);
    const full = this._form === 'full' || !isSimpleShape(shape);
    if (full) this._applyShape(shape);
    else {
      this._stem = shape.stem;
      this._value = shape.kind === 'ipa' ? shape.value : `~${shape.value}`;
    }
    this.#changed('entry');
  }
}

function isSimpleShape(e: EntryShape): boolean {
  return e.aliases.length === 0 && e.forms.length === 0 && e.note === undefined && !e.verified;
}

function shapeOf(d: LexiconEntryData): EntryShape {
  const ipa = typeof d.ipa === 'string';
  return {
    kind: ipa ? 'ipa' : 'respell',
    value: nfc((ipa ? d.ipa : d.respell)!.trim()),
    stem: !!d.stem,
    aliases: (d.aliases ?? []).map((a) => nfc(a)),
    forms: Object.entries(d.forms ?? {}).map(([k, v]) => [nfc(k), nfc(v)] as [string, string]),
    note: d.note ? nfc(d.note) : undefined,
    verified: !!d.verified,
  };
}

function entryDataErrors(key: string, d: LexiconEntryData): KokoErrors | undefined {
  const errs = [];
  if ((typeof d.ipa === 'string') === (typeof d.respell === 'string')) errs.push(diag('KL004', { level: 'error', params: { key, reason: 'ipa/respell' } }));
  const v = d.ipa ?? d.respell;
  if (typeof v === 'string' && (!v.trim() || v.startsWith('~') || v.trim().startsWith('{'))) errs.push(diag('KL004', { level: 'error', params: { key, reason: 'value' } }));
  for (const w of [...(d.aliases ?? []), ...Object.keys(d.forms ?? {})]) if (!isValidLexiconWord(w)) errs.push(diag('KL004', { level: 'error', params: { key, word: w } }));
  for (const fv of Object.values(d.forms ?? {})) if (!fv || fv.startsWith('~')) errs.push(diag('KL004', { level: 'error', params: { key, reason: 'form' } }));
  return errs.length ? new KokoErrors(errs) : undefined;
}

/** Sekcja `[Koko Lexicon]` (leksykon odcinka, łącznie z blokiem spłaszczonego leksykonu serii). */
export class EpisodeLexicon extends ItemCollection<EpisodeLexiconItem> {
  /** @internal */ readonly owner: AssOwner;
  /** @internal */ constructor(owner: AssOwner) {
    super({ atom: (n?: string) => owner._atom(n ?? 'kokoLexicon') } as never, 'kokoLexicon');
    this.owner = owner;
  }
  /**
   * Dodaje wpis przed blokiem spłaszczonego leksykonu serii: `add('Jinshi*', 'dʑinɕi')` (forma prosta)
   * albo `add('Jinshi', { ipa: 'dʑinɕi', aliases: ['Jinshi-sama'] })` (forma pełna, gdy są aliasy, formy, notatka lub `verified`).
   */
  add(key: string, value: string | LexiconEntryData, opts: { stem?: boolean } = {}): EpisodeLexiconItem | KokoErrors {
    const k = nfc(key).replace(/\*$/, '').trim();
    if (!isValidLexiconWord(k)) return new KokoErrors([diag('KL004', { level: 'error', params: { key: k, reason: 'key' } })]);
    let it: EpisodeLexiconItem;
    if (typeof value === 'string') {
      it = new EpisodeLexiconItem(this.owner, 'entry', { key: k, stem: opts.stem ?? key.trim().endsWith('*'), value: nfc(value).trim() });
    } else {
      const err = entryDataErrors(k, value);
      if (err) return err;
      const shape = shapeOf(value);
      it = isSimpleShape(shape)
        ? new EpisodeLexiconItem(this.owner, 'entry', { key: k, stem: shape.stem, value: shape.kind === 'ipa' ? shape.value : `~${shape.value}` })
        : new EpisodeLexiconItem(this.owner, 'entry', { key: k, full: shape });
    }
    const firstFlat = this.items.findIndex((x) => x._flattened);
    this.items.splice(firstFlat < 0 ? this.items.length : firstFlat, 0, it);
    this.owner._globalChanged([this.atom], it.id, ['koko', 'lexicon', it.id], 'insert');
    return it;
  }
  /** Dodaje komentarz przed blokiem spłaszczonego leksykonu serii. */
  addComment(text: string): EpisodeLexiconItem {
    const it = new EpisodeLexiconItem(this.owner, 'comment', { text: nfc(text) });
    const firstFlat = this.items.findIndex((x) => x._flattened);
    this.items.splice(firstFlat < 0 ? this.items.length : firstFlat, 0, it);
    this.owner._globalChanged([this.atom], it.id, ['koko', 'lexicon', it.id], 'insert');
    return it;
  }
  /** Usuwa element (elementy spłaszczone są tylko do odczytu). */
  remove(id: string): boolean {
    const i = this.items.findIndex((x) => x.id === id && !x._flattened);
    if (i < 0) return false;
    this.items.splice(i, 1);
    this.owner._globalChanged([this.atom], id, ['koko', 'lexicon', id], 'remove');
    return true;
  }
}

/** Dane wpisu `[Koko Sources]`. */
export interface SourceData {
  /** Info-hash v1 (40 hex lub 32 base32). */
  btih?: string;
  /** Info-hash v2 (`1220` + 64 hex). */
  btmh?: string;
  /** Ścieżka pliku w torrencie (wymagana). */
  file?: string;
  /** Rozmiar w bajtach (wymagany). */
  size?: number;
  /** Nazwa torrenta. */
  name?: string;
  /** Odcisk pliku (`sha256:…`). */
  fingerprint?: string;
}

/** @internal */
export const SOURCE_FIELDS = ['btih', 'btmh', 'name', 'file', 'size', 'fingerprint'] as const;

/** Wydanie wideo z `[Koko Sources]`, do którego pasują napisy. */
export class SourceEntry {
  /** Stabilne ID. */
  readonly id: string;
  /** @internal */ _label: string;
  /** @internal */ fields: Map<string, string>;
  /** @internal */ readonly atom: Atom;
  /** @internal */ readonly owner: AssOwner;
  /** @internal */ sourceLine?: number;

  /** @internal */
  constructor(owner: AssOwner, label: string, fields: Map<string, string>) {
    this.id = newId('src');
    this.owner = owner;
    this._label = label;
    this.fields = fields;
    this.atom = owner._atom('source');
    markRaw(this);
  }
  #get(k: string) { this.atom.track(); return this.fields.get(k); }
  #set(k: string, v: string | undefined) {
    if (v === undefined) this.fields.delete(k);
    else this.fields.set(k, nfc(v));
    this.owner._globalChanged([this.atom], this.id, ['koko', 'sources', this.id, k], 'update');
  }
  /** Etykieta (klucz wpisu). */
  get label(): string { this.atom.track(); return this._label; }
  set label(v: string) { this._label = nfc(v).trim(); this.owner._globalChanged([this.atom], this.id, ['koko', 'sources', this.id, 'label'], 'update'); }
  /** Info-hash v1. */
  get btih(): string | undefined { return this.#get('btih'); }
  set btih(v: string | undefined) { this.#set('btih', v); }
  /** Info-hash v2. */
  get btmh(): string | undefined { return this.#get('btmh'); }
  set btmh(v: string | undefined) { this.#set('btmh', v); }
  /** Ścieżka pliku w torrencie. */
  get file(): string | undefined { return this.#get('file'); }
  set file(v: string | undefined) { this.#set('file', v); }
  /** Rozmiar w bajtach. */
  get size(): number | undefined { const v = this.#get('size'); return v === undefined ? undefined : Number(v); }
  set size(v: number | undefined) { this.#set('size', v === undefined ? undefined : String(v)); }
  /** Nazwa torrenta. */
  get name(): string | undefined { return this.#get('name'); }
  set name(v: string | undefined) { this.#set('name', v); }
  /** Odcisk pliku. */
  get fingerprint(): string | undefined { return this.#get('fingerprint'); }
  set fingerprint(v: string | undefined) { this.#set('fingerprint', v); }
  /** Poprawność wpisu (KK007). */
  get valid(): boolean { this.atom.track(); return validateSource(this.fields) === null; }
  /** Link magnet (bez trackerów). */
  get magnet(): string | undefined {
    if (!this.valid) return undefined;
    const parts: string[] = [];
    if (this.btih) parts.push(`xt=urn:btih:${this.btih}`);
    if (this.btmh) parts.push(`xt=urn:btmh:${this.btmh}`);
    if (this.name) parts.push(`dn=${encodeURIComponent(this.name)}`);
    return `magnet:?${parts.join('&')}`;
  }
}

/** @internal Zwraca powód błędu wpisu źródła albo null. */
export function validateSource(f: ReadonlyMap<string, string>): string | null {
  const btih = f.get('btih');
  const btmh = f.get('btmh');
  if (!btih && !btmh) return 'btih/btmh';
  if (btih && !/^([0-9a-fA-F]{40}|[A-Za-z2-7]{32})$/.test(btih)) return 'btih';
  if (btmh && !/^1220[0-9a-fA-F]{64}$/.test(btmh)) return 'btmh';
  if (!f.get('file')) return 'file';
  const size = f.get('size');
  if (!size || !/^\d+$/.test(size)) return 'size';
  const fp = f.get('fingerprint');
  if (fp !== undefined && !/^sha256:[0-9a-f]{64}$/.test(fp)) return 'fingerprint';
  for (const k of f.keys()) if (!(SOURCE_FIELDS as readonly string[]).includes(k)) return `unknown:${k}`;
  return null;
}

/** Sekcja `[Koko Sources]` — pierwszy wpis to wydanie referencyjne. */
export class Sources extends ItemCollection<SourceEntry> {
  /** @internal */ readonly owner: AssOwner;
  /** @internal */ constructor(owner: AssOwner) {
    super({ atom: (n?: string) => owner._atom(n ?? 'kokoSources') } as never, 'kokoSources');
    this.owner = owner;
  }
  /** Dodaje wydanie. */
  add(label: string, data: SourceData): SourceEntry {
    const m = new Map<string, string>();
    for (const k of SOURCE_FIELDS) {
      const v = data[k];
      if (v !== undefined) m.set(k, String(v));
    }
    const s = new SourceEntry(this.owner, nfc(label).trim(), m);
    this.items.push(s);
    this.owner._globalChanged([this.atom], s.id, ['koko', 'sources', s.id], 'insert');
    return s;
  }
  /** Usuwa wydanie. */
  remove(id: string): boolean {
    const i = this.items.findIndex((x) => x.id === id);
    if (i < 0) return false;
    this.items.splice(i, 1);
    this.owner._globalChanged([this.atom], id, ['koko', 'sources', id], 'remove');
    return true;
  }
}

/** Nieznana sekcja (np. `[Aegisub Project Garbage]`), zachowywana bez zmian. */
export interface RawSection {
  /** Stabilne ID. */
  readonly id: string;
  /** Nazwa bez nawiasów. */
  name: string;
  /** Linie treści. */
  lines: string[];
}

/** Sekcje `[Koko …]` dokumentu. */
export interface KokoSections {
  /** `[Koko Lektor]` — głos i ściszanie. */
  readonly lektor: Settings<import('./settings.ts').LektorKeys>;
  /** `[Koko Rules]` — co czytać, łączenie, timing. */
  readonly rules: Settings<import('./settings.ts').RulesKeys>;
  /** `[Koko Styles]` — modyfikatory per styl. */
  readonly styles: KokoStyleRules;
  /** `[Koko Lexicon]` — wymowa słów. */
  readonly lexicon: EpisodeLexicon;
  /** `[Koko Sources]` — pasujące wydania wideo. */
  readonly sources: Sources;
}

export { LEKTOR_KEYS, RULES_KEYS };
export type { LineFlag };
