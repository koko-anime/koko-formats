/**
 * Wspólny magazyn ustawień domyślnych (specyfikacja API §2.1–§2.3) i środowisko uruchomieniowe pluginów
 * (§2.6–§2.8): zgodność wersji API, leniwy `setup()`, `dispose()`, capability listowe i logger.
 * Leży na `globalThis` pod `Symbol.for(...)`, więc działa też przy zduplikowanych kopiach pakietu.
 */
import { diag, type Diagnostic, type DiagnosticLevel } from './diagnostics.ts';
import { KokoErrors } from './errors.ts';
import type {
  AssRule,
  FormatCodec,
  KokoPlugin,
  ListCapabilityName,
  LogEntry,
  Logger,
  LoggerCapability,
  LogLevel,
  PackExtensionHandler,
  PluginContext,
  SingleCapabilityName,
  TextNormalizer,
} from './plugin-types.ts';
import { LIB_VERSION, PLUGIN_API_VERSION } from './version.ts';

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

/** Ustawienie reguły pluginu: `off`, `on` (poziom z reguły) albo wymuszony poziom. */
export type RuleSetting = 'on' | 'off' | DiagnosticLevel;

/**
 * Ustawienia biblioteki (specyfikacja API §2.1). Rejestrowane przez `defineConfig()`
 * i odczytywane automatycznie przez każdy moduł przy każdym wywołaniu.
 */
