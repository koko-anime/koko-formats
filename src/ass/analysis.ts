/**
 * Analiza deterministyczna Koko-ASS (§4.1–§4.5) i segmenty kanoniczne (Koko-Pack §6.2).
 * Czyste funkcje na migawce danych dokumentu — wynik MUSI być identyczny w każdej implementacji.
 */
import { diag, type Diagnostic, type DiagnosticLevel, type ExtensionDiagnosticCode } from '../core/diagnostics.ts';
import { jcs, round4, sha256Tag } from '../core/hash.ts';
import type { CanonicalSegment, ResolvedLexiconEntry, RuleSettings, TextNormalizer } from '../core/plugin-types.ts';
import { compileSkipRegex, foldCase, isWordChar, matchesAny, wildcardMatch } from '../core/text.ts';
import { expandNumbers, NUMBERS_RULES_VERSION } from '../numbers/expand.ts';
import type { EffectiveLexiconEntry } from '../lexicon/lexicon.ts';
import { isLineFlag, isLinePair, tokenizeText, type LineFlag } from './kk.ts';
import { LEKTOR_KEYS, RULES_KEYS, type LektorKeys, type RulesKeys, type KeySpec } from './settings.ts';

// ---------------------------------------------------------------- migawka wejściowa

/** @internal */
export interface EventInput {
  id: string;
  index: number;
  type: string;
  start: number;
  end: number;
  style: string;
  name: string;
  effect: string;
  text: string;
}

/** @internal */
export interface SettingInput {
  id: string;
  key: string;
  raw: string;
}

/** @internal */
export interface StyleRuleInput {
  id: string;
  pattern: string;
  skip: boolean;
  params: { key: string; value: string }[];
}

/** @internal */
export interface EpisodeLexiconInput {
  id: string;
  key: string;
  stem: boolean;
  value: string;
}

/** @internal */
export interface AnalysisInput {
  events: readonly EventInput[];
  lektor: readonly SettingInput[];
  rules: readonly SettingInput[];
  styles: readonly StyleRuleInput[];
  lexicon: readonly EpisodeLexiconInput[];
  series: readonly EffectiveLexiconEntry[] | null;
  defaultVoice: string | undefined;
  /** Aktywne normalizatory pluginów (bez wbudowanego etapu liczb). */
  normalizers: readonly NormalizerInput[];
  /** Nadpisania komunikatów (diagnostyki `X:`). */
  messages: Partial<Record<string, { title?: string; hint?: string }>>;
}

/** @internal Normalizator pluginu po rozstrzygnięciu konfiguracji. */
export interface NormalizerInput {
  id: string;
  order: number;
  owner: string;
  normalize: TextNormalizer['normalize'];
}

/** Zamiana tekstu wykonana przez normalizator (§2.10). */
export interface LineReplacement {
  /** `id` normalizatora. */
  readonly normalizer: string;
  /** Tekst przed. */
  readonly from: string;
  /** Tekst po. */
  readonly to: string;
  /** Indeks w tekście wejściowym etapu. */
  readonly index: number;
}

// ---------------------------------------------------------------- wynik

/** Powód pominięcia linii (Koko-ASS §4.1). */
export type SkipReason = 'comment' | 'empty' | 'annotation' | 'skipStyle' | 'notInReadStyles' | 'effect' | 'noActor' | 'match';

/** Analiza linii (Koko-ASS §4.1–§4.2). */
export interface LineAnalysis {
  /** Czy linia jest czytana. */
  readonly read: boolean;
  /** Powód pominięcia (gdy `read = false`). */
  readonly skipReason?: SkipReason;
  /** Tekst mówiony po czyszczeniu (§4.2), z liczbami przy `Numbers = auto`; IPA w `/…/`, pauzy jako `[Nms]`. */
  readonly spokenText: string;
  /** Tekst wyświetlany po czyszczeniu (bez `say=`), używany przez `SkipIfMatch`. */
  readonly displayText: string;
  /** ID wypowiedzi, do której należy linia. */
  readonly utteranceId?: string;
  /** Zamiany wykonane przez normalizatory pluginów (podgląd). */
  readonly replacements?: readonly LineReplacement[];
  /** Diagnostyki tej linii. */
  readonly diagnostics: readonly Diagnostic[];
}

/** Parametry wypowiedzi po dziedziczeniu (Koko-ASS §4.5). */
export interface UtteranceParams {
  /** Prędkość bazowa `s0` = `Speed` × styl × linia (po `round4`). */
  speed: number;
  /** Maksymalne przyspieszenie (`MaxSpeed` albo `maxspeed=`). */
  maxSpeed: number;
  /** Gain w dB = `Gain` + styl + linia. */
  gain: number;
  /** Przesunięcie startu w ms = `Offset` + linia. */
  offset: number;
  /** Efektywny głos. */
  voice: string;
  /** Etykieta `mode=` ze stylu. */
  mode?: string;
}

