/**
 * Kolekcje obserwowalne (lista i mapa) podpięte pod DocCore.
 */
import type { Atom } from './plugin-types.ts';
import type { DocCore } from './doc-core.ts';

/** Element ze stabilnym ID. */
export interface Identified {
  /** Stabilne ID (tylko w pamięci). */
  readonly id: string;
}

/** Uporządkowana kolekcja elementów ze stabilnymi ID (specyfikacja API §3.4). */
export interface Collection<T extends Identified> extends Iterable<T> {
  /** Liczba elementów. */
  readonly size: number;
  /** Element o danym ID. */
  byId(id: string | null | undefined): T | undefined;
  /** Element na pozycji (ujemne indeksy od końca). */
  at(index: number): T | undefined;
  /** Pozycja elementu o danym ID albo -1. */
  indexOf(id: string): number;
  /** Kopia listy elementów. */
  toArray(): T[];
}

/** Lista wartości prostych z powiadomieniami (np. aliasy wpisu leksykonu). */
export class ObservableList<T> implements Iterable<T> {
  #items: T[];
  #atom: Atom;
  #core: DocCore;
  #notify: (kind: 'insert' | 'remove' | 'update' | 'replace') => void;

  /** @internal */
  constructor(core: DocCore, items: T[], notify: (kind: 'insert' | 'remove' | 'update' | 'replace', atom: Atom) => void) {
    this.#core = core;
    this.#items = [...items];
    this.#atom = core.atom('list');
    this.#notify = (k) => notify(k, this.#atom);
  }

  /** Liczba elementów. */
  get length(): number {
    this.#atom.track();
    return this.#items.length;
  }

  /** Element na pozycji. */
  at(i: number): T | undefined {
    this.#atom.track();
    return this.#items.at(i);
  }

  /** Iteracja po kopii elementów. */
  [Symbol.iterator](): Iterator<T> {
    this.#atom.track();
    return [...this.#items][Symbol.iterator]();
  }

  /** Kopia elementów. */
  toArray(): T[] {
    this.#atom.track();
    return [...this.#items];
  }

  /** Czy lista zawiera wartość. */
  includes(v: T): boolean {
    this.#atom.track();
    return this.#items.includes(v);
  }

  /** Dodaje wartości na końcu. */
  push(...v: T[]): void {
    this.#items.push(...v);
    this.#notify('insert');
  }

  /** Wstawia wartość na pozycję. */
  insert(index: number, v: T): void {
    this.#items.splice(index, 0, v);
    this.#notify('insert');
  }

  /** Zastępuje wartość na pozycji. */
  set(index: number, v: T): void {
    if (index < 0 || index >= this.#items.length) return;
    this.#items[index] = v;
    this.#notify('update');
  }

  /** Usuwa wartość z pozycji. */
  removeAt(index: number): void {
    if (index < 0 || index >= this.#items.length) return;
    this.#items.splice(index, 1);
    this.#notify('remove');
  }

  /** Usuwa pierwsze wystąpienie wartości. */
  remove(v: T): boolean {
    const i = this.#items.indexOf(v);
    if (i < 0) return false;
    this.removeAt(i);
    return true;
  }

  /** Zastępuje całą listę. */
  replaceAll(v: readonly T[]): void {
    this.#items = [...v];
    this.#notify('replace');
  }

  /** @internal — odczyt bez śledzenia. */
  raw(): readonly T[] {
    void this.#core;
    return this.#items;
  }
}

/** Mapa z zachowaniem kolejności wstawiania i powiadomieniami (np. formy wpisu leksykonu). */
export class ObservableMap<K, V> implements Iterable<[K, V]> {
  #map: Map<K, V>;
  #atom: Atom;
  #notify: (kind: 'insert' | 'remove' | 'update' | 'replace') => void;

  /** @internal */
  constructor(core: DocCore, entries: Iterable<[K, V]>, notify: (kind: 'insert' | 'remove' | 'update' | 'replace', atom: Atom) => void) {
    this.#map = new Map(entries);
    this.#atom = core.atom('map');
    this.#notify = (k) => notify(k, this.#atom);
  }

  /** Liczba wpisów. */
  get size(): number {
    this.#atom.track();
    return this.#map.size;
  }

  /** Wartość dla klucza. */
  get(k: K): V | undefined {
    this.#atom.track();
    return this.#map.get(k);
  }

  /** Czy klucz istnieje. */
  has(k: K): boolean {
    this.#atom.track();
    return this.#map.has(k);
  }

  /** Ustawia wartość klucza. */
  set(k: K, v: V): void {
    const had = this.#map.has(k);
    this.#map.set(k, v);
    this.#notify(had ? 'update' : 'insert');
  }

  /** Usuwa klucz. */
  delete(k: K): boolean {
    const ok = this.#map.delete(k);
    if (ok) this.#notify('remove');
    return ok;
  }

  /** Usuwa wszystkie wpisy. */
  clear(): void {
    if (this.#map.size === 0) return;
    this.#map.clear();
    this.#notify('replace');
  }

  /** Klucze w kolejności wstawiania. */
  keys(): K[] {
    this.#atom.track();
    return [...this.#map.keys()];
  }

  /** Pary klucz–wartość. */
  entries(): [K, V][] {
    this.#atom.track();
    return [...this.#map.entries()];
  }

  /** Iteracja po parach. */
  [Symbol.iterator](): Iterator<[K, V]> {
    return this.entries()[Symbol.iterator]();
  }

  /** @internal */
  raw(): ReadonlyMap<K, V> {
    return this.#map;
  }
}

/** Uporządkowana kolekcja elementów z ID (wspólna implementacja {@link Collection}). */
export class ItemCollection<T extends Identified> implements Collection<T> {
  /** @internal */ items: T[] = [];
  /** @internal */ readonly atom: Atom;

  /** @internal */
  constructor(core: DocCore, name: string) {
    this.atom = core.atom(name);
  }

  /** Liczba elementów. */
  get size(): number {
    this.atom.track();
    return this.items.length;
  }

  /** Element o danym ID. */
  byId(id: string | null | undefined): T | undefined {
    this.atom.track();
    if (id == null) return undefined;
    return this.items.find((x) => x.id === id);
  }

  /** Element na pozycji. */
  at(index: number): T | undefined {
    this.atom.track();
    return this.items.at(index);
  }

  /** Pozycja elementu o danym ID albo -1. */
  indexOf(id: string): number {
    this.atom.track();
    return this.items.findIndex((x) => x.id === id);
  }

  /** Kopia listy elementów. */
  toArray(): T[] {
    this.atom.track();
    return [...this.items];
  }

  /** Iteracja po kopii elementów. */
  [Symbol.iterator](): Iterator<T> {
    return this.toArray()[Symbol.iterator]();
  }
}
