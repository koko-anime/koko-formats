/**
 * Wspólny mechanizm dokumentów: powiadomienia `onChange` (§3.3), atomy reaktywności (§2.5),
 * grupowanie zmian (`batch`) i leniwe wartości pochodne.
 */
import { configVersion, resolveConfig, type CallConfig } from './config-store.ts';
import type { Atom, ReactivityCapability } from './plugin-types.ts';

/** Rodzaj zmiany; `replace` — wynik `batch()` albo zastąpienie całości. */
export type ChangeKind = 'insert' | 'remove' | 'update' | 'move' | 'replace';

/** Opis zmiany dokumentu (specyfikacja API §3.3). */
export interface Change {
  /** Dokument główny (`KokoAss`, `KokoLexicon`, `KokoPack`). */
  doc: object;
  /** ID zmienionego elementu; `null` — dokument. */
  targetId: string | null;
  /** Rodzaj zmiany. */
  kind: ChangeKind;
  /** Ścieżka, np. `['events', '<id>', 'text']`; zmiany napisów paczki zaczynają się od `subtitles`. */
  path: readonly string[];
  /** Etykieta grupy zmian (`doc.batch(label, …)`). */
  batch?: string;
}

/** Słuchacz zmian. */
export type ChangeListener = (change: Change) => void;

/** Dokument z powiadomieniami o zmianach. */
export interface Observable {
  /** Rejestruje słuchacza; zwraca funkcję wyrejestrowującą. */
  onChange(listener: ChangeListener): () => void;
}

const NOOP_ATOM: Atom = Object.freeze({ track() {}, trigger() {} });

let idCounter = 0;
/** @internal Nieprzezroczyste ID unikalne w procesie (§3.4). */
export function newId(prefix: string): string {
  idCounter++;
  return `${prefix}${idCounter.toString(36)}`;
}

/** @internal */
export class DocCore {
  readonly listeners = new Set<ChangeListener>();
  readonly parents: DocCore[] = [];
  readonly rx: ReactivityCapability | undefined;
  readonly createdAtConfigVersion: number;
  doc: object;
  /** Wersja treści — rośnie przy każdej zmianie (unieważnia wartości pochodne). */
  version = 0;
  private batchDepth = 0;
  private batchLabel: string | undefined;
  private batchChanged = false;
  private pending = new Set<Atom>();
  private derived = new Set<Derived<unknown>>();
  readonly docAtom: Atom;

  constructor(doc: object, call?: CallConfig) {
    this.doc = doc;
    this.rx = resolveConfig(call).cap('reactivity');
    this.createdAtConfigVersion = configVersion();
    this.docAtom = this.atom('doc');
  }

  get reactive(): boolean {
    return this.rx !== undefined;
  }

  atom(name?: string): Atom {
    if (!this.rx) return NOOP_ATOM;
    try {
      return this.rx.createAtom(name);
    } catch {
      return NOOP_ATOM;
    }
  }

  untrack<T>(fn: () => T): T {
    return this.rx?.untrack ? this.rx.untrack(fn) : fn();
  }

  registerDerived(d: Derived<unknown>): void {
    this.derived.add(d);
  }

  unregisterDerived(d: Derived<unknown>): void {
    this.derived.delete(d);
  }

  onChange(listener: ChangeListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Zgłasza zmianę: unieważnia wartości pochodne, wywołuje atomy, potem `onChange` (§2.5 p. 3). */
  change(atoms: readonly Atom[], change: Omit<Change, 'doc'>): void {
    this.version++;
    const toTrigger: Atom[] = [...atoms, this.docAtom];
    for (const d of this.derived) {
      if (d.invalidate()) toTrigger.push(d.atom);
    }
    this.trigger(toTrigger);
    this.emit({ ...change, doc: this.doc });
  }

  private trigger(atoms: readonly Atom[]): void {
    if (this.batchDepth > 0) {
      for (const a of atoms) this.pending.add(a);
      return;
    }
    for (const a of new Set(atoms)) a.trigger();
  }

  private emit(change: Change): void {
    if (this.batchDepth > 0) {
      this.batchChanged = true;
      return;
    }
    for (const l of [...this.listeners]) {
      try {
        l(change);
      } catch {
        // Listener aplikacji nie może przerwać biblioteki.
      }
    }
    for (const p of this.parents) p.childChanged(change);
  }

  /** Zmiana w dokumencie podrzędnym (np. `pack.subtitles`) — propagowana z prefiksem ścieżki. */
  childChanged(change: Change): void {
    this.version++;
    const toTrigger: Atom[] = [this.docAtom];
    for (const d of this.derived) if (d.invalidate()) toTrigger.push(d.atom);
    this.trigger(toTrigger);
    this.emit({ ...change, doc: this.doc, path: ['subtitles', ...change.path] });
  }

  attachChild(child: DocCore): void {
    child.parents.push(this);
  }

  batch(label: string, fn: () => void): void {
    const run = () => {
      this.batchDepth++;
      if (this.batchDepth === 1) {
        this.batchLabel = label;
        this.batchChanged = false;
      }
      try {
        fn();
      } finally {
        this.batchDepth--;
        if (this.batchDepth === 0) this.flushBatch();
      }
    };
    if (this.rx?.batch && this.batchDepth === 0) this.rx.batch(run);
    else run();
  }

  private flushBatch(): void {
    const atoms = [...this.pending];
    this.pending.clear();
    for (const a of atoms) a.trigger();
    if (this.batchChanged) {
      this.batchChanged = false;
      const change: Change = { doc: this.doc, targetId: null, kind: 'replace', path: [] };
      if (this.batchLabel !== undefined) change.batch = this.batchLabel;
      this.emit(change);
    }
  }
}

/** @internal Leniwa wartość pochodna z własnym atomem (§2.5 p. 2). */
export class Derived<T> {
  readonly atom: Atom;
  private value: T | undefined;
  private valid = false;
  private computing = false;

  constructor(
    private readonly core: DocCore,
    private readonly compute: () => T,
    name?: string,
  ) {
    this.atom = core.atom(name);
    core.registerDerived(this as Derived<unknown>);
  }

  get(): T {
    this.atom.track();
    if (!this.valid) {
      if (this.computing) throw new Error('Cykliczna zależność wartości pochodnej');
      this.computing = true;
      try {
        this.value = this.core.untrack(this.compute);
        this.valid = true;
      } finally {
        this.computing = false;
      }
    }
    return this.value as T;
  }

  /** Zwraca wartość bez śledzenia i bez obliczania, jeśli jest nieaktualna. */
  peek(): T | undefined {
    return this.valid ? this.value : undefined;
  }

  /** Unieważnia; zwraca true, gdy wartość była obliczona (trzeba wywołać atom). */
  invalidate(): boolean {
    const was = this.valid;
    this.valid = false;
    this.value = undefined;
    return was;
  }

  dispose(): void {
    this.core.unregisterDerived(this as Derived<unknown>);
  }
}

/** @internal Oznacza obiekt tak, by Vue nie opakował go w `reactive()` (§2.5 p. 6). */
export function markRaw<T extends object>(obj: T): T {
  Object.defineProperty(obj, '__v_skip', { value: true, enumerable: false, configurable: true });
  return obj;
}
