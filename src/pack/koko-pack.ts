/**
 * `KokoPack` — paczka Koko-Pack v1 (specyfikacja API §6, Koko-Pack §1–§8).
 */
import { resolveConfig, type CallConfig, type ResolvedConfig } from '../core/config-store.ts';
import { diag, type Diagnostic } from '../core/diagnostics.ts';
import { DocCore, markRaw, type ChangeListener, type Observable } from '../core/doc-core.ts';
import { KokoErrors } from '../core/errors.ts';
import { jcs, round4, sha256Blob, sha256Tag, sha256Bytes } from '../core/hash.ts';
import type { Atom, CanonicalSegment, SynthesisInfo, SynthResult } from '../core/plugin-types.ts';
import { fromUtf8, nfc, utf8 } from '../core/text.ts';
import { KokoAss, TOKEN_LIMIT, type Utterance } from '../ass/koko-ass.ts';
import { NUMBERS_RULES_VERSION } from '../numbers/expand.ts';
import { checkSpliceable, indexFramesSync, spliceRange } from '../mp3/mp3.ts';
import { reconcileTimeline, type FitSettings, type ReconcileDecision, type ReconcileInput, type TimelineUtterance } from '../timing/timing.ts';
import { probeAudio } from './audio-info.ts';
import {
  ManifestSchema,
  RegistryResponseSchema,
  SignaturesSchema,
  TimelineSchema,
  type AudioEntryJson,
  type ManifestJson,
  type SignatureJson,
  type SynthesisJson,
  type TimelineJson,
  type VideoJson,
  type,
} from './schemas.ts';
import type { ClipJson, GeneratorJson } from './json-types.ts';
import { entryBlob, readZip, writeZip, type ZipEntry, type ZipWriteEntry } from './zip.ts';

/** Typ MIME paczki — treść pliku `mimetype`. */
export const MIMETYPE = 'application/vnd.koko-anime.pack+zip';
/** Obsługiwana wersja Koko-Pack (`manifest.version`). */
export const KOKO_PACK_VERSION = 1;
const LIB_VERSION = '0.3.0';

/** Profil paczki: `full` — roboczy (Koko-Editor), `distribution` — dla widzów (okrojona oś czasu, bez `cache/`). */
export type PackProfile = 'full' | 'distribution';
/** Parametry ścieżki audio (wpis `manifest.audio` bez `id`, `path`, `role`, `sha256`). */
export type AudioParams = Omit<AudioEntryJson, 'id' | 'path' | 'role' | 'sha256'>;

/** Tożsamość syntezy z opcjonalnym głosem (nadpisuje `Voice`). */
export interface SynthesisOverride extends SynthesisInfo {
  /** Efektywny głos. */
  voice?: string;
}

/** Opcje `KokoPack.open`. */
export interface PackOpenOptions {
  /** `play`: pomija kroki 6–7 z PACK §6.1 (Koko-Player). Domyślnie `edit`. */
  mode?: 'edit' | 'play';
  /** Bieżąca tożsamość syntezy (KP010); domyślnie z `synth.info()`. */
  synthesis?: SynthesisOverride;
  /** Nadpisanie konfiguracji dla tego wywołania. */
  config?: CallConfig;
}

/** Klucz do podpisu Ed25519 (Koko-Pack §8.1). */
export interface SigningKey {
  /** Nazwa konta w rejestrze (z `registry: 'koko'`) albo etykieta. */
  keyId: string;
  /** `koko` — weryfikacja przez centralny rejestr twórców. */
  registry?: 'koko';
  /** Klucz prywatny (32 B). */
  privateKey: Uint8Array;
  /** Klucz publiczny — domyślnie wyliczany przez `crypto.ed25519PublicKey`. */
  publicKey?: Uint8Array;
}

/** Opcje `KokoPack.toBlob`. */
export interface ToBlobOptions {
  /** Profil zapisu (domyślnie profil paczki); instancja się nie zmienia. */
  profile?: PackProfile;
  /** Podpis(y) manifestu. */
  sign?: SigningKey | SigningKey[];
  /** Nadpisanie konfiguracji dla tego wywołania. */
  config?: CallConfig;
}

/** Element planu dopasowania. */
export interface ReconcilePlanItem {
  /** ID wypowiedzi; null dla wpisu osieroconego. */
  utteranceId: string | null;
  /** Stan. */
  state: ReconcileDecision['state'];
  /** Przesunięta i ze zmienioną głośnością. */
  alsoGain?: boolean;
  /** Klucz wypowiedzi. */
  key: string | null;
}

/** Plan dopasowania (Koko-Pack §6.3) — wynik `reconcile()`. */
export interface ReconcilePlan {
  /** Decyzje w kolejności czasu, na końcu wpisy osierocone. */
  readonly items: readonly ReconcilePlanItem[];
  /** Liczby wypowiedzi w każdym stanie. */
  readonly counts: Readonly<Record<ReconcileDecision['state'], number>>;
  /** KP101–KP103, KP105, KP106, KP010, KF002. */
  readonly diagnostics: readonly Diagnostic[];
}

/** Opcje `KokoPack.rebuild`. */
export interface RebuildOptions {
  /** Przerwanie (KF005). */
  signal?: AbortSignal;
  /** Postęp syntezy. */
  onProgress?: (done: number, total: number, utteranceId: string) => void;
  /** Kodek przy pierwszej przebudowie (domyślnie mp3 CBR, spliceable). */
  codec?: 'mp3' | 'opus';
  /** Tożsamość syntezy (domyślnie z `synth.info()`). */
  synthesis?: SynthesisOverride;
  /** Język ścieżki (BCP 47), domyślnie dotychczasowy. */
  language?: string;
  /** Nadpisanie konfiguracji dla tego wywołania. */
  config?: CallConfig;
}

/** Status podpisu (Koko-Pack §8.2). */
export type SignatureStatus = 'verified' | 'verified-rotated' | 'trusted-local' | 'unverified' | 'untrusted';

/** Wynik weryfikacji jednego podpisu. */
export interface SignatureReport {
  /** Konto/etykieta. */
  keyId: string;
  /** Klucz publiczny (base64). */
  publicKey: string;
  /** Status. */
  status: SignatureStatus;
  /** Nazwa wyświetlana z rejestru. */
  displayName?: string;
  /** KP013, KP014, KP017–KP019. */
  diagnostics: Diagnostic[];
}

/** Raport zaufania paczki. */
export interface TrustReport {
  /** Najgorszy status spośród podpisów albo `unsigned`. */
  status: SignatureStatus | 'unsigned';
  /** Podpisy. */
  signatures: SignatureReport[];
  /** Wszystkie diagnostyki weryfikacji. */
  diagnostics: Diagnostic[];
}

/** Wynik dopasowania otwartego wideo (Koko-Pack §3). */
export interface VideoMatch {
  /** Gdzie dopasowano. */
  match: 'manifest' | 'source' | 'none';
  /** Etykieta wpisu `[Koko Sources]`. */
  sourceLabel?: string;
  /** Odcisk otwartego pliku. */
  fingerprint: string;
  /** KP009, KK008. */
  diagnostics: Diagnostic[];
}

// ---------------------------------------------------------------- pomocnicze

function b64encode(b: Uint8Array): string {
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s);
}

