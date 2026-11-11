/**
 * Diagnostyki (specyfikacja API §3.5) i katalog domyślnych komunikatów ze specyfikacji formatów.
 */
import { currentConfig } from './config-store.ts';
import type { ExtensionDiagnosticCode } from './plugin-types.ts';

/** Poziom: `error` — wynik wadliwy, `warning` — coś pominięto/poprawiono, `info` — podpowiedź. */
export type DiagnosticLevel = 'error' | 'warning' | 'info';
/** Kod: `KK` Koko-ASS, `KL` Koko-Lexicon, `KP` Koko-Pack, `KF` biblioteka, `X:<dostawca>/<reguła>` pluginy. */
export type DiagnosticCode = `KK${string}` | `KL${string}` | `KP${string}` | `KF${string}` | ExtensionDiagnosticCode;
export type { ExtensionDiagnosticCode };
/** Źródło diagnostyki (wynika z prefiksu kodu). */
export type DiagnosticSource = 'ass' | 'lexicon' | 'pack' | 'library';
/** Parametry diagnostyki, np. `{ from: '3', to: 'trzech' }` dla KK203. */
export type DiagnosticParams = Readonly<Record<string, string | number | boolean>>;

/**
 * Diagnostyka (specyfikacja API §3.5). Tytuł i porada pochodzą z katalogu `DIAGNOSTIC_CATALOG`
 * i można je nadpisać w `KokoConfig.messages`.
 */
export interface Diagnostic {
  /** Kod, np. `KK202`. */
  code: DiagnosticCode;
  /** Poziom. */
  level: DiagnosticLevel;
  /** Tytuł (domyślnie po polsku, ze specyfikacji). */
  title: string;
  /** Porada „jak naprawić”. */
  hint?: string;
  /** Parametry (np. słowo, wartość, wynik rozwinięcia liczby). */
  params: DiagnosticParams;
  /** Format, którego dotyczy. */
  source: DiagnosticSource;
  /** ID elementu (linii, wpisu, stylu…), którego dotyczy. */
  targetId?: string;
  /** Pozycja w tekście wejściowym — tylko dla diagnostyk z parsowania. */
  position?: SourcePosition;
}

/** Pozycja w pliku wejściowym (od 1). */
export interface SourcePosition {
  /** Numer linii. */
  line: number;
  /** Numer kolumny. */
  column: number;
}

/** Wpis katalogu komunikatów. */
export interface CatalogEntry {
  /** Domyślny poziom. */
  level: DiagnosticLevel;
  /** Tytuł. */
  title: string;
  /** Porada. */
  hint?: string;
}

