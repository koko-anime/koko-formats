/**
 * Typy capability pluginów (specyfikacja API §2.3–§2.13).
 * Rdzeń nie zna żadnego środowiska — wszystko, co od niego zależy, dostarczają pluginy.
 */
import type { KokoErrors } from './errors.ts';

/** Segment tekstu przekazywany do G2P. */
export interface TextSegment {
  /** Rodzaj segmentu. */
  t: 'text';
  /** Tekst (NFC, białe znaki zwinięte, bez spacji na brzegach). */
  s: string;
  /** `true`, gdy segment jest doklejony do poprzedniego bez spacji. */
  g?: true;
}

/** Segment z gotowym IPA (z leksykonu lub zakresu `ipa=`), z pominięciem G2P. */
export interface IpaSegment {
  /** Rodzaj segmentu. */
  t: 'ipa';
  /** Zapis IPA. */
  s: string;
  /** `true`, gdy segment jest doklejony do poprzedniego bez spacji. */
  g?: true;
}

/** Pauza (myślnik dialogowy, `{!kk pause=…}`). */
export interface PauseSegment {
  /** Rodzaj segmentu. */
  t: 'pause';
  /** Długość pauzy w ms (sąsiednie pauzy są sumowane). */
  ms: number;
}

/**
 * Segment kanoniczny wypowiedzi (Koko-Pack §6.2) — wchodzi do klucza wypowiedzi.
 *
 * @example
 * ```ts
 * // To {!kk ipa=ɔɲi}Oni{!kk /}, nie ludzie.
 * [{ t: 'text', s: 'To' }, { t: 'ipa', s: 'ɔɲi' }, { t: 'text', s: ', nie ludzie.', g: true }]
 * ```
 */
export type CanonicalSegment = TextSegment | IpaSegment | PauseSegment;

/** Wpis leksykonu po rozwiązaniu (odcinek + seria), przekazywany do G2P. */
export interface ResolvedLexiconEntry {
  /** Słowo lub fraza (bez `*`). */
  key: string;
  /** Dopasowanie także form odmienionych (`rdzeń*`). */
  stem: boolean;
  /** `ipa` — gotowa wymowa; `respell` — pisownia fonetyczna dla G2P. */
  kind: 'ipa' | 'respell';
  /** IPA albo pisownia fonetyczna (bez `~`). */
  value: string;
  /** Pochodzenie wpisu. */
  origin: 'episode' | 'series';
}

/** Leksykon odcinka i serii po rozwiązaniu pierwszeństwa (Koko-ASS §2). */
export interface ResolvedLexicon {
  /** Wpisy w kolejności: odcinek, potem seria (bez wpisów przegrywających z odcinkiem). */
  readonly entries: readonly ResolvedLexiconEntry[];
}

/** Dostęp do plików środowiska (Tauri, Wails, Node…). Ścieżki z separatorem `/`. */
export interface FsCapability {
  /** Czyta plik tekstowy (UTF-8). */
  readText(path: string): Promise<string>;
  /** Czyta plik binarny. */
  readBlob(path: string): Promise<Blob>;
  /** Zapisuje plik tekstowy. */
  writeText?(path: string, text: string): Promise<void>;
  /** Zapisuje plik binarny. */
  writeBlob?(path: string, blob: Blob): Promise<void>;
  /** Czy plik istnieje. */
  exists(path: string): Promise<boolean>;
  /** Łączy ścieżki z separatorem `/`. */
  resolve(base: string, relative: string): string;
}

/** Zamiana tekstu na fonemy (Phonemis) i słownik modelu. */
export interface G2pCapability {
  /** Zamienia segmenty kanoniczne na IPA (jeden ciąg IPA na wypowiedź lub część). */
  toIpa(segments: CanonicalSegment[], lexicon: ResolvedLexicon): Promise<string[]>;
  /** Liczba tokenów fonemów (limit 510, Koko-ASS §4.4). */
  tokenCount(ipa: string): Promise<number>;
  /** Symbole IPA obecne w słowniku modelu (KK101). */
  ipaVocabulary(): Promise<ReadonlySet<string>>;
}

