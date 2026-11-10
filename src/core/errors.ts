import type { Diagnostic } from './diagnostics.ts';

/**
 * Wynik odrzucenia (specyfikacja API §3.1). Biblioteka nigdy nie rzuca wyjątków —
 * zamiast tego zwraca `KokoErrors`, sprawdzane przez `instanceof`.
 *
 * Elementy tablicy: diagnostyki `error`, które spowodowały odrzucenie.
 * `all`: wszystkie diagnostyki zebrane do momentu odrzucenia.
 *
 * @example
 * ```ts
 * const doc = KokoAss.parse(text);
 * if (doc instanceof KokoErrors) {
 *   console.log(doc.summary);
 *   return;
 * }
 * ```
 */
export class KokoErrors extends Array<Diagnostic> {
  /** @internal */
  static override get [Symbol.species](): ArrayConstructor {
    return Array;
  }

  /** Jednowierszowe podsumowanie (PL), np. `KP001: mimetype … (+2)`. */
  declare readonly summary: string;
  /** Wszystkie diagnostyki zebrane do momentu odrzucenia. */
  declare readonly all: readonly Diagnostic[];

  /**
   * Tworzy wynik odrzucenia.
   *
   * @param errors Diagnostyki, które spowodowały odrzucenie.
   * @param all Wszystkie zebrane diagnostyki (domyślnie `errors`).
   */
  constructor(errors: readonly Diagnostic[], all: readonly Diagnostic[] = errors) {
    super();
    for (const e of errors) this.push(e);
    const first = errors[0];
    const summary = first
      ? `${first.code}: ${first.title}${errors.length > 1 ? ` (+${errors.length - 1})` : ''}`
      : 'Nieznany błąd';
    Object.defineProperty(this, 'summary', { value: summary, enumerable: false });
    Object.defineProperty(this, 'all', { value: Object.freeze([...all]), enumerable: false });
    Object.freeze(this);
  }
}

/** Strażnik typu — odpowiednik `x instanceof KokoErrors`. */
export function isKokoErrors(x: unknown): x is KokoErrors {
  return x instanceof KokoErrors;
}