/** Domyślne komunikaty (PL) — eksportowane jako `DIAGNOSTIC_CATALOG`. — tytuły i porady ze specyfikacji Koko-ASS, Koko-Lexicon, Koko-Pack i API. */
export const CATALOG: Readonly<Record<string, CatalogEntry>> = {
  // Koko-ASS §6
  KK001: { level: 'warning', title: 'Nieznany klucz', hint: 'Sprawdź pisownię klucza. Jeśli plik pochodzi z nowszej wersji Koko-Editor, zaktualizuj program.' },
  KK002: { level: 'error', title: 'Nieobsługiwana wersja formatu', hint: 'Zaktualizuj Koko-Editor/Koko-Player albo popraw wartość w [Script Info].' },
  KK003: { level: 'warning', title: 'Błędna składnia adnotacji', hint: 'Popraw blok według składni {!kk klucz=wartość flaga}. Wartości ze spacjami ujmij w "…".' },
  KK004: { level: 'warning', title: 'Niezamknięty zakres', hint: 'Dodaj {!kk /} bezpośrednio po słowie, którego dotyczy zakres.' },
  KK005: { level: 'warning', title: 'say= razem z zakresami', hint: 'Usuń zakresy albo przenieś poprawki wymowy do treści say= (lub do leksykonu).' },
  KK006: { level: 'warning', title: 'Niepoprawna wartość', hint: 'Popraw wartość według tabeli kluczy w specyfikacji (dotyczy też niedozwolonej składni SkipIfMatch).' },
  KK007: { level: 'warning', title: 'Niepoprawny wpis źródła', hint: 'Popraw format btih/btmh, uzupełnij file i size.' },
  KK008: { level: 'info', title: 'Wideo nie pasuje do żadnego źródła', hint: 'Sprawdź, czy otwarto właściwe wydanie.' },
  KK009: { level: 'warning', title: 'Brak pliku leksykonu serii', hint: 'Popraw SeriesLexicon, przywróć plik albo ustaw none.' },
  KK010: { level: 'warning', title: 'Powtórzony wpis w [Koko Lexicon] lub [Koko Sources] (obowiązuje ostatni)', hint: 'Usuń duplikat; w leksykonie słowo i słowo* to ten sam klucz.' },
  KK011: { level: 'warning', title: 'Sprzeczne flagi (read+skip, join+nojoin)', hint: 'Zostaw jedną flagę; obowiązuje read / nojoin.' },
  KK101: { level: 'error', title: 'IPA spoza słownika modelu', hint: 'Zamień symbole na obecne w słowniku modelu albo użyj pisowni fonetycznej (~pisownia / sub=).' },
  KK102: { level: 'info', title: 'Możliwe imię spoza leksykonu', hint: 'Posłuchaj wymowy; jeśli jest zła, dodaj wpis do [Koko Lexicon].' },
  KK201: { level: 'info', title: 'Pusta linia po czyszczeniu', hint: 'Zwykle nic nie trzeba robić. Jeśli linia powinna być czytana, dodaj {!kk say="…"}.' },
  KK202: { level: 'warning', title: 'Cyfry w tekście mówionym', hint: 'Dodaj {!kk say="…"} ze słowną liczbą albo włącz Numbers = auto.' },
  KK203: { level: 'info', title: 'Liczba rozwinięta automatycznie', hint: 'Zwykle nic; zła forma → say=.' },
  KK204: { level: 'warning', title: 'Rozwinięcie niepewne', hint: 'Odsłuchaj; zła forma → say=.' },
  KK301: { level: 'warning', title: 'Różne parametry w grupie', hint: 'Ustaw parametry tylko na pierwszej linii grupy albo usuń join.' },
  KK302: { level: 'warning', title: 'Grupa za długa (> 510 tokenów fonemów)', hint: 'Połącz mniej linii (usuń część flag join) albo skróć tekst przez say=.' },
  KK303: { level: 'warning', title: 'Wypowiedź podzielona na części (> 510 tokenów)', hint: 'Sprawdź intonację na granicach; najlepiej skróć przez say=.' },
  KK401: { level: 'info', title: 'Wymagane przyspieszenie (> 1.15×)', hint: 'Rozważ skrócenie przez say=.' },
  KK402: { level: 'warning', title: 'Wyjście poza slot', hint: 'Skróć tekst przez say= albo podnieś maxspeed dla tej linii.' },
  KK403: { level: 'error', title: 'Zbyt duże opóźnienie (> MaxDelay)', hint: 'Dodaj say= do tej lub poprzedniej linii albo pomiń jedną z nich przez {!kk skip}.' },
  // Koko-Lexicon §4
  KL001: { level: 'warning', title: 'Zły TOML lub brak format/entries', hint: 'Plik pominięty.' },
  KL002: { level: 'warning', title: 'Nieobsługiwana wersja leksykonu', hint: 'Plik pominięty.' },
  KL003: { level: 'warning', title: 'Nieznane pole', hint: 'Pole zignorowane.' },
  KL004: { level: 'warning', title: 'Niepoprawny wpis (ipa+respell lub żadne, zły typ, niedozwolony znak)', hint: 'Wpis, alias lub forma pominięte.' },
  KL005: { level: 'warning', title: 'To samo słowo w kilku wpisach lub pozycjach', hint: 'Słowo zostaje przy pierwszym wpisie.' },
  KL006: { level: 'info', title: 'Wpis bez verified = true', hint: 'Odsłuchaj wymowę i oznacz wpis jako sprawdzony.' },
  // Koko-Pack §9
  KP001: { level: 'error', title: 'mimetype brak / nie pierwszy / skompresowany / zła treść', hint: 'Paczka odrzucona.' },
  KP002: { level: 'error', title: 'Brak lub zły manifest.json', hint: 'Paczka odrzucona.' },
  KP003: { level: 'error', title: 'Nieobsługiwana wersja paczki', hint: 'Zaktualizuj program.' },
  KP004: { level: 'error', title: 'Brak pliku z manifestu', hint: 'Brak napisów/lektora odrzuca paczkę; brak timeline.json unieważnia oś czasu.' },
  KP005: { level: 'warning', title: 'Napisy zmienione poza Koko-Editor', hint: 'Wypowiedzi zostaną dopasowane ponownie (§6.3).' },
  KP006: { level: 'error', title: 'Hash audio niezgodny z manifestem', hint: 'Oś czasu unieważniona.' },
  KP007: { level: 'error', title: 'Niedozwolona ścieżka lub plik w paczce', hint: 'Paczka odrzucona.' },
  KP008: { level: 'warning', title: 'Audio skompresowane (DEFLATE)', hint: 'Brak odtwarzania wprost z archiwum.' },
  KP009: { level: 'warning', title: 'Wideo nie pasuje do manifest.video', hint: 'Sprawdź, czy otwarto właściwe wydanie.' },
  KP010: { level: 'warning', title: 'Konfiguracja syntezy inna niż w paczce', hint: 'Całe audio jest nieaktualne.' },
  KP011: { level: 'error', title: 'Brak wpisu lektor lub więcej niż jeden', hint: 'Paczka odrzucona.' },
  KP012: { level: 'warning', title: 'Parametry audio niezgodne z plikiem', hint: 'Obowiązują wartości z pliku.' },
  KP013: { level: 'error', title: 'Niepoprawny podpis', hint: 'Paczka otwarta jako niezaufana.' },
  KP014: { level: 'info', title: 'Podpis bez rejestru', hint: 'Nazwa autora niezweryfikowana.' },
  KP015: { level: 'warning', title: 'spliceable: true, ale plik nie spełnia warunków', hint: 'Flaga traktowana jak false.' },
  KP016: { level: 'error', title: 'Nieobsługiwany kodek', hint: 'Paczka odrzucona.' },
  KP017: { level: 'error', title: 'Klucz unieważniony w rejestrze', hint: 'Paczka otwarta jako niezaufana.' },
  KP018: { level: 'error', title: 'Klucz nie należy do konta (możliwe podszycie)', hint: 'Paczka otwarta jako niezaufana.' },
  KP019: { level: 'info', title: 'Rejestr nieosiągalny', hint: 'Podpis niezweryfikowany.' },
  KP020: { level: 'warning', title: 'Czcionka nieczytelna, niezgodna z manifestem lub ponad limit', hint: 'Czcionka pominięta; renderer użyje zastępczej.' },
  KP021: { level: 'info', title: 'Krój użyty w napisach nie jest w fonts/', hint: 'Dołącz plik czcionki (setFont), inaczej wygląd zależy od czcionek widza.' },
  KP101: { level: 'info', title: 'Wypowiedzi nowe lub do przeliczenia', hint: 'Zostaną zsyntezowane.' },
  KP102: { level: 'info', title: 'Wypowiedzi przesunięte', hint: 'Klipy zostaną przeniesione bez syntezy.' },
  KP103: { level: 'warning', title: 'Wpisy osierocone', hint: 'Fragmenty zostaną wyciszone.' },
  KP104: { level: 'error', title: 'Zły timeline.json', hint: 'Oś czasu unieważniona.' },
  KP105: { level: 'info', title: 'Paczka distribution otwarta do edycji', hint: 'Wszystkie wypowiedzi są nowe.' },
  KP106: { level: 'info', title: 'Zmieniona głośność wypowiedzi', hint: 'Klip zostanie przebudowany bez dopasowania.' },
  // Biblioteka
  KF001: { level: 'info', title: 'Tekst znormalizowany do NFC' },
  KF002: { level: 'info', title: 'Brak wymaganej capability pluginu', hint: 'Dodaj plugin, który ją dostarcza, do defineConfig({ plugins }).' },
  KF003: { level: 'error', title: 'Paczka nieaktualna', hint: 'Wywołaj rebuild() przed zapisem.' },
  KF004: { level: 'error', title: 'Plugin zgłosił błąd' },
  KF005: { level: 'info', title: 'Operacja przerwana' },
  KF006: { level: 'info', title: 'Dokument nie jest reaktywny', hint: 'Zaimportuj konfigurację z pluginem reaktywności przed utworzeniem dokumentu.' },
  KF007: { level: 'error', title: 'Niezgodna wersja API pluginu', hint: 'Zaktualizuj plugin albo bibliotekę; plugin bez pola api działa jak 0.3 (ostrzeżenie).' },
  KF008: { level: 'error', title: 'Błąd inicjalizacji pluginu', hint: 'Sprawdź log pluginu i wywołaj retryPlugin(nazwa).' },
  KF009: { level: 'warning', title: 'Reguła pluginu zgłosiła wyjątek', hint: 'Reguła pominięta dla tego elementu; zgłoś błąd autorowi pluginu.' },
  KF010: { level: 'warning', title: 'Normalizator pluginu zgłosił wyjątek', hint: 'Tekst pozostawiony bez zmian przez ten etap.' },
  KF011: { level: 'warning', title: 'Zduplikowany identyfikator w pluginach', hint: 'Obowiązuje element z ostatniego pluginu.' },
  KF012: { level: 'error', title: 'Nieznany format importu/eksportu', hint: 'Sprawdź listFormats() i pluginy z capability formats.' },
};

