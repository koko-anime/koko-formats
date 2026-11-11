/**
 * Typy plików JSON w paczce (Koko-Pack §3–§5, §8). Czasy w ms (liczby całkowite),
 * hashe `sha256:<64 hex>`, nieznane pola są ignorowane przy odczycie.
 */

/** Wpis ścieżki audio w `manifest.audio` (Koko-Pack §4). */
export interface AudioEntryJson {
  /** Unikalny identyfikator, np. `lektor` — używany w `timeline.json`. */
  id: string;
  /** Ścieżka w paczce, np. `audio/lektor.mp3`. */
  path: string;
  /** Rola; v1 obsługuje wyłącznie `lektor`. */
  role: string;
  /** Kodek: `mp3` (domyślny) albo `opus`. */
  codec: string;
  /** Częstotliwość próbkowania (MP3 np. 24000, Opus zawsze 48000). */
  sampleRate: number;
  /** Liczba kanałów (lektor POWINIEN być mono). */
  channels: 1 | 2;
  /** Tryb bitrate. */
  bitrateMode: 'cbr' | 'vbr';
  /** Czy wolno podmieniać ramki (Koko-Pack §4.1). */
  spliceable?: boolean;
  /** Cisza enkodera na początku w próbkach (Opus: pre-skip). */
  encoderDelay: number;
  /** Dopełnienie na końcu w próbkach. */
  padding: number;
  /** Czas napisów pierwszej próbki treści (ms). */
  offset: number;
  /** Długość treści bez delay/padding (ms). */
  duration: number;
  /** Hash pliku. */
  sha256: string;
  /** Język (BCP 47), np. `pl`. */
  language?: string;
  /** Głośność w LUFS (do normalizacji przy odtwarzaniu). */
  loudness?: number;
}

/** Tożsamość syntezy w manifeście (Koko-Pack §3). */
export interface SynthesisJson {
  /** Silnik z wersją. */
  engine?: string;
  /** Nazwa modelu. */
  model?: string;
  /** Hash pliku modelu. */
  modelHash?: string;
  /** G2P z wersją. */
  g2p?: string;
  /** Implementacja parsowania Koko-ASS (wpływa na segmenty). */
  parser?: string;
  /** Efektywny głos. */
  voice?: string;
  /** Wersja reguł liczb (gdy `Numbers = auto`). */
  numbers?: number;
}

/** Wideo, na którym generowano audio (Koko-Pack §3). */
export interface VideoJson {
  /** Nazwa pliku. */
  name?: string;
  /** Długość (ms). */
  duration?: number;
  /** Odcisk pliku (`videoFingerprint`). */
  fingerprint?: string;
  /** Info-hash v1 torrenta. */
  btih?: string;
  /** Info-hash v2 torrenta. */
  btmh?: string;
  /** Ścieżka pliku w torrencie. */
  file?: string;
  /** Rozmiar w bajtach. */
  size?: number;
}

/** Wpis napisów w manifeście. */
export interface ManifestSubtitlesJson {
  /** Zawsze `subtitles.ass`. */
  path: string;
  /** Hash pliku napisów. */
  sha256: string;
  /** `KokoAnime Version` z pliku albo null. */
  kokoVersion: number | null;
}

/** Wpis osi czasu w manifeście. */
export interface FontEntryJson {
  /** Ścieżka `fonts/<plik>`. */
  path: string;
  /** Hash pliku. */
  sha256: string;
}

/** Wpis `manifest.timeline`. */
export interface ManifestTimelineJson {
  /** Zawsze `timeline.json`. */
  path: string;
  /** Hash pliku osi czasu. */
  sha256: string;
}

