/**
 * Koko-Lexicon v1 — `KokoLexicon` (specyfikacja API §5, Koko-Lexicon §1–§4).
 */
import { parse as parseToml, TomlError } from 'smol-toml';
import { formatEntryLine, isValidLexiconWord, tomlKey, tomlString, validateEntryTable } from './entry.ts';
import { resolveConfig, type CallConfig } from '../core/config-store.ts';
import { diag, type Diagnostic } from '../core/diagnostics.ts';
import { Derived, DocCore, markRaw, newId, type ChangeListener, type Observable } from '../core/doc-core.ts';
import { KokoErrors } from '../core/errors.ts';
import { ItemCollection, ObservableList, ObservableMap, type Collection } from '../core/collections.ts';
import { compareCodePoints, foldCase, nfc } from '../core/text.ts';
import type { Atom } from '../core/plugin-types.ts';

/** Dane wpisu leksykonu (Koko-Lexicon §1) — dokładnie jedno z `ipa`/`respell`. */
export interface LexiconEntryData {
  /** Wymowa IPA (symbole ze słownika modelu). */
  ipa?: string;
  /** Polska pisownia fonetyczna (bez `~`). */
  respell?: string;
  /** Dopasowanie form odmienionych (`rdzeń*`). */
  stem?: boolean;
  /** Inne zapisy z tą samą wymową i `stem`. */
  aliases?: readonly string[];
  /** Pełna wymowa wybranych form (wartość tego samego rodzaju co wpis). */
  forms?: Readonly<Record<string, string>>;
  /** Notatka dla ludzi. */
  note?: string;
  /** Sprawdzone na słuch. */
  verified?: boolean;
}

/** Wpis jako obiekt (`LexiconEntry.toJSON`). */
export interface LexiconEntryJson extends LexiconEntryData {
  /** Klucz wpisu. */
  key: string;
}

/** Wpis po walidacji (KL004/KL005) — używany przy spłaszczaniu i w Koko-ASS. */
export interface EffectiveLexiconEntry {
  /** Klucz. */
  key: string;
  /** Rodzaj wartości. */
  kind: 'ipa' | 'respell';
  /** IPA albo pisownia fonetyczna. */
  value: string;
  /** Dopasowanie form odmienionych. */
  stem: boolean;
  /** Aliasy po usunięciu kolizji. */
  aliases: string[];
  /** Formy po usunięciu kolizji. */
  forms: [string, string][];
  /** Notatka. */
  note: string | undefined;
  /** Sprawdzone na słuch. */
  verified: boolean;
}

const KNOWN_TOP = new Set(['format', 'version', 'title', 'entries']);

export { isValidLexiconWord };

/** Wpis leksykonu serii (`[entries.<klucz>]`). */
export class LexiconEntry {
  /** Stabilne ID. */
  readonly id: string;
  /** @internal */ _key: string;
  /** @internal */ _kind: 'ipa' | 'respell';
  /** @internal */ _value: string;
  /** @internal */ _stem: boolean;
  /** @internal */ _note: string | undefined;
  /** @internal */ _verified: boolean;
  /** Aliasy (ta sama wymowa i `stem`). */
  readonly aliases: ObservableList<string>;
  /** Formy z pełną wymową. */
  readonly forms: ObservableMap<string, string>;
  /** @internal */ readonly atom: Atom;
  /** @internal */ readonly owner: KokoLexicon;

  /** @internal */
  constructor(owner: KokoLexicon, core: DocCore, key: string, data: Required<Pick<LexiconEntryData, 'stem' | 'verified'>> & { kind: 'ipa' | 'respell'; value: string; note?: string; aliases: string[]; forms: [string, string][] }) {
    this.id = newId('lx');
    this.owner = owner;
    this._key = key;
    this._kind = data.kind;
    this._value = data.value;
    this._stem = data.stem;
    this._note = data.note;
    this._verified = data.verified;
    this.atom = core.atom('entry');
    const notify = (path: string) => (kind: 'insert' | 'remove' | 'update' | 'replace', atom: Atom) =>
      core.change([atom, this.atom], { targetId: this.id, kind, path: ['entries', this.id, path] });
    this.aliases = new ObservableList(core, data.aliases, notify('aliases'));
    this.forms = new ObservableMap(core, data.forms, notify('forms'));
    markRaw(this);
  }