/** @internal */
export interface UtteranceData {
  id: string;
  lineIds: string[];
  start: number;
  end: number;
  params: UtteranceParams;
  segments: CanonicalSegment[];
  /** Segmenty każdej linii osobno (do rozbicia grup, KK302). */
  lineSegments: CanonicalSegment[][];
  text: string;
}

/** Efektywne ustawienia `[Koko Lektor]` i `[Koko Rules]` (z wartościami domyślnymi). */
export interface EffectiveSettings {
  /** `[Koko Lektor]`. */
  lektor: LektorKeys;
  /** `[Koko Rules]`. */
  rules: RulesKeys;
}

/** @internal */
export interface AnalysisResult {
  settings: EffectiveSettings;
  lines: Map<string, LineAnalysis>;
  utterances: UtteranceData[];
  lexicon: ResolvedLexiconEntry[];
  diagnostics: Diagnostic[];
}

// ---------------------------------------------------------------- ustawienia

function effective<T extends object>(table: { [K in keyof T]: KeySpec<T[K]> }, items: readonly SettingInput[], diags: Diagnostic[]): T {
  const out = {} as T;
  for (const k of Object.keys(table) as (keyof T)[]) out[k] = table[k].default;
  for (const it of items) {
    const key = (Object.keys(table) as (keyof T)[]).find((k) => foldCase(String(k)) === foldCase(it.key));
    if (!key) continue; // KK001 zgłaszane przy parsowaniu
    const v = table[key].parse(it.raw);
    if (v === undefined) {
      diags.push(diag('KK006', { targetId: it.id, params: { key: String(key), value: it.raw } }));
      out[key] = table[key].default;
    } else out[key] = v;
  }
  return out;
}

/** @internal */
export function effectiveSettings(input: Pick<AnalysisInput, 'lektor' | 'rules'>, diags: Diagnostic[] = []): EffectiveSettings {
  return {
    lektor: effective<LektorKeys>(LEKTOR_KEYS as never, input.lektor, diags),
    rules: effective<RulesKeys>(RULES_KEYS as never, input.rules, diags),
  };
}

// ---------------------------------------------------------------- adnotacje i czyszczenie

type Piece =
  | { t: 'ch'; c: string }
  | { t: 'nl' }
  | { t: 'open'; kind: 'ipa' | 'sub'; value: string }
  | { t: 'close' }
  | { t: 'pause'; ms: number };

/** Część tekstu mówionego po czyszczeniu. */
type Part =
  | { t: 'text'; s: string }
  | { t: 'range'; kind: 'ipa' | 'sub'; value: string; original: string }
  | { t: 'pause'; ms: number };

interface LineKk {
  flags: Set<LineFlag>;
  say?: string;
  speed?: number;
  maxspeed?: number;
  gain?: number;
  offset?: number;
  pieces: Piece[];
  hasRanges: boolean;
}

const NUM_RE = /^[+-]?(\d+(\.\d*)?|\.\d+)$/;