/** Żądanie syntezy jednej wypowiedzi. */
export interface SynthRequest {
  /** IPA części wypowiedzi (po podziale > 510 tokenów); syntezowane i sklejane w jeden klip. */
  ipa: string[];
  /** Voice pack Kokoro. */
  voice: string;
  /** Prędkość (parametr modelu, nie time-stretch), po `round4`. */
  speed: number;
  /** Efektywny `gain` (informacyjnie — biblioteka stosuje go sama). */
  gainDb: number;
  /** Przerwanie syntezy. */
  signal?: AbortSignal;
  /** Postęp (silniki strumieniujące). */
  onProgress?: (e: ProgressEvent) => void;
}

/** Wynik syntezy. */
export interface SynthResult {
  /** PCM mono float32, bez zastosowanego `gain`. */
  pcm: Float32Array;
  /** Częstotliwość próbkowania (Kokoro: 24000). */
  sampleRate: number;
  /** Długość klipu w ms. */
  durationMs: number;
}

/** Tożsamość silnika syntezy — trafia do `manifest.synthesis` i kluczy wypowiedzi. */
export interface SynthesisInfo {
  /** Silnik z wersją, np. `plkokoro 0.4.1`. */
  engine?: string;
  /** Nazwa modelu, np. `Kokoro-82M-PL`. */
  model: string;
  /** Hash pliku modelu (`sha256:…`) — ma pierwszeństwo przed `model` w kluczu. */
  modelHash?: string;
  /** G2P z wersją, np. `Phonemis 1.2.0`. */
  g2p: string;
}

/** Synteza mowy (Kokoro PL). */
export interface SynthCapability {
  /**
   * Synteza wypowiedzi. Zwraca PCM mono **bez** zastosowanego `gainDb`
   * (głośność stosuje biblioteka; `gainDb` jest informacyjne).
   */
  synthesize(req: SynthRequest): Promise<SynthResult>;
  /** Tożsamość modelu i G2P (opcjonalnie — inaczej podaj `synthesis` w opcjach). */
  info?(): Promise<SynthesisInfo>;
}

/** Ustawienia kodowania MP3 (Koko-Pack §4.1). */
export interface Mp3EncodeOptions {
  /** Częstotliwość próbkowania wejścia i wyjścia. */
  sampleRate: number;
  /** Liczba kanałów (lektor: 1). */
  channels: 1 | 2;
  /** Stały bitrate w kbit/s (np. 64 przy 24 kHz → ramka 192 B). */
  bitrateKbps: number;
  /** CBR, bez rezerwuaru bitów (LAME `--nores`), bez CRC — wymagane dla `spliceable`. */
  cbr: true;
  /** Wyłączony rezerwuar bitów (`main_data_begin = 0`). */
  noReservoir: boolean;
  /** Gdy true: zwróć same ramki audio, bez ID3/Xing (używane przy podmianie ramek). */
  rawFrames?: boolean;
}

/** Ustawienia kodowania Opus (Ogg, RFC 7845). */
export interface OpusEncodeOptions {
  /** Częstotliwość próbkowania wejściowego PCM (plugin przelicza na 48 kHz). */
  sampleRate: number;
  /** Bitrate w kbit/s (zalecane 32–48 mono). */
  bitrateKbps: number;
  /** Liczba kanałów. */
  channels: 1 | 2;
}

/** Zdekodowane audio. */
export interface DecodedAudio {
  /** PCM mono **bez** kompensacji opóźnienia enkodera (próbka 0 = pierwsza zdekodowana). */
  pcm: Float32Array;
  /** Częstotliwość próbkowania PCM. */
  sampleRate: number;
  /** Liczba zdekodowanych próbek (na kanał), łącznie z encoderDelay i paddingiem. */
  samples?: number;
}