  #set(path: string, apply: () => void): void {
    apply();
    this.owner._core.change([this.atom], { targetId: this.id, kind: 'update', path: ['entries', this.id, path] });
  }

  /** Klucz (zmiana przez `entries.rename`). */
  get key(): string {
    this.atom.track();
    return this._key;
  }

  /** Rodzaj wartości. */
  get kind(): 'ipa' | 'respell' {
    this.atom.track();
    return this._kind;
  }
  set kind(v: 'ipa' | 'respell') {
    if (v !== 'ipa' && v !== 'respell') return;
    this.#set('kind', () => (this._kind = v));
  }

  /** IPA albo pisownia fonetyczna (bez `~`). */
  get value(): string {
    this.atom.track();
    return this._value;
  }
  set value(v: string) {
    this.#set('value', () => (this._value = nfc(v)));
  }

  /** Dopasowanie form odmienionych. */
  get stem(): boolean {
    this.atom.track();
    return this._stem;
  }
  set stem(v: boolean) {
    this.#set('stem', () => (this._stem = !!v));
  }

  /** Notatka (bez wpływu na dźwięk). */
  get note(): string | undefined {
    this.atom.track();
    return this._note;
  }
  set note(v: string | undefined) {
    this.#set('note', () => (this._note = v === undefined || v === '' ? undefined : nfc(v)));
  }

  /** Sprawdzone na słuch (bez wpływu na dźwięk). */
  get verified(): boolean {
    this.atom.track();
    return this._verified;
  }
  set verified(v: boolean) {
    this.#set('verified', () => (this._verified = !!v));
  }

  /** Wpis jako obiekt. */
  toJSON(): LexiconEntryJson {
    const o: LexiconEntryJson = { key: this._key };
    if (this._kind === 'ipa') o.ipa = this._value;
    else o.respell = this._value;
    if (this._stem) o.stem = true;
    const a = this.aliases.raw();
    if (a.length) o.aliases = [...a];
    const f = this.forms.raw();
    if (f.size) o.forms = Object.fromEntries(f);
    if (this._note !== undefined) o.note = this._note;
    if (this._verified) o.verified = true;
    return o;
  }
}

/** Wpisy leksykonu w porządku Unicode kluczy. */
export class LexiconEntries extends ItemCollection<LexiconEntry> implements Collection<LexiconEntry> {
  /** @internal */ readonly owner: KokoLexicon;

  /** @internal */
  constructor(owner: KokoLexicon, core: DocCore) {
    super(core, 'entries');
    this.owner = owner;
  }

  /** Wpis po kluczu, aliasie lub formie (simple case folding). */
  get(word: string): LexiconEntry | undefined {
    this.atom.track();
    const f = foldCase(nfc(word));
    for (const e of this.owner._effectiveRaw()) {
      if (foldCase(e.key) === f || e.aliases.some((a) => foldCase(a) === f) || e.forms.some(([k]) => foldCase(k) === f)) {
        return this.items.find((x) => x._key === e.key);
      }
    }
    return undefined;
  }

  /** Dodaje wpis; kolizja słów (KL005) lub niepoprawne dane (KL004) → `KokoErrors`. */
  add(key: string, data: LexiconEntryData): LexiconEntry | KokoErrors {
    const k = nfc(key);
    const errors: Diagnostic[] = [];
    if (!isValidLexiconWord(k)) errors.push(diag('KL004', { level: 'error', params: { key: k, reason: 'key' } }));
    const hasIpa = typeof data.ipa === 'string';
    const hasRespell = typeof data.respell === 'string';
    if (hasIpa === hasRespell) errors.push(diag('KL004', { level: 'error', params: { key: k, reason: 'ipa/respell' } }));
    const words = [k, ...(data.aliases ?? []), ...Object.keys(data.forms ?? {})].map((w) => nfc(w));
    for (const w of words) if (!isValidLexiconWord(w)) errors.push(diag('KL004', { level: 'error', params: { key: k, word: w } }));
    const taken = this.owner._takenWords();
    for (const w of words) if (taken.has(foldCase(w))) errors.push(diag('KL005', { level: 'error', params: { key: k, word: w } }));
    if (errors.length) return new KokoErrors(errors);
    const entry = new LexiconEntry(this.owner, this.owner._core, k, {
      kind: hasIpa ? 'ipa' : 'respell',
      value: nfc((hasIpa ? data.ipa : data.respell)!),
      stem: !!data.stem,
      verified: !!data.verified,
      ...(data.note ? { note: nfc(data.note) } : {}),
      aliases: (data.aliases ?? []).map(nfc),
      forms: Object.entries(data.forms ?? {}).map(([a, b]) => [nfc(a), nfc(b)] as [string, string]),
    });
    this.items.push(entry);
    this.items.sort((a, b) => compareCodePoints(a._key, b._key));
    this.owner._core.change([this.atom], { targetId: entry.id, kind: 'insert', path: ['entries', entry.id] });
    return entry;
  }