function parseLine(text: string, lineId: string, diags: Diagnostic[]): LineKk {
  const res: LineKk = { flags: new Set(), pieces: [], hasRanges: false };
  let open = false;
  let drawing = false;
  for (const tok of tokenizeText(text)) {
    if (tok.kind === 'block') {
      if (tok.badKk) diags.push(diag('KK003', { targetId: lineId, params: { block: tok.s } }));
      else {
        const re = /\\p(\d+)/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(tok.s))) drawing = Number(m[1]) > 0;
      }
      continue;
    }
    if (tok.kind === 'text') {
      if (drawing) continue;
      const s = tok.s;
      for (let i = 0; i < s.length; i++) {
        const c = s[i]!;
        if (c === '\\' && (s[i + 1] === 'N' || s[i + 1] === 'n' || s[i + 1] === 'h')) {
          res.pieces.push(s[i + 1] === 'N' ? { t: 'nl' } : { t: 'ch', c: ' ' });
          i++;
          continue;
        }
        res.pieces.push({ t: 'ch', c });
      }
      continue;
    }
    for (const it of tok.items) {
      if (it.type === 'close') {
        if (open) {
          res.pieces.push({ t: 'close' });
          open = false;
        } else diags.push(diag('KK003', { targetId: lineId, params: { reason: 'close-without-open' } }));
        continue;
      }
      if (it.type === 'flag') {
        if (isLineFlag(it.name)) res.flags.add(it.name);
        else if (isLinePair(it.name) || it.name === 'ipa' || it.name === 'sub' || it.name === 'pause')
          diags.push(diag('KK003', { targetId: lineId, params: { key: it.name } }));
        else diags.push(diag('KK001', { targetId: lineId, params: { key: it.name } }));
        continue;
      }
      const { name, value } = it;
      if (isLineFlag(name)) {
        diags.push(diag('KK003', { targetId: lineId, params: { key: name, value } }));
        continue;
      }
      if (name === 'say') {
        res.say = value;
        continue;
      }
      if (name === 'speed' || name === 'maxspeed' || name === 'gain' || name === 'offset') {
        const okNum = NUM_RE.test(value.trim());
        const n = Number(value);
        const valid = okNum && Number.isFinite(n) && (name === 'speed' ? n > 0 : name === 'maxspeed' ? n >= 1 && n <= 3 : true);
        if (!valid) diags.push(diag('KK006', { targetId: lineId, params: { key: name, value } }));
        else res[name] = n;
        continue;
      }
      if (name === 'ipa' || name === 'sub') {
        if (value.trim() === '') {
          diags.push(diag('KK006', { targetId: lineId, params: { key: name, value } }));
          continue;
        }
        if (open) {
          res.pieces.push({ t: 'close' });
          diags.push(diag('KK003', { targetId: lineId, params: { reason: 'nested-range' } }));
        }
        res.pieces.push({ t: 'open', kind: name, value });
        res.hasRanges = true;
        open = true;
        continue;
      }
      if (name === 'pause') {
        const n = Number(value);
        if (!/^\d+$/.test(value.trim()) || !Number.isFinite(n)) diags.push(diag('KK006', { targetId: lineId, params: { key: name, value } }));
        else res.pieces.push({ t: 'pause', ms: n });
        continue;
      }
      diags.push(diag('KK001', { targetId: lineId, params: { key: name } }));
    }
  }
  if (open) {
    res.pieces.push({ t: 'close' });
    diags.push(diag('KK004', { targetId: lineId }));
  }
  if (res.flags.has('read') && res.flags.has('skip')) diags.push(diag('KK011', { targetId: lineId, params: { flags: 'read+skip' } }));
  if (res.flags.has('join') && res.flags.has('nojoin')) diags.push(diag('KK011', { targetId: lineId, params: { flags: 'join+nojoin' } }));
  return res;
}

function piecesFromPlain(s: string): Piece[] {
  const out: Piece[] = [];
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === '\\' && (s[i + 1] === 'N' || s[i + 1] === 'n' || s[i + 1] === 'h')) {
      out.push(s[i + 1] === 'N' ? { t: 'nl' } : { t: 'ch', c: ' ' });
      i++;
      continue;
    }
    out.push({ t: 'ch', c });
  }
  return out;
}