/** Kodowanie i dekodowanie audio (np. LAME, libopus, ffmpeg). */
export interface EncoderCapability {
  /** Koduje PCM do MP3 (CBR). */
  mp3?(pcm: Float32Array, opts: Mp3EncodeOptions, op?: OperationOptions): Promise<Uint8Array>;
  /** Koduje PCM do Ogg Opus (48 kHz — plugin przelicza częstotliwość). */
  opus?(pcm: Float32Array, opts: OpusEncodeOptions, op?: OperationOptions): Promise<Uint8Array>;
  /** Dekoduje ścieżkę (do ponownego użycia klipów przy przebudowie i kontroli KP012). */
  decode?(bytes: Blob, codec: 'mp3' | 'opus', op?: OperationOptions): Promise<DecodedAudio>;
}

/** Kryptografia: sha256 (synchroniczne) i Ed25519. Gotowy plugin: `nobleCrypto()`. */
export interface CryptoCapability {
  /** Synchroniczne sha256. */
  sha256(data: Uint8Array): Uint8Array;
  /** Podpis Ed25519 (64 B). */
  ed25519Sign(message: Uint8Array, privateKey: Uint8Array): Promise<Uint8Array>;
  /** Weryfikacja podpisu Ed25519. */
  ed25519Verify(message: Uint8Array, signature: Uint8Array, publicKey: Uint8Array): Promise<boolean>;
  /** Klucz publiczny z prywatnego (do zapisu podpisu). */
  ed25519PublicKey?(privateKey: Uint8Array): Promise<Uint8Array>;
}

/** Wpis cache odpowiedzi rejestru twórców (Koko-Pack §8.2). */
export interface RegistryCacheEntry {
  /** Czas pobrania (ISO 8601) — cache ważny do `registry.cacheDays` dni. */
  fetchedAt: string;
  /** Odpowiedź rejestru (200) albo null (404). */
  body: unknown | null;
}

/** Trwały cache odpowiedzi rejestru twórców (np. w ustawieniach aplikacji). */
export interface RegistryCacheCapability {
  /** Odczyt wpisu dla konta. */
  get(keyId: string): Promise<RegistryCacheEntry | undefined>;
  /** Zapis wpisu dla konta. */
  set(keyId: string, entry: RegistryCacheEntry): Promise<void>;
}

/** Obsługa katalogu rozszerzeń `x-<dostawca>/` w paczce (Koko-Pack §7). */
export interface PackExtensionHandler {
  /** Nazwa rozszerzenia, np. `x-acme`. */
  vendor: string;
  /** Wywoływane po otwarciu paczki z plikami katalogu rozszerzenia. */
  onOpen?(files: ReadonlyMap<string, Blob>, manifestEntry: unknown): void | Promise<void>;
}

/**
 * Atom reaktywności (specyfikacja API §2.5): biblioteka wywołuje `track()` przy każdym odczycie
 * publicznego pola i `trigger()` po każdej zmianie.
 */
export interface Atom {
  /** „Ktoś mnie czyta” — framework zapisuje zależność. */
  track(): void;
  /** „Zmieniłem się” — framework odświeża zależnych. */
  trigger(): void;
}

/** Natywna reaktywność frameworka (adaptery `@koko-anime/adapters-*`). */
export interface ReactivityCapability {
  /** Tworzy atom (jeden na element, kolekcję i wartość pochodną). */
  createAtom(debugName?: string): Atom;
  /** Grupuje powiadomienia (używane przez `doc.batch()`). */
  batch?(fn: () => void): void;
  /** Wykonuje funkcję bez rejestrowania zależności (obliczenia wewnętrzne). */
  untrack?<T>(fn: () => T): T;
}

/** Funkcja zgodna z `fetch` (zapytania do rejestru twórców). */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

