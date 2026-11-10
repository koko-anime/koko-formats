/**
 * Wspólny magazyn ustawień domyślnych (specyfikacja API §2.1–§2.3).
 * Leży na `globalThis` pod `Symbol.for(...)`, więc działa też przy zduplikowanych kopiach pakietu.
 */
import type { CapabilityName, KokoPlugin } from './plugin-types.ts';

/** Limity bezpieczeństwa przy otwieraniu paczek (Koko-Pack §8). */
export interface KokoLimits {
  /** Maksymalny rozmiar JSON/napisów po rozpakowaniu (domyślnie 64 MiB). */
  jsonMaxBytes?: number;
  /** Maksymalny stosunek kompresji (domyślnie 100). */
  maxCompressionRatio?: number;
  /** Maksymalny rozmiar `timeline.json` (domyślnie 64 MiB). */
  timelineMaxBytes?: number;
  /** Maksymalny rozmiar pliku w `cache/` (domyślnie 512 MiB). */
  cacheMaxBytes?: number;
}

/**
 * Ustawienia biblioteki (specyfikacja API §2.1). Rejestrowane przez `defineConfig()`
 * i odczytywane automatycznie przez każdy moduł przy każdym wywołaniu.
 */
export interface KokoConfig {
  /** Pluginy; przy tej samej capability wygrywa ostatni. */
  plugins?: KokoPlugin[];
  /** Rejestr twórców (Koko-Pack §8.2). */
  registry?: RegistryConfig;
  /** Wartości domyślne. */
  defaults?: DefaultsConfig;
  /** Program zapisujący paczki (`manifest.generator`). */
  generator?: GeneratorInfo;
  /** Limity bezpieczeństwa. */
  limits?: KokoLimits;
  /** Nadpisanie tytułów i porad diagnostyk, np. tłumaczenie: `{ KK202: { title: 'Digits in speech' } }`. */
  messages?: Partial<Record<string, MessageOverride>>;
}

/** Adres rejestru twórców. */
export interface RegistryConfig {
  /** Adres HTTPS rejestru (nigdy z paczki). */
  url: string;
  /** Ważność cache odpowiedzi w dniach (domyślnie 7). */
  cacheDays?: number;
}

/** Wartości domyślne. */
export interface DefaultsConfig {
  /** Głos, gdy brak `Voice` w `[Koko Lektor]`. */
  voice?: string;
}

/** Program zapisujący. */
export interface GeneratorInfo {
  /** Nazwa, np. `Koko-Editor`. */
  name: string;
  /** Wersja programu. */
  version: string;
}

/** Nadpisanie komunikatu diagnostyki. */
export interface MessageOverride {
  /** Tytuł. */
  title?: string;
  /** Porada. */
  hint?: string;
}

/** Nadpisanie konfiguracji dla pojedynczego wywołania (§2.2) — zwykły obiekt. */
export interface CallConfig extends KokoConfig {
  /** Gdy true, pluginy globalne są wyłączone na czas wywołania. */
  replacePlugins?: boolean;
}

/** @internal */
export interface ResolvedConfig {
  readonly plugins: readonly KokoPlugin[];
  readonly registry: Required<RegistryConfig> | undefined;
  readonly defaults: DefaultsConfig;
  readonly generator: GeneratorInfo;
  readonly limits: Required<KokoLimits>;
  readonly messages: Partial<Record<string, MessageOverride>>;
  /** Capability z ostatniego pluginu na liście, który ją dostarcza. */
  cap<K extends CapabilityName>(name: K): NonNullable<KokoPlugin[K]> | undefined;
  /** Nazwa pluginu dostarczającego capability. */
  capOwner(name: CapabilityName): string | undefined;
}

const STORE_KEY = Symbol.for('@koko-anime/formats/config');

interface Store {
  configs: KokoConfig[];
  version: number;
  merged: KokoConfig | null;
}

function store(): Store {
  const g = globalThis as unknown as Record<symbol, Store | undefined>;
  let s = g[STORE_KEY];
  if (!s) {
    s = { configs: [], version: 0, merged: null };
    g[STORE_KEY] = s;
  }
  return s;
}

function isPlainObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x) && Object.getPrototypeOf(x) === Object.prototype;
}

function deepMerge(a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...a };
  for (const [k, v] of Object.entries(b)) {
    if (k === 'plugins') {
      out.plugins = [...((a.plugins as KokoPlugin[] | undefined) ?? []), ...((v as KokoPlugin[] | undefined) ?? [])];
    } else if (isPlainObject(v) && isPlainObject(out[k])) {
      out[k] = deepMerge(out[k] as Record<string, unknown>, v);
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out;
}

/** @internal Rejestruje ustawienia domyślne (scalane z poprzednimi) i zwraca przekazany obiekt. */
export function registerConfig(config: KokoConfig): void {
  const s = store();
  s.configs.push(config);
  s.version++;
  s.merged = null;
}

/** Usuwa wszystkie zarejestrowane ustawienia (do testów). */
export function resetConfig(): void {
  const s = store();
  s.configs = [];
  s.version++;
  s.merged = null;
}

/** @internal */
export function configVersion(): number {
  return store().version;
}

/** Bieżąca, scalona konfiguracja domyślna. */
export function currentConfig(): KokoConfig {
  const s = store();
  if (!s.merged) {
    let m: Record<string, unknown> = {};
    for (const c of s.configs) m = deepMerge(m, c as Record<string, unknown>);
    s.merged = Object.freeze(m) as KokoConfig;
  }
  return s.merged;
}

const DEFAULT_LIMITS: Required<KokoLimits> = {
  jsonMaxBytes: 64 * 1024 * 1024,
  maxCompressionRatio: 100,
  timelineMaxBytes: 64 * 1024 * 1024,
  cacheMaxBytes: 512 * 1024 * 1024,
};

/** @internal Scala ustawienia domyślne z nadpisaniem wywołania (§2.2). */
export function resolveConfig(call?: CallConfig): ResolvedConfig {
  const base = currentConfig();
  let merged = base as Record<string, unknown>;
  if (call) {
    const { replacePlugins, ...rest } = call;
    const basePlugins = replacePlugins ? [] : (base.plugins ?? []);
    merged = deepMerge({ ...base, plugins: basePlugins }, rest as Record<string, unknown>);
  }
  const cfg = merged as KokoConfig;
  const plugins = Object.freeze([...(cfg.plugins ?? [])]);
  const cache = new Map<string, { owner: string; value: unknown } | null>();
  const lookup = (name: CapabilityName) => {
    if (!cache.has(name)) {
      let found: { owner: string; value: unknown } | null = null;
      for (let i = plugins.length - 1; i >= 0; i--) {
        const p = plugins[i]!;
        const v = p[name];
        if (v !== undefined) {
          found = { owner: p.name, value: v };
          break;
        }
      }
      cache.set(name, found);
    }
    return cache.get(name) ?? null;
  };
  return {
    plugins,
    registry: cfg.registry ? { url: cfg.registry.url, cacheDays: cfg.registry.cacheDays ?? 7 } : undefined,
    defaults: { ...(cfg.defaults ?? {}) },
    generator: cfg.generator ?? { name: '@koko-anime/formats', version: '0.3.0' },
    limits: { ...DEFAULT_LIMITS, ...(cfg.limits ?? {}) },
    messages: cfg.messages ?? {},
    cap: (name) => lookup(name)?.value as never,
    capOwner: (name) => lookup(name)?.owner,
  };
}
