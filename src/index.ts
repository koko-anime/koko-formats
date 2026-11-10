/**
 * Typy wspólne (diagnostyki, `KokoErrors`, zdarzenia zmian) i dostęp do bieżącej konfiguracji.
 *
 * @module @koko-anime/formats
 */
import { currentConfig, type KokoConfig } from './core/config-store.ts';

export { KokoErrors, isKokoErrors } from './core/errors.ts';
export type { Diagnostic, DiagnosticCode, DiagnosticLevel, DiagnosticSource, DiagnosticParams, SourcePosition, CatalogEntry } from './core/diagnostics.ts';
export { CATALOG as DIAGNOSTIC_CATALOG, hasErrors } from './core/diagnostics.ts';
export type { Change, ChangeKind, ChangeListener, Observable } from './core/doc-core.ts';
export type { KokoConfig, CallConfig, KokoLimits, RegistryConfig, DefaultsConfig, GeneratorInfo, MessageOverride } from './core/config-store.ts';
export type { CanonicalSegment, TextSegment, IpaSegment, PauseSegment } from './core/plugin-types.ts';

/** Wersja specyfikacji API, którą implementuje pakiet. */
export const SPEC_VERSION = '0.2.0';

/** Dostęp do bieżącej konfiguracji biblioteki. */
export const kokoFormats = {
  /** Bieżąca, scalona konfiguracja domyślna (tylko do odczytu). */
  get config(): KokoConfig {
    return currentConfig();
  },
  /** Wersja specyfikacji API. */
  specVersion: SPEC_VERSION,
};