// ═══════════════════════════════════════════════════════════════ wersja API (§2.6)

/** Wersja API pluginów w postaci `major.minor`. */
export type PluginApiVersion = `${number}.${number}`;

// ═══════════════════════════════════════════════════════════════ postęp i logger (§2.8)

/** Zdarzenie postępu (biblioteka i pluginy). Własne etapy pluginów: `x-…`. */
export interface ProgressEvent {
  /** Etap. */
  stage: 'g2p' | 'synth' | 'measure' | 'decode' | 'encode' | 'pack' | `x-${string}`;
  /** Wykonane jednostki. */
  done: number;
  /** Wszystkie jednostki (brak = nieznane). */
  total?: number;
  /** Wypowiedź, której dotyczy. */
  utteranceId?: string;
  /** Komunikat dla UI. */
  message?: string;
}

/** Wspólne opcje długich operacji pluginów. */
export interface OperationOptions {
  /** Przerwanie. */
  signal?: AbortSignal;
  /** Postęp. */
  onProgress?: (e: ProgressEvent) => void;
}

/** Poziom logu. */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** Wpis logu. */
export interface LogEntry {
  /** Poziom. */
  level: LogLevel;
  /** Źródło: `@koko-anime/formats` albo nazwa pluginu. */
  source: string;
  /** Treść. */
  message: string;
  /** Dane dodatkowe. */
  data?: Readonly<Record<string, unknown>>;
  /** Czas w ms od epoki. */
  time: number;
}

/** Logger używany w kodzie biblioteki i pluginów. */
export interface Logger {
  /** Szczegóły diagnostyczne. */
  debug(message: string, data?: Record<string, unknown>): void;
  /** Informacja. */
  info(message: string, data?: Record<string, unknown>): void;
  /** Ostrzeżenie. */
  warn(message: string, data?: Record<string, unknown>): void;
  /** Błąd. */
  error(message: string, data?: Record<string, unknown>): void;
}

/** Capability `logger` — ujście wpisów (konsola, plik, Sentry…). Brak = cisza. */
export interface LoggerCapability {
  /** Minimalny poziom (domyślnie `info`). */
  level?: LogLevel;
  /** Zapis wpisu (wyjątki są ignorowane). */
  write(entry: LogEntry): void;
}

// ═══════════════════════════════════════════════════════════════ cykl życia (§2.7)

/** Kontekst przekazywany do `setup`. */
export interface PluginContext {
  /** Wersja API biblioteki. */
  readonly api: PluginApiVersion;
  /** Logger ze źródłem = nazwa pluginu. */
  readonly logger: Logger;
  /** Dostęp do capability pojedynczych (także innych pluginów), np. `fs` do wczytania modelu. */
  cap<K extends SingleCapabilityName>(name: K): KokoPlugin[K] | undefined;
  /** Przerywany przy `dispose`. */
  readonly signal: AbortSignal;
}

// ═══════════════════════════════════════════════════════════════ reguły (§2.9)

/** Kod diagnostyki spoza specyfikacji: `X:<dostawca>/<reguła>`. */
export type ExtensionDiagnosticCode = `X:${string}/${string}`;

/** Zgłoszenie z reguły (biblioteka uzupełnia `code`, `title`, `source`). */
export interface RuleReport {
  /** ID elementu (linii). */
  targetId: string;
  /** Parametry. */
  params?: Readonly<Record<string, string | number | boolean>>;
  /** Nadpisanie poziomu dla tego zgłoszenia. */
  level?: 'error' | 'warning' | 'info';
}

/** Wypowiedź widziana przez reguły. */
export interface RuleUtteranceView {
  /** ID wypowiedzi. */
  readonly id: string;
  /** Linie grupy. */
  readonly lineIds: readonly string[];
  /** Start w ms. */
  readonly start: number;
  /** Koniec w ms. */
  readonly end: number;
  /** Segmenty kanoniczne. */
  readonly segments: readonly CanonicalSegment[];
  /** Czytelny tekst mówiony. */
  readonly text: string;
}

