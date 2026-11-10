/**
 * Paczka Koko-Pack v1 — napisy, ścieżka lektora i oś czasu w ZIP (specyfikacja API §6).
 *
 * @example
 * ```ts
 * import { KokoPack, KokoErrors } from '@koko-anime/formats/pack';
 *
 * const pack = await KokoPack.open(blob);
 * if (pack instanceof KokoErrors) return;
 *
 * pack.subtitles.events.dialogues[3]!.kk.say = 'Krócej.';
 * const plan = await pack.reconcile();      // co trzeba przeliczyć
 * await pack.rebuild(undefined, { onProgress: (d, t) => console.log(d / t) });
 * const out = await pack.toBlob({ profile: 'distribution' });
 * ```
 *
 * @module @koko-anime/formats/pack
 */
export { KokoPack, AudioTrack, ManifestView, TimelineView, videoFingerprint, MIMETYPE, KOKO_PACK_VERSION } from './koko-pack.ts';
export type {
  PackOpenOptions,
  PackProfile,
  AudioParams,
  SigningKey,
  ToBlobOptions,
  ReconcilePlan,
  ReconcilePlanItem,
  RebuildOptions,
  TrustReport,
  SignatureStatus,
  VideoMatch,
  SignatureReport,
  SynthesisOverride,
} from './koko-pack.ts';
export type * from './json-types.ts';
export { opusInfo, probeAudio } from './audio-info.ts';
export type { TimelineUtterance } from '../timing/timing.ts';
export { KokoErrors } from '../core/errors.ts';
