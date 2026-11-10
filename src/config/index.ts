/**
 * Ustawienia domyślne biblioteki (specyfikacja API §2.1).
 *
 * `defineConfig()` rejestruje ustawienia, które każdy moduł odczytuje automatycznie przy każdym wywołaniu.
 * Plik konfiguracji importuj jako **pierwszy** w punkcie wejścia aplikacji.
 *
 * @example
 * ```ts
 * // src/koko.config.ts
 * import { defineConfig } from '@koko-anime/formats/config';
 * import { nobleCrypto } from '@koko-anime/formats/crypto-noble';
 * import { svelte } from '@koko-anime/adapters-svelte';
 *
 * export default defineConfig({
 *   plugins: [nobleCrypto(), svelte()],
 *   defaults: { voice: 'pl_lektor_1' },
 *   generator: { name: 'Koko-Editor', version: '0.4.0' },
 * });
 * ```
 *
 * @module @koko-anime/formats/config
 */
import { registerConfig, type KokoConfig } from '../core/config-store.ts';

export type { KokoConfig, CallConfig, KokoLimits, RegistryConfig, DefaultsConfig, GeneratorInfo, MessageOverride } from '../core/config-store.ts';
export { resetConfig } from '../core/config-store.ts';

/**
 * Rejestruje ustawienia domyślne i zwraca przekazany obiekt.
 * Każdy moduł biblioteki odczytuje je automatycznie przy każdym wywołaniu.
 * Do nadpisań pojedynczego wywołania używaj zwykłego obiektu (`{ config: {...} }`), nie `defineConfig`.
 */
export function defineConfig<C extends KokoConfig>(config: C): C {
  registerConfig(config);
  return config;
}
