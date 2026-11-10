# @koko-anime/formats

Biblioteka TypeScript do odczytu, edycji i zapisu formatów projektu **Koko-Anime**:
**Koko-ASS v1** (napisy z instrukcjami dla lektora), **Koko-Lexicon v1** (leksykon serii)
i **Koko-Pack v1** (paczka napisów i ścieżki lektora).

Wersja pakietu **0.3.0** — implementuje specyfikację API **0.2.0** (`Koko-Formats-API_v0`) z dodatkami opisanymi niżej.

> Wersja 0.2.0 na npm to wcześniejsza implementacja z innym API (`/koko-ass`, `/koko-pack`, `/koko-lexicon`), dlatego ta biblioteka startuje od 0.3.0.

```
string | Blob  ──parse/open──▶  klasa (mutowalna, leniwa analiza, onChange)  ──toString/toBlob──▶  string | Blob
```

## Pakiety

Ten pakiet: `@koko-anime/formats` — `/config`, `/plugin`, `/ass`, `/lexicon`, `/numbers`, `/pack`, `/timing`, `/mp3`, `/crypto-noble`.

Adaptery frameworków są osobnymi bibliotekami (własne repozytoria i wersje):

| Pakiet | Import |
| --- | --- |
| `@koko-anime/adapters-svelte` | `import { svelte } from '@koko-anime/adapters-svelte'` (Svelte ≥ 5.7) |
| `@koko-anime/adapters-vue` | `import { vue } from '@koko-anime/adapters-vue'` |
| `@koko-anime/adapters-solid` | `import { solid } from '@koko-anime/adapters-solid'` |
| `@koko-anime/adapters-react` | `import { useKoko } from '@koko-anime/adapters-react'` (hook na `onChange`) |

Adapter to zwykły plugin z capability `reactivity` — można też napisać własny (`definePlugin({ reactivity: { createAtom } })`).

Rdzeń nie zależy od żadnego środowiska ani frameworka. Działa w przeglądarce/WebView (WebKitGTK, WebView2), Node i Bun.

## Szybki start

```ts
// src/koko.config.ts — importowany jako PIERWSZY w punkcie wejścia
import { defineConfig } from '@koko-anime/formats/config';
import { nobleCrypto } from '@koko-anime/formats/crypto-noble';
import { svelte } from '@koko-anime/adapters-svelte';
import { tauri } from './lib/koko/tauri-plugin'; // Twój adapter: fs, g2p, synth, encoder

export default defineConfig({
  plugins: [nobleCrypto(), tauri(), svelte()],
  registry: { url: 'https://registry.koko-anime.pl' },
  defaults: { voice: 'pl_lektor_1' },
  generator: { name: 'Koko-Editor', version: '0.4.0' },
});
```

```ts
import { KokoErrors } from '@koko-anime/formats';
import { KokoAss } from '@koko-anime/formats/ass';
import { KokoPack } from '@koko-anime/formats/pack';

const ass = await KokoAss.load('/anime/kusuriya/27.ass'); // + koko-lexicon.toml obok
if (ass instanceof KokoErrors) return show(ass.all);      // nigdy wyjątków

const line = ass.events.dialogues[10]!;
line.kk.say = 'Zbierają grzyby i się trują.';             // {!kk say="…"} w line.text
console.log(line.analysis.spokenText, ass.diagnostics);

const pack = KokoPack.create({ subtitles: ass, title: 'Odcinek 27' });
await pack.rebuild(undefined, { onProgress: (d, t) => (progress = d / t) });
const forViewers = await pack.toBlob({ profile: 'distribution' });
```

```svelte
<!-- Dokument działa jak stan Svelte — bez $state() i bez mostków -->
{#each ass.events.dialogues as line (line.id)}
  <input bind:value={line.text} />
  <span>{line.analysis.spokenText}</span>
{/each}
```

## Pluginy

Plugin to `definePlugin({ name, ...capability })`. Gdy kilka pluginów dostarcza tę samą capability, wygrywa **ostatni** na liście.

| Capability | Do czego |
| --- | --- |
| `fs` | `KokoAss.load()` z leksykonem serii |
| `g2p` | `toIpa`, `tokenCount` (limit 510, KK302/KK303), `ipaVocabulary` (KK101) |
| `synth` | `synthesize` (PCM **bez** gain — głośność stosuje biblioteka), `info()` (model, G2P) |
| `encoder` | `mp3` (CBR, bez rezerwuaru bitów; `rawFrames` przy podmianie ramek), `opus`, `decode` (PCM **bez** kompensacji opóźnienia) |
| `crypto` | `sha256` (synchroniczne), Ed25519 — gotowy plugin: `nobleCrypto()` |
| `fetch`, `registryCache` | rejestr twórców (PACK §8.2) |
| `reactivity` | `createAtom` (+ `batch`, `untrack`) — adaptery frameworków |
| `packExtensions` | obsługa katalogów `x-<dostawca>/` |

