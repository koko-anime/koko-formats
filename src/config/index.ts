/**
 * Ustawienia domyślne biblioteki i cykl życia pluginów (specyfikacja API §2.1, §2.7).
 *
 * `defineConfig()` rejestruje ustawienia, które każdy moduł odczytuje automatycznie przy każdym wywołaniu.
 * Plik konfiguracji importuj jako **pierwszy** w punkcie wejścia aplikacji.
 *
 * @example
 * ```ts
 * // src/koko.config.ts
 * import { defineConfig, preparePlugins } from '@koko-anime/formats/config';
 * import { nobleCrypto } from '@koko-anime/formats/crypto-noble';
 * import { svelte } from '@koko-anime/adapters-svelte';
 *
 * export default defineConfig({
 *   plugins: [nobleCrypto(), svelte()],
 *   defaults: { voice: 'pl_lektor_1' },
 *   generator: { name: 'Koko-Editor', version: '0.4.0' },
 *   rules: { 'X:studio/wielokropek': 'off' },
 * });
 *
 * await preparePlugins(['synth']); // np. pasek „Ładowanie modelu…”
 * ```
 *
 * @module @koko-anime/formats/config
 */
import { registerConfig, type KokoConfig } from '../core/config-store.ts';

export type { KokoConfig, CallConfig, KokoLimits, RegistryConfig, DefaultsConfig, GeneratorInfo, MessageOverride, RuleSetting } from '../core/config-store.ts';
export { resetConfig, preparePlugins, disposePlugins, retryPlugin } from '../core/config-store.ts';

/**
 * Rejestruje ustawienia domyślne i zwraca przekazany obiekt.
 * Każdy moduł biblioteki odczytuje je automatycznie przy każdym wywołaniu.
 * Plugin o nazwie już zarejestrowanej zastępuje poprzedni (który dostaje `dispose()`).
 * Do nadpisań pojedynczego wywołania używaj zwykłego obiektu (`{ config: {...} }`), nie `defineConfig`.
 */
export function defineConfig<C extends KokoConfig>(config: C): C {
  registerConfig(config);
  return config;
}
