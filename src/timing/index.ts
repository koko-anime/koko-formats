/**
 * Dopasowanie czasowe (Koko-ASS §4.6) i dopasowanie wypowiedzi do osi czasu (Koko-Pack §6.3).
 *
 * Czyste funkcje — długości klipów dostarcza callback (synteza), więc można je testować bez modelu.
 *
 * @module @koko-anime/formats/timing
 */
export { fitUtterances, fitOne, slotEndOf, reconcileTimeline } from './timing.ts';
export type {
  FitInput,
  FitResult,
  FitSettings,
  FitOptions,
  Measure,
  TimelineUtterance,
  ReconcileInput,
  ReconcileDecision,
  ReconcileOptions,
  ReconcileState,
} from './timing.ts';
