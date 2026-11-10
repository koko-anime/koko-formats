/**
 * Rozwijanie liczb z odmianą przez przypadki (Koko-ASS §4.3, wersja reguł 2).
 *
 * @example
 * ```ts
 * import { expandNumbers } from '@koko-anime/formats/numbers';
 *
 * expandNumbers('o 3 kotach').text; // „o trzech kotach”
 * expandNumbers('w 2024 r.').text;  // „w dwa tysiące dwudziestym czwartym roku.”
 * ```
 *
 * @module @koko-anime/formats/numbers
 */
export { expandNumbers, cardinal, ordinal, NUMBERS_RULES_VERSION } from './expand.ts';
export type { Case, Gender, ExpandResult, NumberExpansion } from './expand.ts';
