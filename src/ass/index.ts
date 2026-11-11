/**
 * Dokument Koko-ASS v1 — pełny model ASS z warstwą Koko (specyfikacja API §4).
 *
 * @example
 * ```ts
 * import { KokoAss, KokoErrors } from '@koko-anime/formats/ass';
 *
 * const ass = KokoAss.parse(text);
 * if (ass instanceof KokoErrors) throw new Error(ass.summary);
 *
 * const line = ass.events.dialogues[0]!;
 * line.kk.say = 'Zbierają grzyby i się trują.';
 * console.log(line.analysis.spokenText, ass.diagnostics);
 * const out = ass.toString(); // zapis kanoniczny
 * ```
 *
 * @module @koko-anime/formats/ass
 */
export { KokoAss, EventList, Utterance, KOKO_ASS_VERSION, TOKEN_LIMIT, listFormats, sniffFormat } from './koko-ass.ts';
export type { AssParseOptions, AssLoadOptions, CheckOptions, FormatOptions } from './koko-ass.ts';
export {
  AssEvent,
  AssStyle,
  KkView,
  ScriptInfo,
  Settings,
  KokoStyleRule,
  KokoStyleRules,
  EpisodeLexicon,
  EpisodeLexiconItem,
  SourceEntry,
  Sources,
  StyleCollection,
  STYLE_FORMAT,
} from './model.ts';
export type { AssEventData, EventType, KkRange, KkPause, KokoSections, RawSection, SourceData } from './model.ts';
export type { LektorKeys, RulesKeys } from './settings.ts';
export type { LineAnalysis, LineReplacement, SkipReason, UtteranceParams, SynthesisIdentity, EffectiveSettings } from './analysis.ts';
export { canonicalSegments, segmentsText, utteranceKey } from './analysis.ts';
export { formatAssTime, parseAssTime } from './time.ts';
export { KokoErrors } from '../core/errors.ts';
export type { Collection } from '../core/collections.ts';