/** Widok linii przekazywany regułom (tylko odczyt, po analizie wbudowanej). */
export interface RuleLineView {
  /** ID linii. */
  readonly id: string;
  /** Surowe pole `Text`. */
  readonly text: string;
  /** Styl. */
  readonly style: string;
  /** Aktor (`Name`). */
  readonly actor: string;
  /** Start w ms. */
  readonly start: number;
  /** Koniec w ms. */
  readonly end: number;
  /** Czy linia jest `Comment`. */
  readonly comment: boolean;
  /** Tekst mówiony po analizie (normalizacja, leksykon). */
  readonly spokenText: string;
  /** Wypowiedź, do której należy linia (brak = linia pominięta). */
  readonly utterance?: RuleUtteranceView;
}

/** Ustawienia efektywne widziane przez reguły i normalizatory (jak `KokoAss.settings`). */
export interface RuleSettings {
  /** `[Koko Lektor]`. */
  readonly lektor: Readonly<Record<string, unknown>>;
  /** `[Koko Rules]`. */
  readonly rules: Readonly<Record<string, unknown>>;
}

/** Wspólne pola reguł. */
export interface RuleBase {
  /** Kod `X:<dostawca>/<reguła>`. */
  code: ExtensionDiagnosticCode;
  /** Domyślny poziom. */
  level: 'error' | 'warning' | 'info';
  /** Tytuł (nadpisywalny przez `KokoConfig.messages`). */
  title: string;
  /** Porada. */
  hint?: string;
  /** Domyślnie włączona; wyłączenie: `defineConfig({ rules: { 'X:…': 'off' } })`. */
  enabled?: boolean;
}

/** Reguła per linia — przeliczana tylko dla zmienionych linii; musi być czysta. */
export interface AssLineRule extends RuleBase {
  /** Zakres. */
  scope: 'line';
  /** Sprawdzenie linii. */
  check(line: RuleLineView, settings: RuleSettings): RuleReport[] | void;
}

/** Reguła całego dokumentu — przeliczana przy każdej zmianie. */
export interface AssDocumentRule extends RuleBase {
  /** Zakres. */
  scope: 'document';
  /** Sprawdzenie dokumentu. */
  check(doc: { readonly lines: readonly RuleLineView[]; readonly utterances: readonly RuleUtteranceView[] }, settings: RuleSettings): RuleReport[] | void;
}

/** Reguła Koko-ASS. */
export type AssRule = AssLineRule | AssDocumentRule;

/** Capability listowa `rules`. Wyjątek w `check` → KF009, reguła pomijana dla tego celu. */
export interface RulesCapability {
  /** Reguły Koko-ASS. */
  ass?: AssRule[];
}

// ═══════════════════════════════════════════════════════════════ normalizacja (§2.10)

/** Kontekst normalizatora. */
export interface NormalizeContext {
  /** Język tekstu (BCP 47); Koko-ASS v1: `pl`. */
  readonly language: string;
  /** Ustawienia efektywne. */
  readonly settings: RuleSettings;
  /** ID linii. */
  readonly lineId: string;
}

/** Zamiana wykonana przez normalizator (podgląd w edytorze). */
export interface NormalizeReplacement {
  /** Tekst przed. */
  from: string;
  /** Tekst po. */
  to: string;
  /** Indeks w tekście wejściowym etapu. */
  index: number;
}

/** Diagnostyka zgłoszona przez normalizator. */
export interface NormalizeDiagnostic {
  /** Kod `X:…`. */
  code: ExtensionDiagnosticCode;
  /** Parametry. */
  params?: Readonly<Record<string, string | number | boolean>>;
  /** Poziom (domyślnie `info`). */
  level?: 'error' | 'warning' | 'info';
  /** Tytuł (domyślnie kod). */
  title?: string;
  /** Porada. */
  hint?: string;
}