const QUOTES = /[„”“"«»]/g;
const DASHES = new Set(['-', '–', '—']);

/** Kroki 4–7 §4.2 na sekwencji kawałków. Zwraca części (z pojedynczymi spacjami na brzegach) i tekst wyświetlany. */
function clean(pieces: Piece[], removeQuotes: boolean): { parts: Part[]; display: string } {
  // Krok 5: myślniki dialogowe na początku linii i po \N.
  const seq: Piece[] = [];
  let atLineStart = true;
  let dashes = 0;
  for (let i = 0; i < pieces.length; i++) {
    const p = pieces[i]!;
    if (p.t === 'nl') {
      seq.push({ t: 'ch', c: ' ' });
      atLineStart = true;
      continue;
    }
    if (atLineStart) {
      if (p.t === 'ch' && /\s/u.test(p.c)) {
        seq.push(p);
        continue;
      }
      if (p.t === 'ch' && DASHES.has(p.c)) {
        const next = pieces[i + 1];
        if (next && next.t === 'ch' && /\s/u.test(next.c)) {
          dashes++;
          if (dashes > 1) seq.push({ t: 'pause', ms: 150 });
          i++; // pomiń myślnik i spację
          atLineStart = false;
          continue;
        }
      }
      if (p.t === 'ch') atLineStart = false;
    }
    seq.push(p);
  }
  // Budowa części.
  const parts: Part[] = [];
  let buf = '';
  let range: { kind: 'ipa' | 'sub'; value: string; original: string } | null = null;
  const flush = () => {
    if (buf) parts.push({ t: 'text', s: buf });
    buf = '';
  };
  for (const p of seq) {
    if (p.t === 'ch') {
      if (range) range.original += p.c;
      else buf += p.c;
    } else if (p.t === 'open') {
      flush();
      range = { kind: p.kind, value: p.value, original: '' };
    } else if (p.t === 'close') {
      if (range) parts.push({ t: 'range', ...range });
      range = null;
    } else if (p.t === 'pause') {
      if (range) {
        parts.push({ t: 'range', ...range });
        range = null;
      }
      flush();
      parts.push(p);
    }
  }
  if (range) parts.push({ t: 'range', ...range });
  flush();
  // Kroki 6–7: białe znaki, cudzysłowy.
  const display = parts
    .map((p) => (p.t === 'text' ? p.s : p.t === 'range' ? p.original : ' '))
    .join('')
    .replace(/\s+/gu, ' ')
    .trim();
  const out: Part[] = [];
  for (const p of parts) {
    if (p.t === 'text') {
      let s = removeQuotes ? p.s.replace(QUOTES, '') : p.s;
      s = s.replace(/\s+/gu, ' ');
      if (s) out.push({ t: 'text', s });
    } else if (p.t === 'range') {
      out.push({ ...p, original: p.original.replace(/\s+/gu, ' ').trim() });
    } else out.push(p);
  }
  // przycięcie brzegów
  const first = out.findIndex((p) => p.t !== 'pause');
  if (first >= 0) {
    const f = out[first]!;
    if (f.t === 'text') f.s = f.s.replace(/^\s+/u, '');
  }
  for (let i = out.length - 1; i >= 0; i--) {
    const l = out[i]!;
    if (l.t === 'pause') continue;
    if (l.t === 'text') l.s = l.s.replace(/\s+$/u, '');
    break;
  }
  return { parts: out.filter((p) => p.t !== 'text' || p.s !== ''), display };
}

function partsEmpty(parts: Part[]): boolean {
  return !parts.some((p) => (p.t === 'text' && p.s.trim() !== '') || p.t === 'range');
}

// ---------------------------------------------------------------- leksykon

interface LexPattern {
  words: number[][]; // punkty kodowe po case folding
  stem: boolean;
  kind: 'ipa' | 'respell';
  value: string;
  keyLength: number;
  key: string;
}

function foldedCodePoints(s: string): number[] {
  return [...foldCase(s)].map((c) => c.codePointAt(0)!);
}

function buildPatterns(lex: ResolvedLexiconEntry[]): LexPattern[] {
  return lex.map((e) => {
    const words = e.key.trim().split(/\s+/u).map(foldedCodePoints);
    return { words, stem: e.stem, kind: e.kind, value: e.value, keyLength: [...e.key].length, key: e.key };
  });
}

/** @internal Leksykon odcinka + serii (wpisy serii pokrywające się z kluczem odcinka są pomijane w całości). */
export function resolveLexicon(episode: readonly EpisodeLexiconInput[], series: readonly EffectiveLexiconEntry[] | null): ResolvedLexiconEntry[] {
  // Ostatni wpis odcinka o danym kluczu wygrywa (KK010).
  const byKey = new Map<string, EpisodeLexiconInput>();
  for (const e of episode) byKey.set(foldCase(e.key), e);
  const out: ResolvedLexiconEntry[] = [];
  for (const e of byKey.values()) {
    const respell = e.value.startsWith('~');
    out.push({ key: e.key, stem: e.stem, kind: respell ? 'respell' : 'ipa', value: respell ? e.value.slice(1) : e.value, origin: 'episode' });
  }
  if (series) {
    for (const s of series) {
      const words = [s.key, ...s.aliases, ...s.forms.map(([k]) => k)];
      if (words.some((w) => byKey.has(foldCase(w)))) continue;
      out.push({ key: s.key, stem: s.stem, kind: s.kind, value: s.value, origin: 'series' });
      for (const a of s.aliases) out.push({ key: a, stem: s.stem, kind: s.kind, value: s.value, origin: 'series' });
      for (const [k, v] of s.forms) out.push({ key: k, stem: false, kind: s.kind, value: v, origin: 'series' });
    }
  }
  return out;
}

interface Unit {
  t: 'text' | 'ipa' | 'pause';
  s: string;
  ms?: number;
  /** Zakres źródłowy objęty leksykonem/zakresem (nie sprawdzany przez KK102). */
  protected?: boolean;
}

interface LexMatch {
  from: number;
  to: number; // koniec klucza (UTF-16)
  end: number; // koniec z końcówką (stem)
  pattern: LexPattern;
}

function matchAt(s: string, cps: { cp: number; off: number }[], start: number, pat: LexPattern): LexMatch | null {
  let k = start;
  for (let w = 0; w < pat.words.length; w++) {
    const word = pat.words[w]!;
    if (w > 0) {
      let ws = 0;
      while (k < cps.length && /\s/u.test(String.fromCodePoint(cps[k]!.cp))) {
        k++;
        ws++;
      }
      if (ws === 0) return null;
    }
    for (let i = 0; i < word.length; i++) {
      const c = cps[k + i];
      if (!c) return null;
      const folded = foldedCodePoints(String.fromCodePoint(c.cp))[0];
      if (folded !== word[i]) return null;
    }
    k += word.length;
  }
  const keyEndOff = k < cps.length ? cps[k]!.off : s.length;
  const nextIsWord = k < cps.length && isWordChar(String.fromCodePoint(cps[k]!.cp));
  if (!pat.stem) {
    if (nextIsWord) return null;
    return { from: cps[start]!.off, to: keyEndOff, end: keyEndOff, pattern: pat };
  }
  let e = k;
  while (e < cps.length && isWordChar(String.fromCodePoint(cps[e]!.cp))) e++;
  const endOff = e < cps.length ? cps[e]!.off : s.length;
  return { from: cps[start]!.off, to: keyEndOff, end: endOff, pattern: pat };
}

function applyLexicon(s: string, patterns: LexPattern[]): Unit[] {
  if (!patterns.length || !s) return [{ t: 'text', s }];
  const cps: { cp: number; off: number }[] = [];
  for (let off = 0; off < s.length; ) {
    const cp = s.codePointAt(off)!;
    cps.push({ cp, off });
    off += cp > 0xffff ? 2 : 1;
  }
  const units: Unit[] = [];
  let last = 0;
  let i = 0;
  while (i < cps.length) {
    const ch = String.fromCodePoint(cps[i]!.cp);
    const prev = i > 0 ? String.fromCodePoint(cps[i - 1]!.cp) : undefined;
    if (!isWordChar(ch) || isWordChar(prev)) {
      i++;
      continue;
    }
    let best: LexMatch | null = null;
    for (const p of patterns) {
      const m = matchAt(s, cps, i, p);
      if (m && (!best || p.keyLength > best.pattern.keyLength)) best = m;
    }
    if (!best) {
      i++;
      continue;
    }
    if (best.from > last) units.push({ t: 'text', s: s.slice(last, best.from) });
    units.push(best.pattern.kind === 'ipa' ? { t: 'ipa', s: best.pattern.value, protected: true } : { t: 'text', s: best.pattern.value, protected: true });
    if (best.end > best.to) units.push({ t: 'text', s: s.slice(best.to, best.end), protected: true });
    last = best.end;
    while (i < cps.length && cps[i]!.off < best.end) i++;
  }
  if (last < s.length) units.push({ t: 'text', s: s.slice(last) });
  return units;
}

// ---------------------------------------------------------------- segmenty kanoniczne

/**
 * @internal Normalizacja segmentów (PACK §6.2): scalanie tekstu, białe znaki, pauzy, `g`.
 */
export function canonicalSegments(units: readonly Unit[]): CanonicalSegment[] {
  const out: CanonicalSegment[] = [];
  let prevTrailingWs = false;
  let pendingSpace = false;
  for (const u of units) {
    if (u.t === 'pause') {
      const last = out[out.length - 1];
      if (last && last.t === 'pause') last.ms += u.ms!;
      else out.push({ t: 'pause', ms: u.ms! });
      pendingSpace = false;
      prevTrailingWs = false;
      continue;
    }
    const lead = /^\s/u.test(u.s);
    const trail = /\s$/u.test(u.s);
    const core = u.s.replace(/\s+/gu, ' ').trim();
    if (!core) {
      if (u.s.length) pendingSpace = true;
      continue;
    }
    const prev = out[out.length - 1];
    const glued = !!prev && prev.t !== 'pause' && !pendingSpace && !prevTrailingWs && !lead;
    if (u.t === 'text' && prev && prev.t === 'text') {
      prev.s += (glued ? '' : ' ') + core;
    } else {
      const seg: CanonicalSegment = u.t === 'ipa' ? { t: 'ipa', s: core } : { t: 'text', s: core };
      if (glued) (seg as { g?: true }).g = true;
      out.push(seg);
    }
    pendingSpace = false;
    prevTrailingWs = trail;
  }
  while (out.length && out[0]!.t === 'pause') out.shift();
  while (out.length && out[out.length - 1]!.t === 'pause') out.pop();
  return out;
}

/** Czytelny tekst: IPA w `/…/`, pauzy jako `[Nms]`. */
export function segmentsText(segs: readonly CanonicalSegment[]): string {
  let s = '';
  for (const seg of segs) {
    if (seg.t === 'pause') {
      s += `${s ? ' ' : ''}[${seg.ms}ms]`;
      continue;
    }
    const piece = seg.t === 'ipa' ? `/${seg.s}/` : seg.s;
    s += s && !seg.g ? ` ${piece}` : piece;
  }
  return s;
}

/** Tożsamość syntezy wchodząca do klucza wypowiedzi (Koko-Pack §6.2). */
export interface SynthesisIdentity {
  /** `synthesis.modelHash` albo `synthesis.model`. */
  model: string;
  /** G2P z wersją. */
  g2p: string;
  /** Efektywny głos — domyślnie z wypowiedzi. */
  voice?: string;
}

/** Klucz wypowiedzi (PACK §6.2). */
export function utteranceKey(u: { readonly segments: readonly CanonicalSegment[]; readonly params: Readonly<UtteranceParams> }, id: SynthesisIdentity, numbersAuto: boolean): string {
  const obj: Record<string, unknown> = {
    v: 1,
    model: id.model,
    g2p: id.g2p,
    voice: id.voice ?? u.params.voice,
    speed: round4(u.params.speed),
    segments: u.segments,
  };
  if (numbersAuto) obj.numbers = NUMBERS_RULES_VERSION;
  return sha256Tag(jcs(obj));
}

// ---------------------------------------------------------------- KK102

const SENTENCE_END = /[.!?…:]/u;
const IGNORABLE_BEFORE = /[\s„”“"«»'()[\]]/u;

function checkNames(units: Unit[], ignore: readonly string[], lineId: string, diags: Diagnostic[]): void {
  let sentenceStart = true;
  let lastSig: string | null = null;
  const ignoreFolded = ignore.map((p) => foldCase(p));
  for (const u of units) {
    if (u.t === 'pause') {
      sentenceStart = true;
      continue;
    }
    if (u.protected || u.t === 'ipa') {
      if (u.s.trim()) {
        sentenceStart = false;
        lastSig = 'x';
      }
      continue;
    }
    const re = /[\p{L}\p{M}\p{N}]+/gu;
    let m: RegExpExecArray | null;
    let pos = 0;
    while ((m = re.exec(u.s))) {
      const between = u.s.slice(pos, m.index);
      for (const ch of between) if (!IGNORABLE_BEFORE.test(ch)) lastSig = ch;
      const atStart = sentenceStart || (lastSig !== null && SENTENCE_END.test(lastSig));
      const w = m[0];
      if (!atStart && /^\p{Lu}/u.test(w)) {
        const fw = foldCase(w);
        if (!ignoreFolded.some((p) => wildcardMatch(p, fw))) diags.push(diag('KK102', { targetId: lineId, params: { word: w } }));
      }
      sentenceStart = false;
      lastSig = w[w.length - 1]!;
      pos = m.index + w.length;
    }
    for (const ch of u.s.slice(pos)) if (!IGNORABLE_BEFORE.test(ch)) lastSig = ch;
  }
}

// ---------------------------------------------------------------- analiza

/** Język tekstu Koko-ASS v1 (kontekst normalizatorów). */
const DOCUMENT_LANGUAGE = 'pl';
/** Wbudowany etap rozwijania liczb (`Numbers = auto`). */
const NUMBERS_STAGE = Object.freeze({ id: 'koko/numbers-pl', order: 500, owner: '@koko-anime/formats' });
type PipelineStage = NormalizerInput | typeof NUMBERS_STAGE;

/** @internal Diagnostyka `X:` z pluginu (reguły, normalizatory). */
export function extensionDiag(
  d: { code: ExtensionDiagnosticCode; level?: DiagnosticLevel; title?: string; hint?: string; params?: Readonly<Record<string, string | number | boolean>> },
  targetId: string | undefined,
  messages: Partial<Record<string, { title?: string; hint?: string }>>,
): Diagnostic {
  const o = messages[d.code];
  const out: Diagnostic = {
    code: d.code,
    level: d.level ?? 'info',
    title: o?.title ?? d.title ?? d.code,
    params: Object.freeze({ ...(d.params ?? {}) }),
    source: 'ass',
  };
  const hint = o?.hint ?? d.hint;
  if (hint !== undefined) out.hint = hint;
  if (targetId !== undefined) out.targetId = targetId;
  return out;
}

interface LineWork {
  ev: EventInput;
  kk: LineKk;
  read: boolean;
  replacements: LineReplacement[];
  skipReason?: SkipReason;
  units: Unit[];
  spoken: string;
  display: string;
  params: UtteranceParams;
  diags: Diagnostic[];
}

function styleRule(rules: readonly StyleRuleInput[], style: string): StyleRuleInput | undefined {
  return rules.find((r) => wildcardMatch(r.pattern, style));
}

/** @internal Pełna analiza dokumentu. */
export function analyze(input: AnalysisInput): AnalysisResult {
  const diagnostics: Diagnostic[] = [];
  const settings = effectiveSettings(input, diagnostics);
  const { lektor, rules } = settings;
  const lexicon = resolveLexicon(input.lexicon, rules.SeriesLexicon.toLowerCase() === 'none' ? null : input.series);
  const patterns = buildPatterns(lexicon);
  const skipRe = rules.SkipIfMatch ? compileSkipRegex(rules.SkipIfMatch) : null;
  const rawSkip = input.rules.find((r) => foldCase(r.key) === 'skipifmatch');
  if (rawSkip && !compileSkipRegex(rawSkip.raw.trim())) {
    // KK006 już zgłoszone przez effective()
  }
  const numbersAuto = rules.Numbers === 'auto';
  const pipeline: PipelineStage[] = [...input.normalizers, ...(numbersAuto ? [NUMBERS_STAGE] : [])].sort(
    (a, b) => a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );

  // Parametry stylów [Koko Styles]: walidacja.
  for (const r of input.styles) {
    for (const p of r.params) {
      if (p.key === 'speed' || p.key === 'gain') {
        if (!NUM_RE.test(p.value) || (p.key === 'speed' && Number(p.value) <= 0)) diagnostics.push(diag('KK006', { targetId: r.id, params: { key: p.key, value: p.value } }));
      } else if (p.key === 'mode') {
        if (!['speech', 'thought', 'flashback'].includes(p.value)) diagnostics.push(diag('KK006', { targetId: r.id, params: { key: p.key, value: p.value } }));
      } else diagnostics.push(diag('KK001', { targetId: r.id, params: { key: p.key } }));
    }
  }
  const styleParam = (r: StyleRuleInput | undefined, key: string): number | undefined => {
    const p = r?.params.find((x) => x.key === key);
    if (!p || !NUM_RE.test(p.value)) return undefined;
    const n = Number(p.value);
    return key === 'speed' && n <= 0 ? undefined : n;
  };

  const voice = lektor.Voice ?? input.defaultVoice ?? '';
  const works: LineWork[] = [];
  for (const ev of input.events) {
    if (ev.type !== 'Dialogue' && ev.type !== 'Comment') continue;
    const ld: Diagnostic[] = [];
    const kk = parseLine(ev.text, ev.id, ld);
    const rule = styleRule(input.styles, ev.style);
    const params: UtteranceParams = {
      speed: lektor.Speed * (styleParam(rule, 'speed') ?? 1) * (kk.speed ?? 1),
      gain: lektor.Gain + (styleParam(rule, 'gain') ?? 0) + (kk.gain ?? 0),
      offset: lektor.Offset + (kk.offset ?? 0),
      maxSpeed: kk.maxspeed ?? rules.MaxSpeed,
      voice,
    };
    const mode = rule?.params.find((p) => p.key === 'mode')?.value;
    if (mode) params.mode = mode;

    const displayClean = clean(kk.pieces, false);
    let spokenParts: Part[];
    if (kk.say !== undefined) {
      if (kk.hasRanges) ld.push(diag('KK005', { targetId: ev.id }));
      spokenParts = clean(piecesFromPlain(kk.say), true).parts;
    } else spokenParts = clean(kk.pieces, true).parts;

    const w: LineWork = { ev, kk, read: false, replacements: [], units: [], spoken: '', display: displayClean.display, params, diags: ld };
    // §4.1
    const flags = kk.flags;
    const empty = partsEmpty(spokenParts);
    if (ev.type === 'Comment') w.skipReason = 'comment';
    else if (flags.has('read')) {
      if (empty) w.skipReason = 'empty';
    } else if (flags.has('skip')) w.skipReason = 'annotation';
    else if (matchesAny(rules.SkipStyles, ev.style) || rule?.skip) w.skipReason = 'skipStyle';
    else if (rules.ReadStyles && !matchesAny(rules.ReadStyles, ev.style)) w.skipReason = 'notInReadStyles';
    else if (rules.SkipIfEffect && ev.effect.trim() !== '') w.skipReason = 'effect';
    else if (rules.SkipIfNoActor && ev.name.trim() === '') w.skipReason = 'noActor';
    else if (skipRe && skipRe.test(w.display)) w.skipReason = 'match';
    else if (empty) {
      w.skipReason = 'empty';
      ld.push(diag('KK201', { targetId: ev.id }));
    }
    w.read = w.skipReason === undefined;

    // §4.2 krok 8 + leksykon
    const units: Unit[] = [];
    for (const p of spokenParts) {
      if (p.t === 'pause') units.push({ t: 'pause', s: '', ms: p.ms });
      else if (p.t === 'range') units.push(p.kind === 'ipa' ? { t: 'ipa', s: p.value, protected: true } : { t: 'text', s: p.value, protected: true });
      else {
        // Potok normalizacji (§2.10): etapy w kolejności `order`, potem leksykon.
        let s = p.s;
        for (const stage of pipeline) {
          if (!('normalize' in stage)) {
            const ex = expandNumbers(s);
            s = ex.text;
            if (w.read)
              for (const e of ex.expansions)
                ld.push(diag(e.code, { targetId: ev.id, params: e.code === 'KK202' ? { text: e.original } : { from: e.original, to: e.replacement } }));
            continue;
          }
          try {
            const r = stage.normalize(s, { language: DOCUMENT_LANGUAGE, settings: settings as unknown as RuleSettings, lineId: ev.id });
            if (typeof r?.text !== 'string') throw new TypeError('normalize() nie zwrócił { text }');
            for (const x of r.replacements ?? []) w.replacements.push({ normalizer: stage.id, from: x.from, to: x.to, index: x.index });
            if (w.read) for (const d of r.diagnostics ?? []) ld.push(extensionDiag(d, ev.id, input.messages));
            s = r.text;
          } catch (e) {
            ld.push(diag('KF010', { targetId: ev.id, params: { normalizer: stage.id, plugin: stage.owner, message: String(e) } }));
          }
        }
        if (!numbersAuto && w.read && /\p{Nd}/u.test(s) && !ld.some((d) => d.code === 'KK202')) {
          ld.push(diag('KK202', { targetId: ev.id }));
        }
        units.push(...applyLexicon(s, patterns));
      }
    }
    w.units = units;
    w.spoken = segmentsText(canonicalSegments(units));
    if (w.read) checkNames(units, rules.IgnoreNames, ev.id, ld);
    works.push(w);
  }

  // §4.4 łączenie — linie czytane w kolejności Start, potem w kolejności pliku.
  const readLines = works.filter((w) => w.read).sort((a, b) => a.ev.start - b.ev.start || a.ev.index - b.ev.index);
  const groups: LineWork[][] = [];
  let cur: LineWork[] | null = null;
  for (let i = 0; i < readLines.length; i++) {
    const w = readLines[i]!;
    if (!cur) {
      cur = [w];
      groups.push(cur);
    } else cur.push(w);
    const next = readLines[i + 1];
    let join = false;
    if (next && !w.kk.flags.has('nojoin')) {
      if (w.kk.flags.has('join')) join = true;
      else if (rules.Join === 'auto') {
        const sameActor = w.ev.name === next.ev.name && w.ev.style === next.ev.style;
        const gap = next.ev.start - w.ev.end;
        const endsSentence = /[.!?…]["'”»)]*$/u.test(w.spoken.trim());
        join = sameActor && gap <= rules.JoinMaxGap && !endsSentence;
      }
    }
    if (!join) cur = null;
  }

  const lines = new Map<string, LineAnalysis>();
  const utterances: UtteranceData[] = [];
  for (const g of groups) {
    const first = g[0]!;
    const lineSegments = g.map((w) => canonicalSegments(w.units));
    const allUnits: Unit[] = [];
    g.forEach((w, i) => {
      if (i > 0) allUnits.push({ t: 'text', s: ' ' });
      allUnits.push(...w.units);
    });
    const segments = canonicalSegments(allUnits);
    if (g.length > 1) {
      for (const w of g.slice(1)) {
        const a = first.params;
        const b = w.params;
        if (round4(a.speed) !== round4(b.speed) || a.gain !== b.gain || a.offset !== b.offset || a.maxSpeed !== b.maxSpeed) {
          w.diags.push(diag('KK301', { targetId: w.ev.id, params: { group: first.ev.id } }));
        }
      }
    }
    const u: UtteranceData = {
      id: first.ev.id,
      lineIds: g.map((w) => w.ev.id),
      start: first.ev.start,
      end: g[g.length - 1]!.ev.end,
      params: { ...first.params, speed: round4(first.params.speed), maxSpeed: first.params.maxSpeed },
      segments,
      lineSegments,
      text: segmentsText(segments),
    };
    utterances.push(u);
    for (const w of g) {
      lines.set(w.ev.id, Object.freeze({ read: true, spokenText: w.spoken, displayText: w.display, utteranceId: u.id, ...replOf(w), diagnostics: Object.freeze(w.diags) }));
    }
  }
  for (const w of works) {
    if (lines.has(w.ev.id)) continue;
    const la: LineAnalysis = { read: false, spokenText: w.spoken, displayText: w.display, ...replOf(w), diagnostics: Object.freeze(w.diags) };
    if (w.skipReason) (la as { skipReason?: SkipReason }).skipReason = w.skipReason;
    lines.set(w.ev.id, Object.freeze(la));
  }
  for (const w of works) diagnostics.push(...(lines.get(w.ev.id)?.diagnostics ?? []));
  return { settings, lines, utterances, lexicon, diagnostics };
}

function replOf(w: LineWork): { replacements?: readonly LineReplacement[] } {
  return w.replacements.length ? { replacements: Object.freeze(w.replacements.map((r) => Object.freeze(r))) } : {};
}

export { NUMBERS_RULES_VERSION };
export type { Unit };