  /** Usuwa wpis. */
  remove(id: string): boolean {
    const i = this.items.findIndex((x) => x.id === id);
    if (i < 0) return false;
    this.items.splice(i, 1);
    this.owner._core.change([this.atom], { targetId: id, kind: 'remove', path: ['entries', id] });
    return true;
  }

  /** Zmienia klucz wpisu (KL004, KL005 → `KokoErrors`). */
  rename(id: string, newKey: string): void | KokoErrors {
    const e = this.items.find((x) => x.id === id);
    if (!e) return new KokoErrors([diag('KL004', { level: 'error', params: { id, reason: 'not-found' } })]);
    const k = nfc(newKey);
    if (!isValidLexiconWord(k)) return new KokoErrors([diag('KL004', { level: 'error', params: { key: k } })]);
    const taken = this.owner._takenWords(e);
    if (taken.has(foldCase(k))) return new KokoErrors([diag('KL005', { level: 'error', params: { key: k, word: k } })]);
    e._key = k;
    this.items.sort((a, b) => compareCodePoints(a._key, b._key));
    this.owner._core.change([this.atom, e.atom], { targetId: id, kind: 'update', path: ['entries', id, 'key'] });
  }
}

/** Opcje `KokoLexicon.parse`. */
export interface LexiconParseOptions {
  /** Nadpisanie konfiguracji dla tego wywołania. */
  config?: CallConfig;
}

/** Opcje spłaszczania (Koko-Lexicon §3). */
export interface FlattenOptions {
  /** Klucze leksykonu odcinka — wpisy serii, które z nimi kolidują, są pomijane w całości. */
  episodeKeys?: Iterable<string>;
  /** Koniec linii (domyślnie LF). */
  lineEnding?: 'lf' | 'crlf';
}

/**
 * Leksykon serii Koko-Lexicon v1 (`koko-lexicon.toml`, specyfikacja API §5).
 * Zapis `toString()` jest kanoniczny; komentarze TOML nie są zachowywane.
 */
export class KokoLexicon implements Observable {
  /** @internal */ readonly _core: DocCore;
  #title: string | undefined;
  #titleAtom: Atom;
  /** Wpisy. */
  readonly entries: LexiconEntries;
  #loadDiagnostics: Diagnostic[] = [];
  #effective: Derived<{ entries: EffectiveLexiconEntry[]; diagnostics: Diagnostic[] }>;
  #diagnostics: Derived<readonly Diagnostic[]>;

  private constructor(call?: CallConfig) {
    this._core = new DocCore(this, call);
    this.#titleAtom = this._core.atom('title');
    this.entries = new LexiconEntries(this, this._core);
    this.#effective = new Derived(this._core, () => this.#computeEffective(), 'effective');
    this.#diagnostics = new Derived(this._core, () => Object.freeze([...this.#loadDiagnostics, ...this.#effective.get().diagnostics]), 'diagnostics');
    markRaw(this);
  }

  /** Tworzy pusty leksykon. */
  static create(opts: { title?: string; config?: CallConfig } = {}): KokoLexicon {
    const lx = new KokoLexicon(opts.config);
    if (opts.title) lx.#title = nfc(opts.title);
    return lx;
  }

