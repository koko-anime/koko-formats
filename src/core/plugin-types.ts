/**
 * Typy capability pluginów (specyfikacja API §2.3, §2.5).
 * Rdzeń nie zna żadnego środowiska — wszystko, co od niego zależy, dostarczają pluginy.
 */

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
  mp3?(pcm: Float32Array, opts: Mp3EncodeOptions): Promise<Uint8Array>;
  /** Koduje PCM do Ogg Opus (48 kHz — plugin przelicza częstotliwość). */
  opus?(pcm: Float32Array, opts: OpusEncodeOptions): Promise<Uint8Array>;
  /** Dekoduje ścieżkę (do ponownego użycia klipów przy przebudowie i kontroli KP012). */
  decode?(bytes: Blob, codec: 'mp3' | 'opus'): Promise<DecodedAudio>;
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

/**
 * Plugin: nazwa i dowolny zestaw capability. Tworzony przez `definePlugin()`,
 * włączany przez `defineConfig({ plugins })`. Przy tej samej capability wygrywa ostatni plugin.
 */
export interface KokoPlugin {
  /** Nazwa pluginu (w diagnostykach KF004). */
  name: string;
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
  /** Obsługa rozszerzeń paczek. */
  packExtensions?: PackExtensionHandler[];
}

/** Nazwa capability pluginu. */
export type CapabilityName = Exclude<keyof KokoPlugin, 'name'>;