Nadpisanie dla jednego wywołania: zwykły obiekt, nie `defineConfig`:
`KokoPack.open(blob, { mode: 'play', config: { plugins: [], replacePlugins: true } })`.

## Rozwój

```sh
bun install
bun run test
bun run typecheck
bun run build       # tsdown → dist/
bun run docs        # TypeDoc → docs/ (HTML)
bun run docs:check  # walidacja: każdy publiczny symbol musi mieć opis
```

Dokumentacja API powstaje z komentarzy TSDoc w kodzie (po polsku). Elementy oznaczone `@internal` nie trafiają do dokumentacji; nowe publiczne API bez opisu kończy `docs:check` błędem.

Testy Koko-Pack i `/mp3` używają `ffmpeg` z libmp3lame i libopus (kodowanie/dekodowanie prawdziwych plików).

Do rozwijania adapterów przed publikacją 0.3.0: `bun run build && bun link` w tym repo, a w repo adaptera `bun link @koko-anime/formats`.

## Decyzje implementacyjne (do potwierdzenia w specyfikacji)

Miejsca, w których specyfikacja zostawiała swobodę albo w których implementacja coś dodaje:

1. **Opóźnienie MP3:** `encoderDelay` = opóźnienie z nagłówka LAME + 529 (opóźnienie dekodera), `padding` = padding LAME − 529. Daje dokładnie 1105 dla LAME 64 kbit/s @ 24 kHz — jak w przykładzie z PACK §10. Nagłówki `Lavc…` z ffmpeg są rozpoznawane tak samo jak `LAME…`.
2. **CRC LAME** po podmianie ramek jest przeliczane (CRC muzyki i CRC nagłówka), nie zerowane.
3. **`g` w segmentach** odnosi się do poprzedniego segmentu `text`/`ipa`; po pauzie nigdy nie ma `g`.
4. **Liczby:** wiodące zera w części dziesiętnej czytane jako „zero” (`2,05` → „dwa przecinek zero pięć”). Porządkowe tysiące spoza tabeli (np. `3000.`) → liczebnik główny (i tak KK204).
5. **Zapis kanoniczny Koko-ASS:** LF, bez BOM (otwarta kwestia 3). Komentarze `;` w `[Events]` i `[V4+ Styles]` nie są zachowywane; w `[Script Info]` i sekcjach Koko — tak. Tekst przed pierwszą sekcją jest zachowywany.
6. **Paczka niezmieniona** od otwarcia: `toBlob()` zwraca oryginalny Blob (bajt w bajt). Zmieniona: nowy ZIP z datą 1980-01-01 (determinizm), podpisy zachowane tylko, gdy JCS manifestu się nie zmienił.
7. **Nieznane pola manifestu** są ignorowane przy odczycie i nie są przepisywane przy zapisie.
8. **Ponowne użycie klipów** przy przebudowie wymaga `encoder.decode`; bez niego klipy są syntezowane ponownie z zapisaną prędkością.
9. **KP012** sprawdzane bez dekodowania: MP3 z nagłówka Info/LAME, Opus z OpusHead i ostatniej pozycji granule.
10. **Case folding:** `lower(upper(c))` dla odwzorowań 1:1 + wyjątek Cherokee; zgodne ze statusami C+S z `CaseFolding.txt` dla polskiego i łacińskiego, do potwierdzenia golden testami dla rzadkich skryptów.
11. **`SkipIfMatch`:** podzbiór jest walidowany, ale wykonuje go silnik RegExp JS (bez gwarancji czasu liniowego).
12. **Adaptery** są osobnymi bibliotekami `@koko-anime/adapters-*` (specyfikacja API 0.2.0 nazywa je `@koko-anime/formats-*`).
13. **Wersja pakietu 0.3.0** zamiast 0.2.0 — kolizja z opublikowaną wcześniej wersją 0.2.0 o innym API.
14. **Dodatki do API** względem specyfikacji 0.2.0: `SynthCapability.info()`, `CryptoCapability.ed25519PublicKey()`, `KokoPack.create/setCache/setExtensionFile/dirty/matchVideo`, `videoFingerprint()`, `AudioTrack.fromPlaybackSeconds()`, `EventList.shift()`, `Utterance.parts`, `KokoAss.settings/resolvedLexicon`, kody KF001–KF006.

## Ograniczenia v0.2.0

- Tryb `play` nie blokuje edycji `pack.subtitles` (tylko pomija kontrole edycyjne).
- `loudness` nie jest liczona przy przebudowie.

Licencja kodu: MIT. Specyfikacje formatów: CC BY 4.0.