export interface KokoConfig {
  /** Pluginy; przy tej samej capability pojedynczej wygrywa ostatni. Plugin o tej samej nazwie zastępuje wcześniejszy. */
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
  /** Włączanie/wyłączanie reguł pluginów po kodzie, np. `{ 'X:studio/wielokropek': 'off' }` (§2.9). */
  rules?: Partial<Record<string, RuleSetting>>;
  /** Włączanie etapów `opt-in` i wyłączanie etapów normalizacji po `id`, np. `{ 'studio/skroty': 'on' }` (§2.10). */
  normalizers?: Partial<Record<string, 'on' | 'off'>>;
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

/** @internal Element capability listowej z nazwą pluginu. */
export interface ListItem<T> {
  readonly owner: string;
  readonly item: T;
}

/** @internal */
export interface ListCapabilities {
  rules: AssRule;
  normalizers: TextNormalizer;
  formats: FormatCodec;
  packExtensions: PackExtensionHandler;
}

/** @internal */
export interface ResolvedConfig {
  readonly plugins: readonly KokoPlugin[];
  readonly registry: Required<RegistryConfig> | undefined;
  readonly defaults: DefaultsConfig;
  readonly generator: GeneratorInfo;
  readonly limits: Required<KokoLimits>;
  readonly messages: Partial<Record<string, MessageOverride>>;
  readonly rules: Partial<Record<string, RuleSetting>>;
  readonly normalizers: Partial<Record<string, 'on' | 'off'>>;
  /** Logger biblioteki (ujście: capability `logger`). */
  readonly logger: Logger;
  /** KF007 (wersja API) i KF011 (duplikaty w capability listowych). */
  readonly diagnostics: readonly Diagnostic[];
  /** Capability z ostatniego aktywnego pluginu, który ją dostarcza (z leniwym `setup`). */
  cap<K extends SingleCapabilityName>(name: K): NonNullable<KokoPlugin[K]> | undefined;
  /** Nazwa pluginu dostarczającego capability. */
  capOwner(name: SingleCapabilityName): string | undefined;
  /** Capability listowa: elementy ze wszystkich aktywnych pluginów, bez duplikatów (wygrywa ostatni). */
  list<K extends ListCapabilityName>(name: K): readonly ListItem<ListCapabilities[K]>[];
}

// ------------------------------------------------------------------ magazyn

const STORE_KEY = Symbol.for('@koko-anime/formats/config');

interface PluginState {
  status: 'pending' | 'ready' | 'failed';
  promise: Promise<void>;
  error?: unknown;
  controller: AbortController;
}

interface Store {
  configs: KokoConfig[];
  version: number;
  merged: KokoConfig | null;
  states?: WeakMap<KokoPlugin, PluginState>;
  wrappers?: WeakMap<KokoPlugin, Map<string, unknown>>;
  stateVersion?: number;
  resolved?: { key: string; value: ResolvedConfig } | null;
}

function store(): Store & Required<Pick<Store, 'states' | 'wrappers' | 'stateVersion'>> {
  const g = globalThis as unknown as Record<symbol, Store | undefined>;
  let s = g[STORE_KEY];
  if (!s) {
    s = { configs: [], version: 0, merged: null };
    g[STORE_KEY] = s;
  }
  s.states ??= new WeakMap();
  s.wrappers ??= new WeakMap();
  s.stateVersion ??= 0;
  return s as never;
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

function invalidate(s: Store): void {
  s.version++;
  s.merged = null;
  s.resolved = null;
}

/** @internal Rejestruje ustawienia domyślne (scalane z poprzednimi). Plugin o tej samej nazwie zastępuje wcześniejszy. */
export function registerConfig(config: KokoConfig): void {
  const s = store();
  const incoming = config.plugins ?? [];
  const names = new Set(incoming.map((p) => p?.name));
  for (let i = 0; i < s.configs.length; i++) {
    const c = s.configs[i]!;
    if (!c.plugins?.some((p) => names.has(p.name))) continue;
    const kept: KokoPlugin[] = [];
    for (const p of c.plugins) {
      if (names.has(p.name) && !incoming.includes(p)) void disposePlugin(p);
      else kept.push(p);
    }
    s.configs[i] = { ...c, plugins: kept };
  }
  s.configs.push(config.plugins ? { ...config, plugins: [...config.plugins] } : { ...config });
  invalidate(s);
  const cfg = resolveConfig();
  for (const d of cfg.diagnostics)
    if (names.has(String(d.params.plugin))) cfg.logger[d.level === 'error' ? 'error' : 'warn'](`${d.code}: ${d.title}`, { ...d.params });
}

/** Usuwa wszystkie zarejestrowane ustawienia i wywołuje `dispose()` pluginów (bez czekania). */
export function resetConfig(): void {
  const s = store();
  for (const c of s.configs) for (const p of c.plugins ?? []) void disposePlugin(p);
  s.configs = [];
  invalidate(s);
}

/** @internal */
export function configVersion(): number {
  const s = store();
  return s.version * 1_000_003 + s.stateVersion;
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

// ------------------------------------------------------------------ logger

const LEVELS: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

/** @internal Logger z danym źródłem, piszący do capability `logger` (brak = cisza). */
export function makeLogger(source: string, sink: LoggerCapability | undefined): Logger {
  const write = (level: LogLevel, message: string, data?: Record<string, unknown>) => {
    if (!sink || LEVELS[level] < LEVELS[sink.level ?? 'info']) return;
    const entry: LogEntry = { level, source, message, time: Date.now() };
    if (data !== undefined) entry.data = Object.freeze({ ...data });
    try {
      sink.write(entry);
    } catch {
      // Ujście logów nie może przerwać biblioteki.
    }
  };
  return {
    debug: (m, d) => write('debug', m, d),
    info: (m, d) => write('info', m, d),
    warn: (m, d) => write('warn', m, d),
    error: (m, d) => write('error', m, d),
  };
}

// ------------------------------------------------------------------ cykl życia (§2.7)

/** @internal Błąd `setup()` pluginu — wywołujący zamienia go na KF008. */
export class PluginSetupError extends Error {
  constructor(
    readonly plugin: string,
    override readonly cause: unknown,
  ) {
    super(`setup() pluginu ${plugin}: ${String(cause)}`);
  }
}

/** @internal Diagnostyka błędu wywołania capability: KF008 (setup) albo KF004 (wywołanie). */
export function pluginFailure(e: unknown, plugin: string | undefined): Diagnostic {
  if (e instanceof PluginSetupError) return diag('KF008', { params: { plugin: e.plugin, message: String(e.cause) } });
  return diag('KF004', { params: { plugin: plugin ?? '@koko-anime/formats', message: String(e) } });
}

function ensureSetup(p: KokoPlugin): Promise<void> {
  if (!p.setup) return Promise.resolve();
  const s = store();
  const st = s.states.get(p);
  if (st) return st.promise;
  const controller = new AbortController();
  const logger = makeLogger(p.name, resolveConfig().cap('logger'));
  const ctx: PluginContext = {
    api: PLUGIN_API_VERSION,
    logger,
    // Własne capability pluginu bez czekania na setup (inaczej zakleszczenie).
    cap: (name) => (resolveConfig().capOwner(name) === p.name ? p[name] : resolveConfig().cap(name)) as never,
    signal: controller.signal,
  };
  const state: PluginState = { status: 'pending', controller, promise: Promise.resolve() };
  state.promise = (async () => {
    try {
      await p.setup!(ctx);
      state.status = 'ready';
    } catch (e) {
      state.status = 'failed';
      state.error = e;
      s.stateVersion++;
      s.resolved = null;
      logger.error('setup() nie powiódł się', { error: String(e) });
      throw new PluginSetupError(p.name, e);
    }
  })();
  // Brak nasłuchującego nie może dać „unhandled rejection”.
  state.promise.catch(() => {});
  s.states.set(p, state);
  return state.promise;
}

async function disposePlugin(p: KokoPlugin): Promise<void> {
  const s = store();
  const st = s.states.get(p);
  s.states.delete(p);
  s.wrappers.delete(p);
  s.stateVersion++;
  s.resolved = null;
  st?.controller.abort();
  // Plugin z setup() sprząta tylko, gdy setup został uruchomiony.
  if (!p.dispose || (p.setup && !st)) return;
  try {
    await st?.promise.catch(() => {});
    await p.dispose();
  } catch (e) {
    makeLogger(p.name, resolveConfig().cap('logger')).warn('dispose() nie powiódł się', { error: String(e) });
  }
}

/** Uruchamia `setup()` pluginów z góry (np. „Ładowanie modelu…”); bez argumentu — wszystkich. */
export async function preparePlugins(capabilities?: SingleCapabilityName[]): Promise<void | KokoErrors> {
  const cfg = resolveConfig();
  const targets = new Set<KokoPlugin>();
  if (capabilities) {
    for (const c of capabilities) {
      const owner = cfg.capOwner(c);
      const p = cfg.plugins.find((x) => x.name === owner);
      if (p) targets.add(p);
    }
  } else for (const p of cfg.plugins) targets.add(p);
  const errors: Diagnostic[] = [];
  for (const p of targets) {
    try {
      await ensureSetup(p);
    } catch (e) {
      errors.push(pluginFailure(e, p.name));
    }
  }
  if (errors.length) return new KokoErrors(errors);
}

/** Wywołuje `dispose()` wszystkich pluginów bieżącej konfiguracji; kolejne użycie ponownie wywoła `setup()`. */
export async function disposePlugins(): Promise<void> {
  const plugins = currentConfig().plugins ?? [];
  await Promise.all(plugins.map((p) => disposePlugin(p)));
}

/** Ponawia `setup()` pluginu po błędzie (KF008). */
export async function retryPlugin(name: string): Promise<void | KokoErrors> {
  const p = [...(currentConfig().plugins ?? [])].reverse().find((x) => x.name === name);
  if (!p) return new KokoErrors([diag('KF002', { level: 'error', params: { plugin: name } })]);
  const s = store();
  const st = s.states.get(p);
  if (st?.status === 'failed') {
    s.states.delete(p);
    s.stateVersion++;
    s.resolved = null;
  }
  try {
    await ensureSetup(p);
  } catch (e) {
    return new KokoErrors([pluginFailure(e, p.name)]);
  }
}

// Metody synchroniczne — wywoływane bez czekania na setup().
const SYNC_METHODS: Partial<Record<SingleCapabilityName, readonly string[]>> = { crypto: ['sha256'], fs: ['resolve'] };
// Capability synchroniczne w całości — bez opakowania.
const UNWRAPPED: ReadonlySet<SingleCapabilityName> = new Set(['reactivity', 'logger']);

function wrapCapability(p: KokoPlugin, name: SingleCapabilityName, value: unknown): unknown {
  if (!p.setup || UNWRAPPED.has(name) || value === undefined) return value;
  const s = store();
  let m = s.wrappers.get(p);
  if (!m) s.wrappers.set(p, (m = new Map()));
  if (m.has(name)) return m.get(name);
  let wrapped: unknown;
  if (typeof value === 'function') {
    const f = value as (...a: unknown[]) => Promise<unknown>;
    wrapped = async (...a: unknown[]) => {
      await ensureSetup(p);
      return f(...a);
    };
  } else {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    const sync = SYNC_METHODS[name] ?? [];
    const proto = Object.getPrototypeOf(src) as object | null;
    const inherited = proto && proto !== Object.prototype ? Object.getOwnPropertyNames(proto) : [];
    for (const key of Object.keys(src).concat(inherited)) {
      if (key === 'constructor' || key in out) continue;
      const v = src[key];
      if (typeof v !== 'function') {
        out[key] = v;
        continue;
      }
      const fn = v as (...a: unknown[]) => unknown;
      out[key] = sync.includes(key)
        ? fn.bind(src)
        : async (...a: unknown[]) => {
            await ensureSetup(p);
            return fn.apply(src, a);
          };
    }
    wrapped = out;
  }
  m.set(name, wrapped);
  return wrapped;
}

// ------------------------------------------------------------------ rozstrzyganie

const DEFAULT_LIMITS: Required<KokoLimits> = {
  jsonMaxBytes: 64 * 1024 * 1024,
  maxCompressionRatio: 100,
  timelineMaxBytes: 64 * 1024 * 1024,
  cacheMaxBytes: 512 * 1024 * 1024,
};

const LIST_ID: { [K in ListCapabilityName]: (x: ListCapabilities[K]) => string } = {
  rules: (r) => r.code,
  normalizers: (n) => n.id,
  formats: (f) => f.id,
  packExtensions: (h) => h.vendor,
};

function listItems<K extends ListCapabilityName>(p: KokoPlugin, name: K): ListCapabilities[K][] {
  if (name === 'rules') return [...(p.rules?.ass ?? [])] as never;
  return [...((p[name] as ListCapabilities[K][] | undefined) ?? [])];
}

/** @internal Scala ustawienia domyślne z nadpisaniem wywołania (§2.2). */
export function resolveConfig(call?: CallConfig): ResolvedConfig {
  const s = store();
  const cacheKey = `${s.version}:${s.stateVersion}`;
  if (!call && s.resolved?.key === cacheKey) return s.resolved.value;

  const base = currentConfig();
  let merged = base as Record<string, unknown>;
  if (call) {
    const { replacePlugins, ...rest } = call;
    const basePlugins = replacePlugins ? [] : (base.plugins ?? []);
    merged = deepMerge({ ...base, plugins: basePlugins }, rest as Record<string, unknown>);
  }
  const cfg = merged as KokoConfig;
  const diagnostics: Diagnostic[] = [];
  const active: KokoPlugin[] = [];
  for (const p of cfg.plugins ?? []) {
    if (!p || typeof p !== 'object') continue;
    const api = (p as { api?: unknown }).api;
    if (api === undefined) {
      diagnostics.push(diag('KF007', { level: 'warning', params: { plugin: p.name, api: '0.3', expected: PLUGIN_API_VERSION } }));
    } else if (api !== PLUGIN_API_VERSION) {
      diagnostics.push(diag('KF007', { params: { plugin: p.name, api: String(api), expected: PLUGIN_API_VERSION } }));
      continue;
    }
    if (s.states.get(p)?.status === 'failed') continue;
    active.push(p);
  }
  const plugins = Object.freeze(active);

  const single = new Map<string, { plugin: KokoPlugin; value: unknown } | null>();
  const lookup = (name: SingleCapabilityName) => {
    if (!single.has(name)) {
      let found: { plugin: KokoPlugin; value: unknown } | null = null;
      for (let i = plugins.length - 1; i >= 0; i--) {
        const p = plugins[i]!;
        if (p[name] !== undefined) {
          found = { plugin: p, value: p[name] };
          break;
        }
      }
      single.set(name, found);
    }
    return single.get(name) ?? null;
  };

  const lists = new Map<string, readonly ListItem<unknown>[]>();
  const listOf = <K extends ListCapabilityName>(name: K, report: boolean): readonly ListItem<ListCapabilities[K]>[] => {
    if (!lists.has(name)) {
      const byId = new Map<string, ListItem<ListCapabilities[K]>>();
      for (const p of plugins) {
        for (const item of listItems(p, name)) {
          const id = LIST_ID[name](item as never);
          const prev = byId.get(id);
          if (prev && report) diagnostics.push(diag('KF011', { params: { capability: name, id, plugin: p.name, previous: prev.owner } }));
          byId.delete(id);
          byId.set(id, { owner: p.name, item });
        }
      }
      lists.set(name, Object.freeze([...byId.values()]));
    }
    return lists.get(name) as readonly ListItem<ListCapabilities[K]>[];
  };
  // KF011 zbierane od razu, żeby `diagnostics` było kompletne.
  for (const n of ['rules', 'normalizers', 'formats', 'packExtensions'] as const) listOf(n, true);

  const loggerCap = lookup('logger')?.value as LoggerCapability | undefined;
  const resolved: ResolvedConfig = {
    plugins,
    registry: cfg.registry ? { url: cfg.registry.url, cacheDays: cfg.registry.cacheDays ?? 7 } : undefined,
    defaults: { ...(cfg.defaults ?? {}) },
    generator: cfg.generator ?? { name: '@koko-anime/formats', version: LIB_VERSION },
    limits: { ...DEFAULT_LIMITS, ...(cfg.limits ?? {}) },
    messages: cfg.messages ?? {},
    rules: cfg.rules ?? {},
    normalizers: cfg.normalizers ?? {},
    logger: makeLogger('@koko-anime/formats', loggerCap),
    diagnostics: Object.freeze(diagnostics),
    cap: (name) => {
      const f = lookup(name);
      return (f ? wrapCapability(f.plugin, name, f.value) : undefined) as never;
    },
    capOwner: (name) => lookup(name)?.plugin.name,
    list: (name) => listOf(name, false),
  };
  if (!call) s.resolved = { key: cacheKey, value: resolved };
  return resolved;
}