  /** Parsuje `koko-lexicon.toml`. KL001/KL002 → `KokoErrors`. */
  static parse(text: string, opts: LexiconParseOptions = {}): KokoLexicon | KokoErrors {
    resolveConfig(opts.config);
    const diags: Diagnostic[] = [];
    let src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
    const normalized = nfc(src);
    if (normalized !== src) diags.push(diag('KF001'));
    src = normalized;
    let data: Record<string, unknown>;
    try {
      data = parseToml(src) as Record<string, unknown>;
    } catch (e) {
      const pos = e instanceof TomlError ? { line: e.line, column: e.column } : undefined;
      const d = diag('KL001', { level: 'error', params: { message: e instanceof Error ? e.message.split('\n')[0]! : String(e) }, ...(pos ? { position: pos } : {}) });
      return new KokoErrors([d], [...diags, d]);
    }
    if (data.format !== 'koko-lexicon' || typeof data.entries !== 'object' || data.entries === null || Array.isArray(data.entries)) {
      const d = diag('KL001', { level: 'error', params: { reason: data.format !== 'koko-lexicon' ? 'format' : 'entries' } });
      return new KokoErrors([d], [...diags, d]);
    }
    const version = data.version;
    if (typeof version !== 'number' && typeof version !== 'bigint') {
      const d = diag('KL001', { level: 'error', params: { reason: 'version' } });
      return new KokoErrors([d], [...diags, d]);
    }
    if (Number(version) !== 1) {
      const d = diag('KL002', { level: 'error', params: { version: Number(version) } });
      return new KokoErrors([d], [...diags, d]);
    }
    for (const k of Object.keys(data)) if (!KNOWN_TOP.has(k)) diags.push(diag('KL003', { params: { field: k } }));

    const lx = new KokoLexicon(opts.config);
    if (typeof data.title === 'string') lx.#title = data.title;
    else if (data.title !== undefined) diags.push(diag('KL004', { params: { field: 'title' } }));

    const raw = data.entries as Record<string, unknown>;
    for (const key of Object.keys(raw)) {
      const v = raw[key];
      if (!isValidLexiconWord(key)) {
        diags.push(diag('KL004', { params: { key, reason: 'key' } }));
        continue;
      }
      const shape = validateEntryTable(key, v, (code, params) => diags.push(diag(code, { params })));
      if (!shape) continue;
      const entry = new LexiconEntry(lx, lx._core, key, {
        kind: shape.kind,
        value: shape.value,
        stem: shape.stem,
        verified: shape.verified,
        ...(shape.note !== undefined ? { note: shape.note } : {}),
        aliases: shape.aliases,
        forms: shape.forms,
      });
      lx.entries.items.push(entry);
    }
    lx.entries.items.sort((a, b) => compareCodePoints(a._key, b._key));
    lx.#loadDiagnostics = diags;
    return lx;
  }