/** `manifest.json` (Koko-Pack §3). */
export interface ManifestJson {
  /** Stała `koko-pack`. */
  format: 'koko-pack';
  /** Wersja formatu (1). */
  version: number;
  /** Profil paczki. */
  profile: 'full' | 'distribution';
  /** Utworzenie (ISO 8601 UTC). */
  created: string;
  /** Ostatnia zmiana (ISO 8601 UTC). */
  modified?: string;
  /** Program zapisujący. */
  generator: GeneratorJson;
  /** Tytuł (lista ostatnich projektów). */
  title?: string;
  /** Napisy. */
  subtitles: ManifestSubtitlesJson;
  /** Ścieżki audio (dokładnie jedna z rolą `lektor`). */
  audio: AudioEntryJson[];
  /** Oś czasu. */
  timeline: ManifestTimelineJson;
  /** Czcionki z `fonts/` (Koko-Pack §3.1), w porządku Unicode `path`. */
  fonts?: FontEntryJson[];
  /** Tożsamość syntezy. */
  synthesis?: SynthesisJson;
  /** Wideo. */
  video?: VideoJson;
  /** Rozszerzenia `x-<dostawca>`. */
  extensions?: Record<string, unknown>;
}

/** Program zapisujący paczkę. */
export interface GeneratorJson {
  /** Nazwa, np. `Koko-Editor`. */
  name: string;
  /** Wersja programu. */
  version: string;
}

/** Przedział czasu. */
export interface TimeRangeJson {
  /** Początek (ms). */
  start: number;
  /** Koniec (ms). */
  end: number;
}

/** Położenie klipu. */
export interface ClipJson {
  /** Start klipu (`t0`, ms). */
  start: number;
  /** Długość po syntezie (ms). */
  duration: number;
}

/** Wypowiedź w `timeline.json` (Koko-Pack §5); w profilu `distribution` tylko `clip`. */
export interface TimelineUtteranceJson {
  /** Klucz danych wejściowych syntezy. */
  key?: string;
  /** Slot z Koko-ASS §4.6. */
  slot?: TimeRangeJson;
  /** Rzeczywiste położenie klipu. */
  clip: ClipJson;
  /** Długość przy prędkości bazowej (ms). */
  baseDuration?: number;
  /** Prędkość faktycznie użyta. */
  speed?: number;
  /** Efektywny gain (dB). */
  gain?: number;
  /** Opóźnienie względem startu wypowiedzi (ms). */
  delay?: number;
  /** Kody diagnostyk timingu. */
  diagnostics?: string[];
  /** Numery linii przy zapisie (informacyjnie). */
  lines?: number[];
  /** Czytelny tekst mówiony (informacyjnie). */
  text?: string;
}

/** `timeline.json` (Koko-Pack §5). */
export interface TimelineJson {
  /** Wersja (1). */
  version: number;
  /** `id` ścieżki lektora. */
  audio: string;
  /** Hash napisów, z których powstała oś. */
  subtitlesSha256: string;
  /** Wypowiedzi w kolejności czasu. */
  utterances: TimelineUtteranceJson[];
}

/** Podpis w `signatures.json` (Koko-Pack §8.1). */
export interface SignatureJson {
  /** Algorytm (`ed25519`). */
  alg: string;
  /** Nazwa konta w rejestrze albo etykieta. */
  keyId: string;
  /** `koko` — weryfikacja przez rejestr twórców. */
  registry?: string;
  /** Klucz publiczny (base64, 32 B). */
  publicKey: string;
  /** Czas podpisu deklarowany przez podpisującego. */
  created: string;
  /** Podpis (base64, 64 B) bajtów JCS manifestu. */
  signature: string;
}

/** Klucz konta w rejestrze. */
export interface RegistryKeyJson {
  /** Klucz publiczny (base64). */
  publicKey: string;
  /** Dodanie klucza. */
  added?: string;
  /** Wycofanie albo null. */
  revoked: RevocationJson | null;
}

/** Wycofanie klucza w rejestrze. */
export interface RevocationJson {
  /** Czas wycofania (ISO 8601). */
  at: string;
  /** `rotated` albo `compromised`. */
  reason: string;
}

/** Odpowiedź `GET <rejestr>/v1/creators/<keyId>` (Koko-Pack §8.2). */
export interface RegistryResponse {
  /** Nazwa konta. */
  creator: string;
  /** Nazwa wyświetlana. */
  displayName?: string;
  /** Klucze konta. */
  keys: RegistryKeyJson[];
}
