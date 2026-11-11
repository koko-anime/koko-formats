/**
 * @internal
 * Schematy JSON Koko-Pack (arktype). Nieznane pola są ignorowane (PACK §3).
 */
import { type } from 'arktype';
import type { AudioEntryJson, ManifestJson, RegistryResponse, SignatureJson, SynthesisJson, TimelineJson, TimelineUtteranceJson, VideoJson } from './json-types.ts';

export const Hash = type(/^sha256:[0-9a-f]{64}$/);

export const AudioEntrySchema = type({
  id: 'string',
  path: 'string',
  role: 'string',
  codec: 'string',
  sampleRate: 'number',
  channels: '1 | 2',
  bitrateMode: "'cbr' | 'vbr'",
  'spliceable?': 'boolean',
  encoderDelay: 'number.integer >= 0',
  padding: 'number.integer >= 0',
  offset: 'number >= 0',
  duration: 'number >= 0',
  sha256: Hash,
  'language?': 'string',
  'loudness?': 'number',
});

export const SynthesisSchema = type({
  'engine?': 'string',
  'model?': 'string',
  'modelHash?': 'string',
  'g2p?': 'string',
  'parser?': 'string',
  'voice?': 'string',
  'numbers?': 'number',
});

export const VideoSchema = type({
  'name?': 'string',
  'duration?': 'number',
  'fingerprint?': 'string',
  'btih?': 'string',
  'btmh?': 'string',
  'file?': 'string',
  'size?': 'number',
});

export const ManifestSchema = type({
  format: "'koko-pack'",
  version: 'number',
  profile: "'full' | 'distribution'",
  created: 'string',
  'modified?': 'string',
  generator: { name: 'string', version: 'string' },
  'title?': 'string',
  subtitles: { path: 'string', sha256: Hash, kokoVersion: 'number | null' },
  audio: AudioEntrySchema.array(),
  timeline: { path: 'string', sha256: Hash },
  'fonts?': type({ path: 'string', sha256: Hash }).array(),
  'synthesis?': SynthesisSchema,
  'video?': VideoSchema,
  'extensions?': 'Record<string, unknown>',
});

export const TimelineUtteranceSchema = type({
  'key?': Hash,
  'slot?': { start: 'number', end: 'number' },
  clip: { start: 'number', duration: 'number >= 0' },
  'baseDuration?': 'number',
  'speed?': 'number',
  'gain?': 'number',
  'delay?': 'number',
  'diagnostics?': 'string[]',
  'lines?': 'number[]',
  'text?': 'string',
});

export const TimelineSchema = type({
  version: 'number',
  audio: 'string',
  subtitlesSha256: Hash,
  utterances: TimelineUtteranceSchema.array(),
});

export const SignatureSchema = type({
  alg: 'string',
  keyId: 'string',
  'registry?': 'string',
  publicKey: 'string',
  created: 'string',
  signature: 'string',
});

export const SignaturesSchema = type({
  version: 'number',
  signatures: SignatureSchema.array(),
});

export const RegistryResponseSchema = type({
  creator: 'string',
  'displayName?': 'string',
  keys: type({
    publicKey: 'string',
    'added?': 'string',
    revoked: type({ at: 'string', reason: 'string' }).or('null'),
  }).array(),
});

// Zgodność schematów z udokumentowanymi typami (błąd kompilacji przy rozjeździe).
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Assert<T extends true> = T;
export type _CheckManifest = Assert<Same<typeof ManifestSchema.infer, ManifestJson>>;
export type _CheckAudio = Assert<Same<typeof AudioEntrySchema.infer, AudioEntryJson>>;
export type _CheckTimeline = Assert<Same<typeof TimelineSchema.infer, TimelineJson>>;
export type _CheckSignature = Assert<Same<typeof SignatureSchema.infer, SignatureJson>>;
export type _CheckRegistry = Assert<Same<typeof RegistryResponseSchema.infer, RegistryResponse>>;

export type { ManifestJson, AudioEntryJson, TimelineJson, TimelineUtteranceJson, SignatureJson, SynthesisJson, VideoJson, RegistryResponse };

export { type };
