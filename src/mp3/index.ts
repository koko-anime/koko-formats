/**
 * MP3 Layer III: indeks ramek, kontrola warunków `spliceable` i podmiana ramek (Koko-Pack §4.1).
 *
 * @module @koko-anime/formats/mp3
 */
export { indexFrames, indexFramesSync, checkSpliceable, spliceRange, updateLameCrc, crc16Arc, DECODER_DELAY } from './mp3.ts';
export type { Mp3Index, Mp3Frame, LameInfo, XingInfo, SpliceOptions, SpliceResult } from './mp3.ts';