function b64decode(s: string): Uint8Array | null {
  try {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

const ROOT_FILES = new Set(['mimetype', 'manifest.json', 'subtitles.ass', 'timeline.json', 'signatures.json']);

function validPath(name: string): boolean {
  if (!name || name.startsWith('/') || name.includes('\\') || name !== nfc(name)) return false;
  const parts = name.replace(/\/$/, '').split('/');
  if (parts.some((p) => p === '' || p === '.' || p === '..')) return false;
  if (/^[A-Za-z]:/.test(name)) return false;
  const top = parts[0]!;
  if (parts.length === 1 && !name.endsWith('/')) return ROOT_FILES.has(top);
  return top === 'audio' || top === 'cache' || /^x-[a-z0-9][a-z0-9-]*$/i.test(top);
}

/** Odcisk pliku wideo (Koko-ASS §2 / PACK §3). */
export async function videoFingerprint(file: Blob): Promise<string> {
  const MiB = 1024 * 1024;
  const size = file.size;
  const a = new Uint8Array(await file.slice(0, Math.min(MiB, size)).arrayBuffer());
  const b = size > MiB ? new Uint8Array(await file.slice(Math.max(MiB, size - MiB), size).arrayBuffer()) : new Uint8Array(0);
  const len = new Uint8Array(8);
  new DataView(len.buffer).setBigUint64(0, BigInt(size), true);
  const all = new Uint8Array(a.length + b.length + 8);
  all.set(a, 0);
  all.set(b, a.length);
  all.set(len, a.length + b.length);
  return sha256Tag(all);
}

function canonicalJson(obj: unknown): string {
  return JSON.stringify(obj, null, 2) + '\n';
}

function orderAudio(a: AudioEntryJson): AudioEntryJson {
  const o: Record<string, unknown> = {};
  for (const k of ['id', 'path', 'role', 'codec', 'sampleRate', 'channels', 'bitrateMode', 'spliceable', 'encoderDelay', 'padding', 'offset', 'duration', 'sha256', 'language', 'loudness'] as const)
    if (a[k] !== undefined) o[k] = a[k];
  return o as unknown as AudioEntryJson;
}

function orderManifest(m: ManifestJson): ManifestJson {
  const o: Record<string, unknown> = {};
  for (const k of ['format', 'version', 'created', 'modified', 'generator', 'profile', 'title', 'subtitles', 'audio', 'timeline', 'synthesis', 'video', 'extensions'] as const)
    if (m[k] !== undefined) o[k] = k === 'audio' ? m.audio.map(orderAudio) : m[k];
  return o as unknown as ManifestJson;
}

function orderUtterance(u: TimelineUtterance): TimelineUtterance {
  const o: Record<string, unknown> = {};
  for (const k of ['key', 'slot', 'clip', 'baseDuration', 'speed', 'gain', 'delay', 'diagnostics', 'lines', 'text'] as const)
    if (u[k] !== undefined && !(k === 'diagnostics' && !u.diagnostics?.length)) o[k] = u[k];
  return o as unknown as TimelineUtterance;
}

/** Podział segmentów na części ≤ 510 tokenów (ASS §4.4): zdania → przecinki/pauzy → słowa. */
async function splitSegments(segs: readonly CanonicalSegment[], tokens: (s: CanonicalSegment[]) => Promise<number>): Promise<CanonicalSegment[][]> {
  if ((await tokens([...segs])) <= TOKEN_LIMIT) return [[...segs]];
  const pieces = (level: number): CanonicalSegment[] => {
    const out: CanonicalSegment[] = [];
    const re = level === 0 ? /(?<=[.!?…]["'”»)]*\s)/u : level === 1 ? /(?<=[,;:—]\s)/u : /(?<=\s)/u;
    for (const s of segs) {
      if (s.t !== 'text') {
        out.push(s);
        continue;
      }
      s.s.split(re).forEach((p, i) => out.push(i === 0 && s.g ? { t: 'text', s: p, g: true } : { t: 'text', s: p }));
    }
    return out;
  };
  for (let level = 0; level < 3; level++) {
    const ps = pieces(level);
    const parts: CanonicalSegment[][] = [];
    let cur: CanonicalSegment[] = [];
    let ok = true;
    for (const p of ps) {
      const cand = [...cur, p];
      if ((await tokens(cand)) <= TOKEN_LIMIT) cur = cand;
      else {
        if (!cur.length) {
          ok = false;
          break;
        }
        parts.push(cur);
        cur = [p];
        if ((await tokens(cur)) > TOKEN_LIMIT) {
          ok = false;
          break;
        }
      }
      if (level < 2 && p.t === 'pause' && cur.length > 1) {
        parts.push(cur);
        cur = [];
      }
    }
    if (ok) {
      if (cur.length) parts.push(cur);
      return parts.map((p) => p.map((s) => ({ ...s, ...(s.t !== 'pause' ? { s: s.s.trim() } : {}) }) as CanonicalSegment).filter((s) => s.t === 'pause' || s.s !== ''));
    }
  }
  return [[...segs]];
}

function chooseBitrate(sr: number): number {
  return sr >= 32000 ? 128 : 64;
}

// ---------------------------------------------------------------- widoki

/** Ścieżka audio paczki (PACK §4). */
export class AudioTrack {
  /** @internal */ _blob: Blob;
  /** @internal */ _params: AudioParams;
  /** @internal */ _sha256: string;
  /** @internal */ _path: string;
  /** @internal */ _spliceable: boolean;
  /** @internal */ readonly owner: KokoPack;

  /** @internal */
  constructor(owner: KokoPack, blob: Blob, path: string, params: AudioParams, sha: string, spliceable: boolean) {
    this.owner = owner;
    this._blob = blob;
    this._path = path;
    this._params = params;
    this._sha256 = sha;
    this._spliceable = spliceable;
    markRaw(this);
  }

  /** Plik ścieżki (STORED — wycinek archiwum bez kopiowania). */
  get blob(): Blob {
    this.owner._audioAtom.track();
    return this._blob;
  }
  /** Ścieżka w paczce. */
  get path(): string {
    this.owner._audioAtom.track();
    return this._path;
  }
  /** Parametry (po korekcie KP012). */
  get params(): Readonly<AudioParams> {
    this.owner._audioAtom.track();
    return this._params;
  }
  /** Hash pliku. */
  get sha256(): string {
    this.owner._audioAtom.track();
    return this._sha256;
  }
  /** `spliceable` po kontroli PACK §4.1 (KP015 → false). */
  get spliceable(): boolean {
    this.owner._audioAtom.track();
    return this._spliceable;
  }

  /** Próbka zdekodowanego strumienia dla czasu napisów `t` (ms): `encoderDelay + round((t − offset)·sr/1000)`. */
  toSample(ms: number): number {
    const p = this._params;
    return p.encoderDelay + Math.round(((ms - p.offset) * p.sampleRate) / 1000);
  }

  /** Czas (ms) w zdekodowanym strumieniu (bez kompensacji opóźnienia) dla czasu napisów. */
  toAudioTime(ms: number): number {
    return (this.toSample(ms) * 1000) / this._params.sampleRate;
  }

  /** Czas napisów (ms) dla pozycji odtwarzania elementu `<audio>` z kompensacją gapless (sekundy). */
  fromPlaybackSeconds(seconds: number): number {
    return this._params.offset + seconds * 1000;
  }

  /** Zastępuje plik audio (zaawansowane; nie zmienia osi czasu). */
  async replace(blob: Blob, params: AudioParams): Promise<void> {
    this._blob = blob;
    this._params = { ...params };
    this._sha256 = await sha256Blob(blob);
    this._spliceable = params.spliceable === true;
    this.owner._markDirty(['audio']);
  }
}

/** Widok manifestu (PACK §3). Edytowalne: `title`, `video`, `extensions`. */
export class ManifestView {
  /** @internal */ readonly owner: KokoPack;
  /** @internal */ constructor(owner: KokoPack) {
    this.owner = owner;
    markRaw(this);
  }
  #m(): ManifestJson {
    this.owner._manifestAtom.track();
    return this.owner._manifest;
  }
  /** Stała `koko-pack`. */
  get format(): 'koko-pack' { return this.#m().format; }
  /** Wersja formatu. */
  get version(): number { return this.#m().version; }
  /** Profil. */
  get profile(): PackProfile { return this.#m().profile; }
  /** Utworzenie (ISO 8601). */
  get created(): string { return this.#m().created; }
  /** Ostatnia zmiana (ISO 8601). */
  get modified(): string | undefined { return this.#m().modified; }
  /** Program zapisujący. */
  get generator(): Readonly<GeneratorJson> { return this.#m().generator; }
  /** Wpis napisów. */
  get subtitles(): Readonly<ManifestJson['subtitles']> { return this.#m().subtitles; }
  /** Ścieżki audio. */
  get audio(): readonly Readonly<AudioEntryJson>[] { return this.#m().audio; }
  /** Wpis osi czasu. */
  get timeline(): Readonly<ManifestJson['timeline']> { return this.#m().timeline; }
  /** Tożsamość syntezy. */
  get synthesis(): Readonly<SynthesisJson> | undefined { return this.#m().synthesis; }
  /** Tytuł (edytowalny). */
  get title(): string | undefined { return this.#m().title; }
  set title(v: string | undefined) {
    const m = this.owner._manifest;
    if (v === undefined || v === '') delete m.title;
    else m.title = nfc(v);
    this.owner._markDirty(['manifest', 'title']);
  }
  /** Wideo (edytowalne). */
  get video(): Readonly<VideoJson> | undefined { return this.#m().video; }
  set video(v: VideoJson | undefined) {
    const m = this.owner._manifest;
    if (v === undefined) delete m.video;
    else m.video = { ...v };
    this.owner._markDirty(['manifest', 'video']);
  }
  /** Rozszerzenia `x-*` (edytowalne). */
  get extensions(): Readonly<Record<string, unknown>> | undefined { return this.#m().extensions; }
  set extensions(v: Record<string, unknown> | undefined) {
    const m = this.owner._manifest;
    if (v === undefined) delete m.extensions;
    else m.extensions = Object.fromEntries(Object.entries(v).filter(([k]) => /^x-/.test(k)));
    this.owner._markDirty(['manifest', 'extensions']);
  }
  /** Manifest jako obiekt (kolejność pól jak w specyfikacji). */
  toJSON(): ManifestJson {
    return orderManifest(structuredClone(this.owner._manifest));
  }
}

/** Widok osi czasu (PACK §5). */
export class TimelineView {
  /** @internal */ readonly owner: KokoPack;
  /** @internal */ constructor(owner: KokoPack) {
    this.owner = owner;
    markRaw(this);
  }
  /** Przedziały klipów — wystarczają do ściszania oryginału. */
  get clips(): readonly ClipJson[] {
    this.owner._timelineAtom.track();
    return this.owner._timeline?.utterances.map((u) => u.clip) ?? [];
  }
  /** Pełne wpisy (profil `full`). */
  get utterances(): readonly TimelineUtterance[] {
    this.owner._timelineAtom.track();
    return (this.owner._timeline?.utterances.filter((u) => u.key !== undefined) as TimelineUtterance[] | undefined) ?? [];
  }
  /** false po KP006/KP104. */
  get valid(): boolean {
    this.owner._timelineAtom.track();
    return this.owner._timelineValid;
  }
  /** Hash napisów, z których powstała oś. */
  get subtitlesSha256(): string | undefined {
    this.owner._timelineAtom.track();
    return this.owner._timeline?.subtitlesSha256;
  }
}

// ---------------------------------------------------------------- KokoPack

/**
 * Paczka Koko-Pack v1 (specyfikacja API §6).
 *
 * `pack.subtitles` to żywy dokument `KokoAss` — jego edycja oznacza paczkę jako nieaktualną (`stale`),
 * a `toBlob()` zwraca wtedy KF003 do czasu `rebuild()`.
 */
export class KokoPack implements Observable {
  /** @internal */ readonly _core: DocCore;
  /** @internal */ _manifest: ManifestJson;
  /** @internal */ _timeline: TimelineJson | null = null;
  /** @internal */ _timelineValid = false;
  /** @internal */ readonly _manifestAtom: Atom;
  /** @internal */ readonly _audioAtom: Atom;
  /** @internal */ readonly _timelineAtom: Atom;
  /** @internal */ readonly _staleAtom: Atom;
  /** Manifest. */
  readonly manifest: ManifestView;
  /** Oś czasu. */
  readonly timeline: TimelineView;
  #subtitles: KokoAss;
  #subtitlesBytes: Uint8Array | null = null;
  #subtitlesDirty = false;
  #audio: AudioTrack | null = null;
  #cache = new Map<string, Blob>();
  #extensions = new Map<string, Map<string, Blob>>();
  #signatures: SignatureJson[] = [];
  #origManifestJcs: string | null = null;
  #input: Blob | null = null;
  #dirty = false;
  #stale = false;
  #diagnostics: Diagnostic[] = [];
  #trust: TrustReport | undefined;

  private constructor(subtitles: KokoAss, manifest: ManifestJson, call?: CallConfig) {
    this._core = new DocCore(this, call);
    this._manifestAtom = this._core.atom('manifest');
    this._audioAtom = this._core.atom('audio');
    this._timelineAtom = this._core.atom('timeline');
    this._staleAtom = this._core.atom('stale');
    this._manifest = manifest;
    this.#subtitles = subtitles;
    this.manifest = new ManifestView(this);
    this.timeline = new TimelineView(this);
    this._core.attachChild(subtitles._core);
    subtitles.onChange(() => {
      this.#subtitlesDirty = true;
      this.#dirty = true;
      if (!this.#stale) {
        this.#stale = true;
        this._staleAtom.trigger();
      }
    });
    markRaw(this);
  }

  /** @internal */
  _markDirty(path: string[]): void {
    this.#dirty = true;
    this._manifest.modified = nowIso();
    const atom = path[0] === 'audio' ? this._audioAtom : path[0] === 'timeline' ? this._timelineAtom : this._manifestAtom;
    this._core.change([atom, this._manifestAtom], { targetId: null, kind: 'update', path });
  }

  /** Nowa paczka (profil `full`) — bez audio do pierwszego `rebuild()`. */
  static create(init: { subtitles: KokoAss; title?: string; config?: CallConfig }): KokoPack {
    const cfg = resolveConfig(init.config);
    const now = nowIso();
    const m: ManifestJson = {
      format: 'koko-pack',
      version: KOKO_PACK_VERSION,
      created: now,
      modified: now,
      generator: { ...cfg.generator },
      profile: 'full',
      subtitles: { path: 'subtitles.ass', sha256: sha256Tag(init.subtitles.toString()), kokoVersion: init.subtitles.scriptInfo.kokoVersion },
      audio: [],
      timeline: { path: 'timeline.json', sha256: sha256Tag('') },
    };
    if (init.title) m.title = nfc(init.title);
    const p = new KokoPack(init.subtitles, m, init.config);
    p.#stale = true;
    p.#dirty = true;
    p.#subtitlesDirty = true;
    return p;
  }

  /** Otwiera paczkę (kontrola PACK §6.1). Odrzucenie → `KokoErrors`. */
  static async open(input: Blob | Uint8Array, opts: PackOpenOptions = {}): Promise<KokoPack | KokoErrors> {
    const cfg = resolveConfig(opts.config);
    const limits = cfg.limits;
    const mode = opts.mode ?? 'edit';
    const blob = input instanceof Blob ? input : new Blob([input as Uint8Array<ArrayBuffer>]);
    const diags: Diagnostic[] = [];
    const reject = (...d: Diagnostic[]) => new KokoErrors(d, [...diags, ...d]);

    // 1. mimetype (PACK §2): pierwszy wpis, STORED, bez extra/deskryptora, dokładna treść.
    const head = new Uint8Array(await blob.slice(0, 38 + MIMETYPE.length + 1).arrayBuffer());
    const hv = new DataView(head.buffer);
    const mimeOk =
      head.length >= 38 + MIMETYPE.length &&
      hv.getUint32(0, true) === 0x04034b50 &&
      (hv.getUint16(6, true) & 0x0008) === 0 &&
      hv.getUint16(8, true) === 0 &&
      hv.getUint16(26, true) === 8 &&
      hv.getUint16(28, true) === 0 &&
      fromUtf8(head.subarray(30, 38)) === 'mimetype' &&
      hv.getUint32(18, true) === MIMETYPE.length &&
      fromUtf8(head.subarray(38, 38 + MIMETYPE.length)) === MIMETYPE;
    if (!mimeOk) return reject(diag('KP001'));

    const z = await readZip(blob);
    if (z.error) return reject(diag('KP007', { params: { reason: z.error } }));
    const byName = new Map<string, ZipEntry>();
    for (const e of z.entries) {
      if (!validPath(e.name)) return reject(diag('KP007', { params: { path: e.name } }));
      if (e.isSymlink || e.encrypted) return reject(diag('KP007', { params: { path: e.name, reason: e.isSymlink ? 'symlink' : 'encrypted' } }));
      if (e.method !== 0 && e.method !== 8) return reject(diag('KP007', { params: { path: e.name, reason: 'method' } }));
      if (e.method === 8 && e.compressedSize > 0 && e.size / e.compressedSize > limits.maxCompressionRatio)
        return reject(diag('KP007', { params: { path: e.name, reason: 'compression-ratio' } }));
      if (byName.has(e.name)) return reject(diag('KP007', { params: { path: e.name, reason: 'duplicate' } }));
      byName.set(e.name, e);
    }
    if (z.entries[0]?.name !== 'mimetype') return reject(diag('KP001'));

    const readText = async (name: string, max: number): Promise<string | null> => {
      const e = byName.get(name);
      if (!e || e.size > max) return null;
      const b = await entryBlob(blob, e, max);
      return b ? fromUtf8(new Uint8Array(await b.arrayBuffer())) : null;
    };

    // 2. manifest.json
    const manText = await readText('manifest.json', limits.jsonMaxBytes);
    if (manText === null) return reject(diag('KP002', { params: { reason: 'missing' } }));
    let manRaw: unknown;
    try {
      manRaw = JSON.parse(manText);
    } catch {
      return reject(diag('KP002', { params: { reason: 'json' } }));
    }
    const ver = (manRaw as { version?: unknown })?.version;
    if (typeof ver === 'number' && ver > KOKO_PACK_VERSION) return reject(diag('KP003', { params: { version: ver } }));
    const man = ManifestSchema(manRaw);
    if (man instanceof type.errors) return reject(diag('KP002', { params: { reason: man.summary } }));
    const manifest = structuredClone(man) as ManifestJson;
    if (manifest.profile === 'distribution' && z.entries.some((e) => e.name.startsWith('cache/')))
      return reject(diag('KP007', { params: { reason: 'cache-in-distribution' } }));

    const lektors = manifest.audio.filter((a) => a.role === 'lektor');
    if (lektors.length !== 1) return reject(diag('KP011', { params: { count: lektors.length } }));
    const lektor = lektors[0]!;
    if (lektor.codec !== 'mp3' && lektor.codec !== 'opus') return reject(diag('KP016', { params: { codec: lektor.codec } }));
    if (!byName.has(manifest.subtitles.path)) return reject(diag('KP004', { params: { path: manifest.subtitles.path } }));
    if (!byName.has(lektor.path)) return reject(diag('KP004', { params: { path: lektor.path } }));

    // napisy
    const subEntry = byName.get(manifest.subtitles.path)!;
    const subBlob = await entryBlob(blob, subEntry, limits.jsonMaxBytes);
    if (!subBlob) return reject(diag('KP007', { params: { path: manifest.subtitles.path, reason: 'size' } }));
    const subBytes = new Uint8Array(await subBlob.arrayBuffer());
    const subtitles = KokoAss.parse(fromUtf8(subBytes), opts.config ? { config: opts.config } : {});
    if (subtitles instanceof KokoErrors) return new KokoErrors([...subtitles], [...diags, ...subtitles.all]);

    const pack = new KokoPack(subtitles, manifest, opts.config);
    pack.#input = blob;
    pack.#subtitlesBytes = subBytes;
    pack.#origManifestJcs = jcs(manRaw);

    // 3. podpisy
    const sigText = await readText('signatures.json', limits.jsonMaxBytes);
    if (sigText !== null) {
      try {
        const s = SignaturesSchema(JSON.parse(sigText));
        if (!(s instanceof type.errors)) pack.#signatures = s.signatures.map((x) => ({ ...x }));
        else diags.push(diag('KP013', { params: { reason: 'signatures.json' } }));
      } catch {
        diags.push(diag('KP013', { params: { reason: 'signatures.json' } }));
      }
      const crypto = cfg.cap('crypto');
      if (crypto) {
        const msg = utf8(pack.#origManifestJcs);
        for (const sig of pack.#signatures) {
          const pk = b64decode(sig.publicKey);
          const sg = b64decode(sig.signature);
          let ok = false;
          try {
            ok = sig.alg === 'ed25519' && !!pk && !!sg && pk.length === 32 && sg.length === 64 && (await crypto.ed25519Verify(msg, sg, pk));
          } catch {
            ok = false;
          }
          if (!ok) diags.push(diag('KP013', { params: { keyId: sig.keyId } }));
        }
      }
    }

    // 4. audio
    const audEntry = byName.get(lektor.path)!;
    if (audEntry.method !== 0) diags.push(diag('KP008', { params: { path: lektor.path } }));
    const audBlob = await entryBlob(blob, audEntry);
    if (!audBlob) return reject(diag('KP007', { params: { path: lektor.path } }));
    const audSha = await sha256Blob(audBlob, opts.config);
    let audioOk = audSha === lektor.sha256;
    if (!audioOk) diags.push(diag('KP006', { params: { expected: lektor.sha256, actual: audSha } }));
    const { id: _id, path: _p, role: _r, sha256: _s, ...params } = lektor;
    void _id; void _p; void _r; void _s;
    let spliceable = lektor.spliceable === true;
    const audBytes = new Uint8Array(await audBlob.arrayBuffer());
    const probe = probeAudio(audBytes, lektor.codec);
    if (probe) {
      const mismatch =
        probe.sampleRate !== lektor.sampleRate ||
        probe.encoderDelay !== lektor.encoderDelay ||
        (lektor.codec === 'mp3' && probe.padding !== lektor.padding) ||
        Math.abs(probe.duration - lektor.duration) > 1;
      if (mismatch && (lektor.codec === 'opus' || probe.mp3?.encoderDelay !== undefined)) {
        diags.push(diag('KP012', { params: { sampleRate: probe.sampleRate, encoderDelay: probe.encoderDelay, padding: probe.padding, duration: probe.duration } }));
        params.sampleRate = probe.sampleRate;
        params.encoderDelay = probe.encoderDelay;
        params.padding = probe.padding;
        params.duration = probe.duration;
      }
    }
    if (spliceable) {
      if (lektor.codec !== 'mp3' || lektor.bitrateMode !== 'cbr' || !probe?.mp3) spliceable = false;
      else if (checkSpliceable(probe.mp3, audBytes).length) spliceable = false;
      if (!spliceable) diags.push(diag('KP015'));
    }
    pack.#audio = new AudioTrack(pack, audBlob, lektor.path, params, audSha, spliceable);

    // 5. timeline
    const tlEntry = byName.get(manifest.timeline.path);
    if (!tlEntry) diags.push(diag('KP004', { level: 'warning', params: { path: manifest.timeline.path } }), diag('KP104', { params: { reason: 'missing' } }));
    else {
      const tlText = await readText(manifest.timeline.path, limits.timelineMaxBytes);
      let tl: TimelineJson | null = null;
      if (tlText !== null && sha256Tag(utf8(tlText)) === manifest.timeline.sha256) {
        try {
          const t = TimelineSchema(JSON.parse(tlText));
          if (!(t instanceof type.errors)) tl = structuredClone(t) as TimelineJson;
        } catch {
          tl = null;
        }
      }
      let valid = !!tl;
      if (tl) {
        const off = params.offset;
        const end = params.offset + params.duration;
        let prevEnd = -Infinity;
        for (const u of tl.utterances) {
          if (u.clip.start < off || u.clip.start + u.clip.duration > end + 1 || u.clip.start < prevEnd) valid = false;
          prevEnd = u.clip.start + u.clip.duration;
          if (manifest.profile === 'full' && (u.key === undefined || !u.slot || u.baseDuration === undefined || u.speed === undefined || u.gain === undefined || u.delay === undefined)) valid = false;
        }
      }
      if (!valid) diags.push(diag('KP104'));
      pack._timeline = tl;
      pack._timelineValid = valid && audioOk;
    }

    // 6–7. tylko przy edycji
    if (mode === 'edit') {
      const subSha = sha256Tag(subBytes, opts.config);
      if (subSha !== manifest.subtitles.sha256 || (pack._timeline && subSha !== pack._timeline.subtitlesSha256)) {
        diags.push(diag('KP005'));
        pack.#stale = true;
      }
      if (manifest.profile === 'distribution') {
        diags.push(diag('KP105'));
        pack.#stale = true;
      }
      const current = opts.synthesis ?? (await cfg.cap('synth')?.info?.().catch(() => undefined));
      if (current && manifest.synthesis && !sameSynthesis(manifest.synthesis, current, subtitles)) {
        diags.push(diag('KP010'));
        pack.#stale = true;
      }
      if (!pack._timelineValid) pack.#stale = true;
    }

    // cache/ i rozszerzenia
    for (const e of z.entries) {
      if (e.isDirectory) continue;
      if (e.name.startsWith('cache/')) {
        const b = await entryBlob(blob, e, limits.cacheMaxBytes);
        if (b) pack.#cache.set(e.name.slice(6), b);
      } else if (/^x-/i.test(e.name)) {
        const vendor = e.name.slice(0, e.name.indexOf('/'));
        const b = await entryBlob(blob, e, limits.jsonMaxBytes);
        if (!b) continue;
        const m = pack.#extensions.get(vendor) ?? new Map<string, Blob>();
        m.set(e.name.slice(vendor.length + 1), b);
        pack.#extensions.set(vendor, m);
      }
    }
    for (const p of cfg.plugins) {
      for (const h of p.packExtensions ?? []) {
        const files = pack.#extensions.get(h.vendor);
        if (files && h.onOpen) {
          try {
            await h.onOpen(files, manifest.extensions?.[h.vendor]);
          } catch (e) {
            diags.push(diag('KF004', { params: { plugin: p.name, message: String(e) } }));
          }
        }
      }
    }
    pack.#diagnostics = diags;
    return pack;
  }

  // ------------------------------------------------------------ dostęp

  /** Profil paczki. */
  get profile(): PackProfile {
    this._manifestAtom.track();
    return this._manifest.profile;
  }
  /** Napisy — żywy dokument (w trybie `play` nie edytuj). */
  get subtitles(): KokoAss {
    return this.#subtitles;
  }
  /** Ścieżka lektora (null przed pierwszym `rebuild` nowej paczki). */
  get audio(): AudioTrack | null {
    this._audioAtom.track();
    return this.#audio;
  }
  /** Pliki `cache/` (ścieżki względne; tylko profil `full`). */
  get cache(): ReadonlyMap<string, Blob> {
    this._manifestAtom.track();
    return this.#cache;
  }
  /** Pliki rozszerzeń `x-<dostawca>/`. */
  get extensions(): ReadonlyMap<string, ReadonlyMap<string, Blob>> {
    this._manifestAtom.track();
    return this.#extensions;
  }
  /** Podpisy z `signatures.json`. */
  get signatures(): readonly Readonly<SignatureJson>[] {
    this._manifestAtom.track();
    return this.#signatures;
  }
  /** Diagnostyki otwarcia/przebudowy paczki i napisów. */
  get diagnostics(): readonly Diagnostic[] {
    this._core.docAtom.track();
    return [...this.#diagnostics, ...this.#subtitles.diagnostics];
  }
  /** Napisy lub głośność zmienione od ostatniej przebudowy. */
  get stale(): boolean {
    this._staleAtom.track();
    return this.#stale;
  }
  /** Paczka zmieniona od otwarcia (inaczej `toBlob()` zwraca oryginalny Blob). */
  get dirty(): boolean {
    this._core.docAtom.track();
    return this.#dirty;
  }
  /** Wynik ostatniego `verifySignatures()`. */
  get trust(): TrustReport | undefined {
    return this.#trust;
  }
  /** Czy dokument używa atomów pluginu `reactivity`. */
  get reactive(): boolean {
    return this._core.reactive;
  }

  /** Rejestruje słuchacza zmian (także zmian `subtitles`). */
  onChange(listener: ChangeListener): () => void {
    return this._core.onChange(listener);
  }

  /** Grupuje zmiany w jedno zdarzenie. */
  batch(label: string, fn: () => void): void {
    this._core.batch(label, fn);
  }

  /** Ustawia/usuwa plik w `cache/` (dane pochodne, np. `peaks.json`). */
  setCache(path: string, blob: Blob | undefined): void {
    if (blob) this.#cache.set(path, blob);
    else this.#cache.delete(path);
    this._markDirty(['cache', path]);
  }

  /** Ustawia/usuwa plik rozszerzenia `x-<dostawca>/`. */
  setExtensionFile(vendor: string, path: string, blob: Blob | undefined): void {
    if (!/^x-[a-z0-9][a-z0-9-]*$/i.test(vendor)) return;
    const m = this.#extensions.get(vendor) ?? new Map<string, Blob>();
    if (blob) m.set(path, blob);
    else m.delete(path);
    this.#extensions.set(vendor, m);
    this._markDirty(['extensions', vendor, path]);
  }

  // ------------------------------------------------------------ synteza

  async #identity(cfg: ResolvedConfig, explicit?: SynthesisOverride): Promise<(SynthesisOverride) | null> {
    if (explicit) return explicit;
    const info = await cfg.cap('synth')?.info?.().catch(() => undefined);
    if (info) return info;
    const s = this._manifest.synthesis;
    if (s?.model && s.g2p) return { model: s.model, g2p: s.g2p, ...(s.modelHash ? { modelHash: s.modelHash } : {}), ...(s.engine ? { engine: s.engine } : {}) };
    return null;
  }

  async #inputs(cfg: ResolvedConfig, identity: SynthesisOverride, signal?: AbortSignal): Promise<{ utterances: readonly Utterance[]; inputs: ReconcileInput[]; settings: FitSettings; diagnostics: Diagnostic[] } | KokoErrors> {
    const diagnostics: Diagnostic[] = [];
    let utterances: readonly Utterance[];
    if (cfg.cap('g2p')) {
      const r = await this.#subtitles.resolveUtterances({ config: { plugins: [...cfg.plugins], replacePlugins: true }, ...(signal ? { signal } : {}) });
      if (r instanceof KokoErrors) return r;
      utterances = r;
    } else {
      utterances = this.#subtitles.utterances;
      diagnostics.push(diag('KF002', { params: { capability: 'g2p' } }));
    }
    const st = this.#subtitles.settings;
    const settings: FitSettings = { minGap: st.lektor.MinGap, borrowGap: st.rules.BorrowGap, maxDelay: st.rules.MaxDelay };
    const id = { model: identity.modelHash ?? identity.model, g2p: identity.g2p, ...(identity.voice ? { voice: identity.voice } : {}) };
    const inputs = utterances.map((u) => ({
      id: u.id,
      key: u.key(id),
      start: u.start,
      end: u.end,
      offset: u.params.offset,
      s0: round4(u.params.speed),
      smax: round4(u.params.speed * u.params.maxSpeed),
      gain: u.params.gain,
    }));
    return { utterances, inputs, settings, diagnostics };
  }

  #previousTimeline(identity: SynthesisOverride, diagnostics: Diagnostic[]): TimelineUtterance[] {
    if (this._manifest.profile === 'distribution') {
      diagnostics.push(diag('KP105'));
      return [];
    }
    if (!this._timelineValid || !this._timeline) return [];
    const s = this._manifest.synthesis;
    if (s && !sameSynthesis(s, identity, this.#subtitles)) {
      diagnostics.push(diag('KP010'));
      return [];
    }
    return this._timeline.utterances.filter((u) => u.key) as TimelineUtterance[];
  }

  /** Plan dopasowania (PACK §6.3) bez syntezy — stany kolejnych wypowiedzi mogą być szacunkowe. */
  async reconcile(opts: { config?: CallConfig; signal?: AbortSignal; synthesis?: SynthesisOverride } = {}): Promise<ReconcilePlan | KokoErrors> {
    const cfg = resolveConfig(opts.config);
    const identity = await this.#identity(cfg, opts.synthesis);
    if (!identity) return new KokoErrors([diag('KF002', { level: 'error', params: { capability: 'synth.info' } })]);
    const r = await this.#inputs(cfg, identity, opts.signal);
    if (r instanceof KokoErrors) return r;
    const diagnostics = [...r.diagnostics];
    const prev = this.#previousTimeline(identity, diagnostics);
    const decisions = await reconcileTimeline(r.inputs, prev, r.settings, opts.signal ? { signal: opts.signal } : {});
    return planOf(decisions, diagnostics);
  }

  /**
   * Przebudowa ścieżki lektora (ASS §4.6, PACK §6.3, §4.1). Wymaga pluginów `g2p`, `synth`, `encoder`.
   */
  async rebuild(_plan?: ReconcilePlan, opts: RebuildOptions = {}): Promise<void | KokoErrors> {
    const cfg = resolveConfig(opts.config);
    const g2p = cfg.cap('g2p');
    const synth = cfg.cap('synth');
    const encoder = cfg.cap('encoder');
    for (const [name, cap] of [['g2p', g2p], ['synth', synth], ['encoder', encoder]] as const)
      if (!cap) return new KokoErrors([diag('KF002', { level: 'error', params: { capability: name } })]);
    const identity = await this.#identity(cfg, opts.synthesis);
    if (!identity) return new KokoErrors([diag('KF002', { level: 'error', params: { capability: 'synth.info' } })]);
    const signal = opts.signal;
    const fail = (e: unknown, plugin: string) =>
      signal?.aborted ? new KokoErrors([diag('KF005', { level: 'error' })]) : new KokoErrors([diag('KF004', { params: { plugin, message: String(e) } })]);

    try {
      const r = await this.#inputs(cfg, identity, signal);
      if (r instanceof KokoErrors) return r;
      const lex = this.#subtitles.resolvedLexicon;
      const byId = new Map(r.utterances.map((u) => [u.id, u]));
      const inputById = new Map(r.inputs.map((u) => [u.id, u]));
      const voiceOf = (u: Utterance) => identity.voice ?? u.params.voice;
      const cache = new Map<string, SynthResult>();
      let trackRate = 0;
      const synthesize = async (id: string, speed: number): Promise<SynthResult> => {
        const k = `${id}|${round4(speed)}`;
        const hit = cache.get(k);
        if (hit) return hit;
        if (signal?.aborted) throw new Error('aborted');
        const u = byId.get(id)!;
        const tokens = async (s: CanonicalSegment[]) => {
          let n = 0;
          for (const p of await g2p!.toIpa(s, lex)) n += await g2p!.tokenCount(p);
          return n;
        };
        const parts = await splitSegments(u.segments, tokens);
        const ipa: string[] = [];
        for (const p of parts) ipa.push(...(await g2p!.toIpa(p, lex)));
        const res = await synth!.synthesize({ ipa, voice: voiceOf(u), speed: round4(speed), gainDb: u.params.gain, ...(signal ? { signal } : {}) });
        if (!trackRate) trackRate = res.sampleRate;
        const out: SynthResult = { ...res, durationMs: Math.round((res.pcm.length * 1000) / res.sampleRate) };
        cache.set(k, out);
        return out;
      };

      const diagnostics = [...r.diagnostics];
      const prev = this.#previousTimeline(identity, diagnostics);
      let done = 0;
      const total = r.inputs.length;
      const decisions = await reconcileTimeline(r.inputs, prev, r.settings, {
        ...(signal ? { signal } : {}),
        measure: async (u, speed) => (await synthesize(u.id, speed)).durationMs,
      });
      if (signal?.aborted) return new KokoErrors([diag('KF005', { level: 'error' })]);

      // Stare audio (do ponownego użycia klipów).
      const old = this.#audio;
      let oldPcm: Float32Array | null = null;
      const needsOld = decisions.some((d) => d.state === 'current' || d.state === 'moved');
      if (old && needsOld && encoder!.decode) {
        try {
          const dec = await encoder!.decode(old._blob, old._params.codec as 'mp3' | 'opus');
          oldPcm = dec.pcm;
          if (!trackRate) trackRate = dec.sampleRate;
        } catch {
          oldPcm = null;
        }
      }
      if (!trackRate) trackRate = old?._params.codec === 'mp3' ? old._params.sampleRate : 24000;
      const sr = trackRate;

      // Render PCM nowej ścieżki.
      const fits = decisions.filter((d) => d.fit);
      const lastEnd = fits.reduce((m, d) => Math.max(m, d.fit!.t0 + d.fit!.duration), 0);
      const offset = 0;
      const totalMs = Math.max(this._manifest.video?.duration ?? 0, lastEnd, old ? old._params.offset + old._params.duration : 0);
      const pcm = new Float32Array(Math.ceil((totalMs * sr) / 1000));
      const place = (t0: number, src: Float32Array, durationMs: number, gainDb = 0) => {
        const at = Math.round(((t0 - offset) * sr) / 1000);
        const n = Math.min(src.length, Math.round((durationMs * sr) / 1000), pcm.length - at);
        const g = gainDb ? 10 ** (gainDb / 20) : 1;
        for (let i = 0; i < n; i++) pcm[at + i] = src[i]! * g;
      };
      for (const d of fits) {
        const f = d.fit!;
        const u = inputById.get(d.id!)!;
        const reuseOld = (d.state === 'current' || (d.state === 'moved' && !d.alsoGain)) && oldPcm && old && d.previous;
        if (reuseOld) {
          const p = d.previous!;
          const from = old!._params.encoderDelay + Math.round(((p.clip.start - old!._params.offset) * old!._params.sampleRate) / 1000);
          place(f.t0, oldPcm!.subarray(from, from + Math.round((p.clip.duration * sr) / 1000)), p.clip.duration);
        } else {
          const res = await synthesize(d.id!, f.speed);
          place(f.t0, res.pcm, f.duration, u.gain);
          done++;
          opts.onProgress?.(done, total, d.id!);
        }
      }

      // Kodowanie: podmiana ramek albo całość.
      const codec = opts.codec ?? (old?._params.codec as 'mp3' | 'opus' | undefined) ?? 'mp3';
      let bytes: Uint8Array | null = null;
      let params: AudioParams | null = null;
      let spliceable = false;
      const canSplice =
        codec === 'mp3' && old && old._spliceable && old._params.codec === 'mp3' && encoder!.mp3 && oldPcm &&
        old._params.sampleRate === sr && old._params.offset === 0 && totalMs <= old._params.offset + old._params.duration;
      if (canSplice) {
        let b = new Uint8Array(await old!._blob.arrayBuffer());
        const index = indexFramesSync(b);
        if (index) {
          const regions: [number, number][] = [];
          for (const d of decisions) {
            if (d.state === 'current') continue;
            if (d.fit) regions.push([d.fit.t0, d.fit.t0 + d.fit.duration]);
            if (d.previous) regions.push([d.previous.clip.start, d.previous.clip.start + d.previous.clip.duration]);
          }
          regions.sort((a, c) => a[0] - c[0]);
          const merged: [number, number][] = [];
          for (const rg of regions) {
            const last = merged[merged.length - 1];
            if (last && rg[0] <= last[1] + 200) last[1] = Math.max(last[1], rg[1]);
            else merged.push([...rg]);
          }
          const clips = fits.map((d) => ({ start: d.fit!.t0, duration: d.fit!.duration }));
          const N = index.samplesPerFrame;
          let okSplice = true;
          for (const rg of merged) {
            const res = await spliceRange(b, index, { range: rg, encoderDelay: old!._params.encoderDelay, offset: old!._params.offset, sampleRate: sr, clips }, async (from, frames) => {
              const win = new Float32Array((frames + 4) * N);
              win.set(pcm.subarray(from, from + win.length));
              return encoder!.mp3!(win, { sampleRate: sr, channels: 1, bitrateKbps: index.frames[0]!.bitrateKbps, cbr: true, noReservoir: true, rawFrames: true });
            });
            if (res instanceof KokoErrors) {
              okSplice = false;
              break;
            }
            b = new Uint8Array(res.bytes);
          }
          if (okSplice) {
            bytes = b;
            params = { ...old!._params };
            spliceable = true;
          }
        }
      }
      if (!bytes) {
        if (codec === 'opus') {
          if (!encoder!.opus) return new KokoErrors([diag('KF002', { level: 'error', params: { capability: 'encoder.opus' } })]);
          bytes = await encoder!.opus(pcm, { sampleRate: sr, bitrateKbps: 40, channels: 1 });
          const pr = probeAudio(bytes, 'opus');
          params = { codec: 'opus', sampleRate: 48000, channels: 1, bitrateMode: 'vbr', spliceable: false, encoderDelay: pr?.encoderDelay ?? 312, padding: 0, offset, duration: Math.round(totalMs) };
        } else {
          if (!encoder!.mp3) return new KokoErrors([diag('KF002', { level: 'error', params: { capability: 'encoder.mp3' } })]);
          bytes = await encoder!.mp3(pcm, { sampleRate: sr, channels: 1, bitrateKbps: chooseBitrate(sr), cbr: true, noReservoir: true });
          const pr = probeAudio(bytes, 'mp3');
          spliceable = !!pr?.mp3 && checkSpliceable(pr.mp3, bytes).length === 0 && pr.mp3.encoderDelay !== undefined;
          params = {
            codec: 'mp3', sampleRate: pr?.sampleRate ?? sr, channels: 1, bitrateMode: 'cbr', spliceable,
            encoderDelay: pr?.encoderDelay ?? 0, padding: pr?.padding ?? 0, offset, duration: pr?.duration ?? Math.round(totalMs),
          };
        }
      }
      if (opts.language ?? old?._params.language) params!.language = (opts.language ?? old?._params.language)!;

      // Oś czasu.
      const lineNo = this.#eventLineNumbers();
      const utterances: TimelineUtterance[] = fits.map((d) => {
        const f = d.fit!;
        const u = byId.get(d.id!)!;
        const t: TimelineUtterance = {
          key: d.key!,
          slot: { start: f.t0, end: f.slotEnd },
          clip: { start: f.t0, duration: f.duration },
          baseDuration: f.baseDuration,
          speed: round4(f.speed),
          gain: inputById.get(d.id!)!.gain,
          delay: f.delay,
          diagnostics: f.diagnostics.map((x) => x.code),
          lines: u.lineIds.map((id) => lineNo.get(id) ?? 0).filter((n) => n > 0),
          text: u.text,
        };
        return t;
      });
      const subText = this.#subtitles.toString();
      const subBytes = utf8(subText);
      const subSha = sha256Tag(subBytes);
      const audBlob = new Blob([bytes as Uint8Array<ArrayBuffer>]);
      const ext = params!.codec === 'opus' ? 'opus' : 'mp3';
      const audPath = `audio/lektor.${ext}`;
      const audSha = sha256Tag(bytes, opts.config);
      this.#audio = new AudioTrack(this, audBlob, audPath, params!, audSha, spliceable);
      this._timeline = { version: 1, audio: 'lektor', subtitlesSha256: subSha, utterances };
      this._timelineValid = true;
      this.#subtitlesBytes = subBytes;
      this.#subtitlesDirty = false;
      const st = this.#subtitles.settings;
      const synthesis: SynthesisJson = {
        ...(identity.engine ? { engine: identity.engine } : {}),
        model: identity.model,
        ...(identity.modelHash ? { modelHash: identity.modelHash } : {}),
        g2p: identity.g2p,
        parser: `@koko-anime/formats ${LIB_VERSION}`,
        voice: identity.voice ?? st.lektor.Voice ?? cfg.defaults.voice ?? '',
        ...(st.rules.Numbers === 'auto' ? { numbers: NUMBERS_RULES_VERSION } : {}),
      };
      this._manifest.synthesis = synthesis;
      this._manifest.subtitles = { path: 'subtitles.ass', sha256: subSha, kokoVersion: this.#subtitles.scriptInfo.kokoVersion };
      this._manifest.audio = [{ id: 'lektor', path: audPath, role: 'lektor', ...params!, sha256: audSha }];
      this._manifest.generator = { ...cfg.generator };
      this.#signatures = [];
      this.#cache.clear();
      this.#stale = false;
      this.#diagnostics = [...diagnostics, ...planOf(decisions, []).diagnostics, ...fits.flatMap((d) => d.fit!.diagnostics)];
      this._staleAtom.trigger();
      this._markDirty(['audio']);
      this._core.change([this._timelineAtom, this._audioAtom], { targetId: null, kind: 'replace', path: ['timeline'] });
    } catch (e) {
      return fail(e, cfg.capOwner('synth') ?? '?');
    }
  }

  #eventLineNumbers(): Map<string, number> {
    const lines = this.#subtitles.toString().split('\n');
    const ev = lines.indexOf('[Events]');
    const out = new Map<string, number>();
    if (ev < 0) return out;
    const fmt = ev + 1; // Format:
    this.#subtitles.events.toArray().forEach((e, i) => out.set(e.id, fmt + 2 + i));
    return out;
  }

  // ------------------------------------------------------------ podpisy i wideo

  /** Weryfikacja podpisów (kryptografia + rejestr twórców, PACK §8.1–8.2). */
  async verifySignatures(opts: { config?: CallConfig; trustedKeys?: readonly string[] } = {}): Promise<TrustReport> {
    const cfg = resolveConfig(opts.config);
    const crypto = cfg.cap('crypto');
    const report: TrustReport = { status: 'unsigned', signatures: [], diagnostics: [] };
    if (!this.#signatures.length) return (this.#trust = report);
    if (!crypto) {
      report.diagnostics.push(diag('KF002', { params: { capability: 'crypto' } }));
      report.status = 'unverified';
      return (this.#trust = report);
    }
    const msg = utf8(this.#origManifestJcs ?? jcs(orderManifest(this._manifest)));
    for (const sig of this.#signatures) {
      const entry: TrustReport['signatures'][number] = { keyId: sig.keyId, publicKey: sig.publicKey, status: 'unverified', diagnostics: [] };
      const pk = b64decode(sig.publicKey);
      const sg = b64decode(sig.signature);
      let ok = false;
      try {
        ok = sig.alg === 'ed25519' && !!pk && !!sg && (await crypto.ed25519Verify(msg, sg!, pk!));
      } catch {
        ok = false;
      }
      if (!ok) {
        entry.status = 'untrusted';
        entry.diagnostics.push(diag('KP013', { params: { keyId: sig.keyId } }));
      } else if (opts.trustedKeys?.includes(sig.publicKey)) {
        entry.status = 'trusted-local';
      } else if (sig.registry !== 'koko') {
        entry.status = 'unverified';
        entry.diagnostics.push(diag('KP014', { params: { keyId: sig.keyId } }));
      } else {
        const res = await this.#registryLookup(cfg, sig.keyId);
        if (res === 'unreachable') {
          entry.status = 'unverified';
          entry.diagnostics.push(diag('KP019', { params: { keyId: sig.keyId } }));
        } else if (res === null) {
          entry.status = 'untrusted';
          entry.diagnostics.push(diag('KP018', { params: { keyId: sig.keyId } }));
        } else {
          if (res.displayName) entry.displayName = res.displayName;
          const key = res.keys.find((k) => k.publicKey === sig.publicKey);
          if (!key) {
            entry.status = 'untrusted';
            entry.diagnostics.push(diag('KP018', { params: { keyId: sig.keyId } }));
          } else if (!key.revoked) entry.status = 'verified';
          else if (key.revoked.reason === 'rotated' && Date.parse(sig.created) < Date.parse(key.revoked.at)) entry.status = 'verified-rotated';
          else {
            entry.status = 'untrusted';
            entry.diagnostics.push(diag('KP017', { params: { keyId: sig.keyId, reason: key.revoked.reason } }));
          }
        }
      }
      report.signatures.push(entry);
      report.diagnostics.push(...entry.diagnostics);
    }
    const rank: SignatureStatus[] = ['untrusted', 'unverified', 'verified-rotated', 'trusted-local', 'verified'];
    report.status = report.signatures.map((s) => s.status).sort((a, b) => rank.indexOf(a) - rank.indexOf(b))[0] ?? 'unverified';
    return (this.#trust = report);
  }

  async #registryLookup(cfg: ResolvedConfig, keyId: string): Promise<import('./schemas.ts').RegistryResponse | null | 'unreachable'> {
    const cacheCap = cfg.cap('registryCache');
    const maxAge = (cfg.registry?.cacheDays ?? 7) * 86400000;
    const cached = await cacheCap?.get(keyId).catch(() => undefined);
    const fresh = cached && Date.now() - Date.parse(cached.fetchedAt) < maxAge;
    const fromCache = () => {
      if (!cached) return 'unreachable' as const;
      if (cached.body === null) return null;
      const r = RegistryResponseSchema(cached.body);
      return r instanceof type.errors ? ('unreachable' as const) : r;
    };
    const f = cfg.cap('fetch');
    const url = cfg.registry?.url;
    if (!f || !url || !/^https:\/\//.test(url)) return fromCache();
    if (fresh) return fromCache();
    try {
      const res = await f(`${url.replace(/\/$/, '')}/v1/creators/${encodeURIComponent(keyId)}`);
      if (res.status === 404) {
        await cacheCap?.set(keyId, { fetchedAt: nowIso(), body: null }).catch(() => {});
        return null;
      }
      if (!res.ok) return fromCache();
      const body = await res.json();
      const r = RegistryResponseSchema(body);
      if (r instanceof type.errors) return fromCache();
      await cacheCap?.set(keyId, { fetchedAt: nowIso(), body }).catch(() => {});
      return r;
    } catch {
      return fromCache();
    }
  }

  /** Dopasowanie otwartego wideo (PACK §3): manifest.video, potem `[Koko Sources]`. */
  async matchVideo(file: Blob, name?: string): Promise<VideoMatch> {
    const fp = await videoFingerprint(file);
    const size = file.size;
    const base = name?.split('/').pop();
    const v = this._manifest.video;
    const matches = (x: { fingerprint?: string; size?: number; file?: string; name?: string }) =>
      (x.fingerprint !== undefined && x.fingerprint === fp) ||
      (x.fingerprint === undefined && x.size === size && base !== undefined && (x.file?.split('/').pop() === base || x.name === base));
    if (v && (matches(v) || (v.fingerprint === undefined && v.size === size))) return { match: 'manifest', fingerprint: fp, diagnostics: [] };
    for (const s of this.#subtitles.koko.sources.toArray()) {
      if (!s.valid) continue;
      const src = { ...(s.fingerprint ? { fingerprint: s.fingerprint } : {}), ...(s.size !== undefined ? { size: s.size } : {}), ...(s.file ? { file: s.file } : {}), ...(s.name ? { name: s.name } : {}) };
      if (matches(src) || (s.fingerprint === undefined && s.size === size))
        return { match: 'source', sourceLabel: s.label, fingerprint: fp, diagnostics: [diag('KP009', { level: 'info', params: { source: s.label } })] };
    }
    return { match: 'none', fingerprint: fp, diagnostics: [diag('KP009'), diag('KK008')] };
  }

  // ------------------------------------------------------------ zapis

  /** Zapis paczki (PACK §2). Paczka nieaktualna → KF003. */
  async toBlob(opts: ToBlobOptions = {}): Promise<Blob | KokoErrors> {
    const cfg = resolveConfig(opts.config);
    const profile = opts.profile ?? this._manifest.profile;
    if (this.#stale) return new KokoErrors([diag('KF003', { level: 'error' })]);
    if (!this.#audio || !this._timeline) return new KokoErrors([diag('KF003', { level: 'error', params: { reason: 'no-audio' } })]);
    const signers = opts.sign ? (Array.isArray(opts.sign) ? opts.sign : [opts.sign]) : [];
    if (!this.#dirty && profile === this._manifest.profile && !signers.length && this.#input) return this.#input;

    const subBytes = !this.#subtitlesDirty && this.#subtitlesBytes ? this.#subtitlesBytes : utf8(this.#subtitles.toString());
    const tl: TimelineJson =
      profile === 'distribution'
        ? { version: 1, audio: 'lektor', subtitlesSha256: this._timeline.subtitlesSha256, utterances: this._timeline.utterances.map((u) => ({ clip: { ...u.clip } })) }
        : { ...this._timeline, utterances: this._timeline.utterances.map((u) => orderUtterance(u as TimelineUtterance)) };
    const tlBytes = utf8(canonicalJson(tl));
    const a = this.#audio;
    const manifest = orderManifest({
      ...structuredClone(this._manifest),
      profile,
      subtitles: { path: 'subtitles.ass', sha256: sha256Tag(subBytes, opts.config), kokoVersion: this.#subtitles.scriptInfo.kokoVersion },
      audio: [{ id: 'lektor', path: a._path, role: 'lektor', ...a._params, sha256: a._sha256 }],
      timeline: { path: 'timeline.json', sha256: sha256Tag(tlBytes, opts.config) },
    });
    const manBytes = utf8(canonicalJson(manifest));
    const manJcs = jcs(manifest);

    let signatures = this.#origManifestJcs === manJcs ? [...this.#signatures] : [];
    if (signers.length) {
      const crypto = cfg.cap('crypto');
      if (!crypto) return new KokoErrors([diag('KF002', { level: 'error', params: { capability: 'crypto' } })]);
      signatures = [];
      for (const k of signers) {
        const pub = k.publicKey ?? (await crypto.ed25519PublicKey?.(k.privateKey));
        if (!pub) return new KokoErrors([diag('KF002', { level: 'error', params: { capability: 'crypto.ed25519PublicKey' } })]);
        const sig = await crypto.ed25519Sign(utf8(manJcs), k.privateKey);
        signatures.push({ alg: 'ed25519', keyId: k.keyId, ...(k.registry ? { registry: k.registry } : {}), publicKey: b64encode(pub), created: nowIso(), signature: b64encode(sig) });
      }
    }

    const entries: ZipWriteEntry[] = [
      { name: 'mimetype', data: utf8(MIMETYPE), method: 'store' },
      { name: 'manifest.json', data: manBytes, method: 'deflate' },
      { name: 'subtitles.ass', data: subBytes, method: 'deflate' },
      { name: a._path, data: a._blob, method: 'store' },
      { name: 'timeline.json', data: tlBytes, method: 'deflate' },
    ];
    if (signatures.length) entries.push({ name: 'signatures.json', data: utf8(canonicalJson({ version: 1, signatures })), method: 'deflate' });
    if (profile === 'full') for (const [p, b] of [...this.#cache].sort(([x], [y]) => (x < y ? -1 : 1))) entries.push({ name: `cache/${p}`, data: b, method: 'deflate' });
    for (const [vendor, files] of [...this.#extensions].sort(([x], [y]) => (x < y ? -1 : 1)))
      for (const [p, b] of [...files].sort(([x], [y]) => (x < y ? -1 : 1))) entries.push({ name: `${vendor}/${p}`, data: b, method: 'deflate' });
    return writeZip(entries);
  }
}

function sameSynthesis(s: SynthesisJson, current: SynthesisOverride, subs: KokoAss): boolean {
  const model = (x: { model?: string; modelHash?: string }) => x.modelHash ?? x.model;
  if (model(s) !== model(current) || s.g2p !== current.g2p) return false;
  const voice = current.voice ?? subs.settings.lektor.Voice;
  if (voice !== undefined && s.voice !== undefined && s.voice !== voice) return false;
  const numbers = subs.settings.rules.Numbers === 'auto' ? NUMBERS_RULES_VERSION : undefined;
  if (numbers !== undefined && s.numbers !== undefined && s.numbers !== numbers) return false;
  return true;
}

function planOf(decisions: ReconcileDecision[], diagnostics: Diagnostic[]): ReconcilePlan {
  const counts = { current: 0, moved: 0, recompute: 0, new: 0, gain: 0, orphaned: 0 };
  for (const d of decisions) counts[d.state]++;
  const out = [...diagnostics];
  if (counts.new + counts.recompute) out.push(diag('KP101', { params: { new: counts.new, recompute: counts.recompute } }));
  if (counts.moved) out.push(diag('KP102', { params: { count: counts.moved } }));
  if (counts.orphaned) out.push(diag('KP103', { params: { count: counts.orphaned } }));
  const gain = counts.gain + decisions.filter((d) => d.alsoGain).length;
  if (gain) out.push(diag('KP106', { params: { count: gain } }));
  return Object.freeze({
    items: Object.freeze(decisions.map((d) => ({ utteranceId: d.id, state: d.state, key: d.key, ...(d.alsoGain ? { alsoGain: true } : {}) }))),
    counts: Object.freeze(counts),
    diagnostics: Object.freeze(out),
  });
}

export { sha256Bytes };