  /** Tytuł serii (nie trafia do spłaszczenia). */
  get title(): string | undefined {
    this.#titleAtom.track();
    return this.#title;
  }
  set title(v: string | undefined) {
    this.#title = v === undefined || v === '' ? undefined : nfc(v);
    this._core.change([this.#titleAtom], { targetId: null, kind: 'update', path: ['title'] });
  }

  /** KL003–KL006 (+ KF001). */
  get diagnostics(): readonly Diagnostic[] {
    return this.#diagnostics.get();
  }

  /** Wpisy po walidacji kolizji (KL005), w porządku Unicode kluczy. */
  effectiveEntries(): readonly EffectiveLexiconEntry[] {
    return this.#effective.get().entries;
  }

  /** @internal */
  _effectiveRaw(): readonly EffectiveLexiconEntry[] {
    return this._core.untrack(() => this.#effective.get().entries);
  }

  /** @internal — słowa zajęte przez wpisy (opcjonalnie z pominięciem jednego). */
  _takenWords(except?: LexiconEntry): Set<string> {
    const s = new Set<string>();
    for (const e of this.entries.items) {
      if (e === except) continue;
      s.add(foldCase(e._key));
      for (const a of e.aliases.raw()) s.add(foldCase(a));
      for (const f of e.forms.raw().keys()) s.add(foldCase(f));
    }
    return s;
  }

  #computeEffective(): { entries: EffectiveLexiconEntry[]; diagnostics: Diagnostic[] } {
    const diagnostics: Diagnostic[] = [];
    const sorted = [...this.entries.items].sort((a, b) => compareCodePoints(a._key, b._key));
    const taken = new Map<string, string>();
    const entries: EffectiveLexiconEntry[] = [];
    for (const e of sorted) {
      const fk = foldCase(e._key);
      if (taken.has(fk)) {
        diagnostics.push(diag('KL005', { targetId: e.id, params: { key: e._key, word: e._key, owner: taken.get(fk)! } }));
        continue;
      }
      taken.set(fk, e._key);
      const aliases: string[] = [];
      for (const a of e.aliases.raw()) {
        const f = foldCase(a);
        if (taken.has(f)) {
          diagnostics.push(diag('KL005', { targetId: e.id, params: { key: e._key, word: a, owner: taken.get(f)! } }));
          continue;
        }
        taken.set(f, e._key);
        aliases.push(a);
      }
      const forms: [string, string][] = [];
      for (const [k, v] of e.forms.raw()) {
        const f = foldCase(k);
        if (taken.has(f)) {
          diagnostics.push(diag('KL005', { targetId: e.id, params: { key: e._key, word: k, owner: taken.get(f)! } }));
          continue;
        }
        taken.set(f, e._key);
        forms.push([k, v]);
      }
      if (!e._verified) diagnostics.push(diag('KL006', { targetId: e.id, params: { key: e._key } }));
      entries.push({ key: e._key, kind: e._kind, value: e._value, stem: e._stem, aliases, forms, note: e._note, verified: e._verified });
    }
    return { entries, diagnostics };
  }

  /** Spłaszczenie do bloku `[Koko Lexicon]` (Koko-Lexicon §3). Pusty ciąg, gdy nic nie zostaje. */
  flatten(opts: FlattenOptions = {}): string {
    const lines = flattenLines(this._effectiveRaw(), opts.episodeKeys ?? []);
    return lines.join(opts.lineEnding === 'crlf' ? '\r\n' : '\n');
  }

  /** Grupuje zmiany w jedno zdarzenie. */
  batch(label: string, fn: () => void): void {
    this._core.batch(label, fn);
  }

  /** Rejestruje słuchacza zmian. */
  onChange(listener: ChangeListener): () => void {
    return this._core.onChange(listener);
  }

  /** Kopia przez zapis kanoniczny. */
  clone(): KokoLexicon {
    const r = KokoLexicon.parse(this.toString());
    return r instanceof KokoErrors ? KokoLexicon.create() : r;
  }

  /** Zapis kanoniczny TOML (specyfikacja API §3.2). */
  toString(): string {
    const out: string[] = ['format = "koko-lexicon"', 'version = 1'];
    if (this.#title !== undefined) out.push(`title = ${tomlString(this.#title)}`);
    const sorted = [...this.entries.items].sort((a, b) => compareCodePoints(a._key, b._key));
    for (const e of sorted) {
      out.push('', `[entries.${tomlKey(e._key)}]`);
      out.push(`${e._kind} = ${tomlString(e._value)}`);
      if (e._stem) out.push('stem = true');
      const forms = [...e.forms.raw()].sort(([a], [b]) => compareCodePoints(a, b));
      if (forms.length) out.push(`forms = { ${forms.map(([k, v]) => `${tomlKey(k)} = ${tomlString(v)}`).join(', ')} }`);
      const aliases = e.aliases.raw();
      if (aliases.length) out.push(`aliases = [${aliases.map(tomlString).join(', ')}]`);
      if (e._note !== undefined) out.push(`note = ${tomlString(e._note)}`);
      if (e._verified) out.push('verified = true');
    }
    return out.join('\n') + '\n';
  }

  /** Czy dokument używa atomów pluginu `reactivity`. */
  get reactive(): boolean {
    return this._core.reactive;
  }
}

/** Linie bloku spłaszczonego leksykonu (Koko-Lexicon §3) — współdzielone z Koko-ASS. */
export function flattenLines(effective: readonly EffectiveLexiconEntry[], episodeWords: Iterable<string>): string[] {
  const ep = new Set<string>();
  for (const k of episodeWords) ep.add(foldCase(nfc(k).replace(/\*$/, '').trim()));
  const kept = effective.filter((e) => {
    const words = [e.key, ...e.aliases, ...e.forms.map(([k]) => k)];
    return !words.some((w) => ep.has(foldCase(w)));
  });
  if (kept.length === 0) return [];
  const sorted = [...kept].sort((a, b) => compareCodePoints(a.key, b.key));
  // Jeden wpis = jedna linia (Koko-Lexicon §3): forma prosta albo pełna (tabela TOML w jednej linii).
  return ['; @koko-lexicon-begin', ...sorted.map((e) => formatEntryLine(e.key, e)), '; @koko-lexicon-end'];
}