/** Wynik normalizatora. */
export interface NormalizeResult {
  /** Tekst po etapie. */
  text: string;
  /** Zamiany do podglądu (`LineAnalysis.replacements`). */
  replacements?: NormalizeReplacement[];
  /** Diagnostyki etapu. */
  diagnostics?: NormalizeDiagnostic[];
}

/**
 * Etap normalizacji tekstu mówionego (Koko-ASS §4.2 krok 8): przed leksykonem i G2P,
 * w kolejności `order`. Wbudowane rozwijanie liczb to etap `koko/numbers-pl` (order 500).
 */
export interface TextNormalizer {
  /** `dostawca/nazwa`. */
  id: `${string}/${string}`;
  /** Wersja reguł (całkowita). */
  version: number;
  /** Kolejność (mniejsze najpierw; przy równych — porządek `id`). */
  order: number;
  /** Języki (BCP 47), dla których etap działa; brak = wszystkie. */
  languages?: string[];
  /** `always` — zawsze; `opt-in` — po włączeniu w `KokoConfig.normalizers`. */
  activation: 'always' | 'opt-in';
  /** Synchroniczny i czysty. Wyjątek → KF010, tekst bez zmian. */
  normalize(text: string, ctx: NormalizeContext): NormalizeResult;
}

// ═══════════════════════════════════════════════════════════════ import i eksport (§2.11)

/** Informacja o formacie (`listFormats()`). */
export interface FormatInfo {
  /** Identyfikator. */
  id: string;
  /** Nazwa dla UI. */
  label: string;
  /** Rozszerzenia z kropką. */
  extensions: readonly string[];
  /** Typ MIME. */
  mime?: string;
  /** Czy obsługuje import. */
  canImport: boolean;
  /** Czy obsługuje eksport. */
  canExport: boolean;
  /** Plugin dostarczający (`@koko-anime/formats` dla wbudowanych). */
  plugin: string;
}

/**
 * Koder formatu napisów. `Doc` to `KokoAss` (typ strukturalny, żeby `/plugin` nie zależał od `/ass`).
 * Błąd formatu: zwróć `KokoErrors` (lub tablicę diagnostyk); wyjątek → KF004.
 */
export interface FormatCodec<Doc = any, ExportOptions = Record<string, unknown>> {
  /** `srt`, `vtt`, `studio/scenariusz`… */
  id: string;
  /** Nazwa dla UI. */
  label: string;
  /** Rozszerzenia z kropką. */
  extensions: string[];
  /** Typ MIME. */
  mime?: string;
  /** Import do Koko-ASS. */
  import?(input: string | Blob, opts: OperationOptions & { language?: string }): Promise<Doc | KokoErrors>;
  /** Eksport z Koko-ASS (tylko publiczne API dokumentu). */
  export?(doc: Doc, opts: OperationOptions & ExportOptions): Promise<string | Blob | KokoErrors>;
  /** Wykrywanie formatu po początku treści. */
  sniff?(head: string): boolean;
}

// ═══════════════════════════════════════════════════════════════ cache syntezy (§2.12)

/**
 * Trwały cache PCM adresowany treścią. Klucz: `<utteranceKey>@<speed>` (prędkość po `round4`).
 * Błąd odczytu/zapisu → log `warn`, synteza bez cache (nigdy KF004).
 */
export interface SynthCacheCapability {
  /** Odczyt. */
  get(key: string): Promise<SynthResult | undefined>;
  /** Zapis. */
  set(key: string, value: SynthResult): Promise<void>;
  /** Zachowaj tylko podane klucze. */
  retain?(keys: ReadonlySet<string>): Promise<void>;
  /** Rozmiar w bajtach. */
  size?(): Promise<number>;
  /** Wyczyść. */
  clear?(): Promise<void>;
}

