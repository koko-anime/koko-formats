/**
 * Leksykon serii Koko-Lexicon v1 (`koko-lexicon.toml`, specyfikacja API §5).
 *
 * @example
 * ```ts
 * import { KokoLexicon } from '@koko-anime/formats/lexicon';
 *
 * const lex = KokoLexicon.parse(toml);
 * if (!(lex instanceof KokoErrors)) {
 *   lex.entries.add('Lakan', { respell: 'Lakan', stem: true, note: 'strateg' });
 *   console.log(lex.flatten()); // blok do [Koko Lexicon]
 * }
 * ```
 *
 * @module @koko-anime/formats/lexicon
 */
export { KokoLexicon, LexiconEntry, LexiconEntries, flattenLines, isValidLexiconWord } from './lexicon.ts';
export type { LexiconEntryData, LexiconEntryJson, EffectiveLexiconEntry, FlattenOptions, LexiconParseOptions } from './lexicon.ts';
export { KokoErrors } from '../core/errors.ts';
