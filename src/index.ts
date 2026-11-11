/**
 * Typy wspólne (diagnostyki, `KokoErrors`, zdarzenia zmian) i dostęp do bieżącej konfiguracji.
 *
 * @module @koko-anime/formats
 */
import { currentConfig, resolveConfig, type KokoConfig } from './core/config-store.ts';
import type { Diagnostic } from './core/diagnostics.ts';
import { SPEC_VERSION } from './core/version.ts';

export { KokoErrors, isKokoErrors } from './core/errors.ts';
export type { Diagnostic, DiagnosticCode, ExtensionDiagnosticCode, DiagnosticLevel, DiagnosticSource, DiagnosticParams, SourcePosition, CatalogEntry } from './core/diagnostics.ts';
export { CATALOG as DIAGNOSTIC_CATALOG, hasErrors } from './core/diagnostics.ts';
export type { Change, ChangeKind, ChangeListener, Observable } from './core/doc-core.ts';
export type { KokoConfig, CallConfig, KokoLimits, RegistryConfig, DefaultsConfig, GeneratorInfo, MessageOverride, RuleSetting } from './core/config-store.ts';
export type { CanonicalSegment, TextSegment, IpaSegment, PauseSegment, ProgressEvent, OperationOptions } from './core/plugin-types.ts';
export { SPEC_VERSION, LIB_VERSION, PLUGIN_API_VERSION } from './core/version.ts';

/** Dostęp do bieżącej konfiguracji biblioteki. */
export const kokoFormats = {
  /** Bieżąca, scalona konfiguracja domyślna (tylko do odczytu). */
  get config(): KokoConfig {
    return currentConfig();
  },
  /** Diagnostyki konfiguracji: KF007 (wersja API pluginu), KF011 (duplikaty w capability listowych). */
  get diagnostics(): readonly Diagnostic[] {
    return resolveConfig().diagnostics;
  },
  /** Wersja specyfikacji API. */
  specVersion: SPEC_VERSION,
};