/** @internal */
export interface DiagOptions {
  level?: DiagnosticLevel;
  params?: Record<string, string | number | boolean>;
  targetId?: string;
  position?: SourcePosition;
  title?: string;
}

function sourceOf(code: string): DiagnosticSource {
  if (code.startsWith('KK')) return 'ass';
  if (code.startsWith('KL')) return 'lexicon';
  if (code.startsWith('KP')) return 'pack';
  if (code.startsWith('X:')) return 'ass';
  return 'library';
}

/** @internal Tworzy diagnostykę z katalogu, z uwzględnieniem nadpisań z `KokoConfig.messages`. */
export function diag(code: DiagnosticCode, opts: DiagOptions = {}): Diagnostic {
  const entry = CATALOG[code] ?? { level: 'warning' as const, title: code };
  const override = currentConfig().messages?.[code];
  const d: Diagnostic = {
    code,
    level: opts.level ?? entry.level,
    title: opts.title ?? override?.title ?? entry.title,
    params: Object.freeze({ ...(opts.params ?? {}) }),
    source: sourceOf(code),
  };
  const hint = override?.hint ?? entry.hint;
  if (hint !== undefined) d.hint = hint;
  if (opts.targetId !== undefined) d.targetId = opts.targetId;
  if (opts.position !== undefined) d.position = opts.position;
  return d;
}

/** Czy lista zawiera diagnostykę `error`. */
export function hasErrors(list: readonly Diagnostic[]): boolean {
  return list.some((d) => d.level === 'error');
}
