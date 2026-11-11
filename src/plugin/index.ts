/**
 * Definicja pluginu i typy capability (specyfikacja API §2.3–§2.13).
 *
 * Plugin dostarcza bibliotece wszystko, co zależy od środowiska: pliki, G2P, syntezę, kodowanie audio,
 * kryptografię, sieć, reaktywność frameworka, logi, cache syntezy i podpis — oraz rozszerzenia:
 * reguły, normalizatory tekstu i formaty importu/eksportu.
 *
 * @example
 * ```ts
 * import { definePlugin } from '@koko-anime/formats/plugin';
 * import { invoke } from '@tauri-apps/api/core';
 *
 * export const tauri = () =>
 *   definePlugin({
 *     name: 'tauri',
 *     api: '0.4',
 *     fs: {
 *       readText: (path) => invoke('read_text', { path }),
 *       readBlob: async (path) => new Blob([await invoke<ArrayBuffer>('read_bytes', { path })]),
 *       exists: (path) => invoke('exists', { path }),
 *       resolve: (base, rel) => `${base}/${rel}`,
 *     },
 *   });
 * ```
 *
 * @module @koko-anime/formats/plugin
 */
import type { KokoPlugin } from '../core/plugin-types.ts';

export type * from '../core/plugin-types.ts';
export { PLUGIN_API_VERSION } from '../core/version.ts';

/** Tylko typowanie — plugin działa dopiero po dodaniu do `defineConfig({ plugins })`. */
export function definePlugin<P extends KokoPlugin>(plugin: P): P {
  return plugin;
}