// ═══════════════════════════════════════════════════════════════ signer (§2.13)

/** Klucz dostępny w signerze. */
export interface SignerKeyInfo {
  /** Konto/etykieta. */
  keyId: string;
  /** `koko` — rejestr twórców. */
  registry?: 'koko';
  /** Klucz publiczny Ed25519 (32 B). */
  publicKey: Uint8Array;
  /** Nazwa dla UI. */
  label?: string;
}

/** Podpis Ed25519 bez ujawniania klucza prywatnego bibliotece (keychain, klucz sprzętowy, serwis). */
export interface SignerCapability {
  /** Dostępne klucze. */
  keys(): Promise<SignerKeyInfo[]>;
  /** Podpis wiadomości (64 B). */
  sign(keyId: string, message: Uint8Array, opts?: OperationOptions): Promise<Uint8Array>;
}

// ═══════════════════════════════════════════════════════════════ plugin

/**
 * Plugin: nazwa, wersja API i dowolny zestaw capability. Tworzony przez `definePlugin()`,
 * włączany przez `defineConfig({ plugins })`.
 * Capability pojedyncze: wygrywa ostatni plugin. Capability listowe (`rules`, `normalizers`,
 * `formats`, `packExtensions`): sumowane; kolizja identyfikatorów → KF011, wygrywa ostatni.
 */
export interface KokoPlugin {
  /** Nazwa pluginu (diagnostyki, logi, zastępowanie w `defineConfig`). */
  name: string;
  /** Wersja API pluginów (`'0.4'`). Niezgodna → KF007, plugin pomijany; brak → KF007 `warning`. */
  api: PluginApiVersion;
  /** Wersja pluginu (logi). */
  version?: string;
  /** Inicjalizacja przy pierwszym użyciu capability asynchronicznej; błąd → KF008. */
  setup?(ctx: PluginContext): void | Promise<void>;
  /** Sprzątanie przy `resetConfig`, zastąpieniu pluginu lub `disposePlugins()`. */
  dispose?(): void | Promise<void>;
  /** Pliki. */
  fs?: FsCapability;
  /** Zamiana tekstu na fonemy. */
  g2p?: G2pCapability;
  /** Synteza mowy. */
  synth?: SynthCapability;
  /** Kodowanie i dekodowanie audio. */
  encoder?: EncoderCapability;
  /** Kryptografia. */
  crypto?: CryptoCapability;
  /** Sieć (rejestr twórców). */
  fetch?: FetchLike;
  /** Cache odpowiedzi rejestru. */
  registryCache?: RegistryCacheCapability;
  /** Reaktywność frameworka. */
  reactivity?: ReactivityCapability;
  /** Ujście logów. */
  logger?: LoggerCapability;
  /** Cache syntezy. */
  synthCache?: SynthCacheCapability;
  /** Podpis bez klucza prywatnego w bibliotece. */
  signer?: SignerCapability;
  /** Reguły i diagnostyki (listowe). */
  rules?: RulesCapability;
  /** Etapy normalizacji tekstu (listowe). */
  normalizers?: TextNormalizer[];
  /** Formaty importu/eksportu (listowe). */
  formats?: FormatCodec[];
  /** Obsługa rozszerzeń paczek (listowe). */
  packExtensions?: PackExtensionHandler[];
}

/** Nazwa capability pojedynczej (ostatni plugin wygrywa). */
export type SingleCapabilityName = 'fs' | 'g2p' | 'synth' | 'encoder' | 'crypto' | 'fetch' | 'registryCache' | 'reactivity' | 'logger' | 'synthCache' | 'signer';
/** Nazwa capability listowej (sumowanej ze wszystkich pluginów). */
export type ListCapabilityName = 'rules' | 'normalizers' | 'formats' | 'packExtensions';
/** Nazwa capability pluginu. */
export type CapabilityName = SingleCapabilityName | ListCapabilityName;
