/**
 * `KokoAss` — dokument Koko-ASS v1 (specyfikacja API §4).
 */
import { pluginFailure, resolveConfig, type CallConfig } from '../core/config-store.ts';
import { diag, type Diagnostic } from '../core/diagnostics.ts';
import { Derived, DocCore, markRaw, newId, type ChangeListener, type Observable } from '../core/doc-core.ts';
import { KokoErrors } from '../core/errors.ts';
import { ItemCollection, type Collection } from '../core/collections.ts';
import type { AssRule, Atom, CanonicalSegment, FormatCodec, FormatInfo, OperationOptions, ResolvedLexicon, RuleLineView, RuleReport, RuleSettings } from '../core/plugin-types.ts';
import { foldCase, nfc } from '../core/text.ts';
import { KokoLexicon, flattenLines } from '../lexicon/lexicon.ts';
import { formatInlineTable, parseInlineTable, validateEntryTable } from '../lexicon/entry.ts';
import {
  analyze,
  extensionDiag,
  segmentsText,
  utteranceKey,
  type AnalysisInput,
  type AnalysisResult,
  type EffectiveSettings,
  type LineAnalysis,
  type SynthesisIdentity,
  type UtteranceData,
  type UtteranceParams,
} from './analysis.ts';
import {
  AssEvent,
  AssStyle,
  EpisodeLexicon,
  EpisodeLexiconItem,
  KokoStyleRule,
  KokoStyleRules,
  STYLE_DEFAULTS,
  STYLE_FORMAT,
  ScriptInfo,
  Settings,
  SourceEntry,
  Sources,
  StyleCollection,
  SOURCE_FIELDS,
  validateSource,
  type AssEventData,
  type AssOwner,
  type KokoSections,
  type RawSection,
} from './model.ts';
import { LEKTOR_KEYS, RULES_KEYS, canonicalKeyName, type LektorKeys, type RulesKeys } from './settings.ts';
import { formatAssTime, parseAssTime } from './time.ts';
import { formatKkValue } from './kk.ts';

/** Obsługiwana wersja Koko-ASS (`KokoAnime Version`). */
export const KOKO_ASS_VERSION = 1;
/** Limit tokenów fonemów jednej części wypowiedzi (kontekst Kokoro-82M, Koko-ASS §4.4). */
export const TOKEN_LIMIT = 510;

const EVENT_FORMAT = ['Layer', 'Start', 'End', 'Style', 'Name', 'MarginL', 'MarginR', 'MarginV', 'Effect', 'Text'] as const;

/** Opcje `KokoAss.parse`. */
export interface AssParseOptions {
  /** Ścieżka pliku — do komunikatów i rozwiązywania `SeriesLexicon` w `load()`. */
  path?: string;
  /** Dołączony leksykon serii (bez pluginu fs). */
  seriesLexicon?: KokoLexicon | null;
  /** Nadpisanie konfiguracji dla tego wywołania. */
  config?: CallConfig;
}

/** Opcje `KokoAss.load`. */
export interface AssLoadOptions {
  /** Nadpisanie konfiguracji dla tego wywołania. */
  config?: CallConfig;
}

/** Opcje operacji wymagających pluginu `g2p`. */
export interface CheckOptions {
  /** Nadpisanie konfiguracji dla tego wywołania. */
  config?: CallConfig;
  /** Przerwanie operacji (KF005). */
  signal?: AbortSignal;
}

/**
 * Wypowiedź: jedna linia albo grupa `join`, syntezowana jako jeden klip (specyfikacja API §4.4).
 */
export class Utterance {
  /** ID — równe ID pierwszej linii grupy. */
  readonly id: string;
  /** ID linii tworzących wypowiedź (więcej niż jedna przy łączeniu). */
  readonly lineIds: readonly string[];
  /** Start pierwszej linii w ms (przed `offset`). */
  readonly start: number;
  /** Koniec ostatniej linii w ms (koniec slotu bez pożyczania ciszy). */
  readonly end: number;
  /** Parametry syntezy. */
  readonly params: Readonly<UtteranceParams>;
  /** Segmenty kanoniczne (Koko-Pack §6.2). */
  readonly segments: readonly CanonicalSegment[];
  /** Czytelny tekst mówiony (IPA w `/…/`, pauzy jako `[Nms]`). */
  readonly text: string;
  /** Liczba części po podziale > 510 tokenów (KK303); 1 bez podziału lub przed `resolveUtterances`. */
  readonly parts: number;
  /** @internal */ readonly numbersAuto: boolean;

  /** @internal */
  constructor(d: UtteranceData, numbersAuto: boolean, parts = 1) {
    this.id = d.id;
    this.lineIds = Object.freeze([...d.lineIds]);
    this.start = d.start;
    this.end = d.end;
    this.params = Object.freeze({ ...d.params });
    this.segments = Object.freeze(d.segments.map((s) => Object.freeze({ ...s })));
    this.text = d.text;
    this.numbersAuto = numbersAuto;
    this.parts = parts;
    Object.freeze(this);
  }

  /** Klucz wypowiedzi `sha256:…` (Koko-Pack §6.2), synchronicznie. */
  key(synthesis: SynthesisIdentity): string {
    return utteranceKey(this, synthesis, this.numbersAuto);
  }
}

type ParsedSection = { name: string; header: string; lines: { text: string; line: number }[] };

function splitSections(lines: string[]): { preamble: string[]; sections: ParsedSection[] } {
  const preamble: string[] = [];
  const sections: ParsedSection[] = [];
  let cur: ParsedSection | null = null;
  lines.forEach((text, i) => {
    const m = /^\s*\[(.+)\]\s*$/.exec(text);
    if (m) {
      cur = { name: m[1]!.trim(), header: text.trim(), lines: [] };
      sections.push(cur);
    } else if (cur) (cur as ParsedSection).lines.push({ text, line: i + 1 });
    else if (text.trim()) preamble.push(text);
  });
  return { preamble, sections };
}

function splitFields(rest: string, count: number): string[] {
  const out: string[] = [];
  let s = rest;
  for (let i = 0; i < count - 1; i++) {
    const c = s.indexOf(',');
    if (c < 0) {
      out.push(s);
      s = '';
      continue;
    }
    out.push(s.slice(0, c));
    s = s.slice(c + 1);
  }
  out.push(s);
  return out;
}

function parsePairs(value: string): Map<string, string> | null {
  const m = new Map<string, string>();
  const re = /\s*([\p{L}][\p{L}\p{N}_]*)=("([^"{}]*)"|([^\s"{}]+))\s*/uy;
  let i = 0;
  while (i < value.length) {
    re.lastIndex = i;
    const r = re.exec(value);
    if (!r) return value.slice(i).trim() === '' ? m : null;
    m.set(foldCase(r[1]!), r[3] ?? r[4] ?? '');
    i = re.lastIndex;
  }
  return m;
}

/**
 * Dokument Koko-ASS v1 — pełny, edytowalny model ASS z warstwą Koko (specyfikacja API §4).
 *
 * Mutowalny: każda zmiana emituje `onChange` i unieważnia analizę, liczoną leniwie przy odczycie.
 * Zapis (`toString`) jest zawsze kanoniczny.
 */
export class KokoAss implements Observable, AssOwner {
  /** @internal */ readonly _core: DocCore;
  /** `[Script Info]`. */
  readonly scriptInfo: ScriptInfo;
  /** `[V4+ Styles]`. */
  readonly styles: StyleCollection;
  /** `[Events]`. */
  readonly events: EventList;
  /** Sekcje `[Koko …]`. */
  readonly koko: KokoSections;
  /** Nieznane sekcje (zachowywane przy zapisie). */
  readonly extraSections: Collection<RawSection>;
  /** @internal */ _extra: ItemCollection<RawSection>;
  /** @internal */ _preamble: string[] = [];
  /** @internal */ _styleExtraColumns: string[] = [];
  #series: KokoLexicon | null = null;
  #seriesAtom: Atom;
  #seriesUnsub: (() => void) | null = null;
  #parseDiags: Diagnostic[] = [];
  #path: string | undefined;
  #analysis: Derived<AnalysisResult>;
  #diagnostics: Derived<readonly Diagnostic[]>;
  #utterances: Derived<readonly Utterance[]>;
  #rules: Derived<RuleResults>;
  #ruleMemo = new Map<string, { sig: string; diags: Diagnostic[] }>();
  #mergedLines = new WeakMap<LineAnalysis, LineAnalysis>();

  private constructor(call?: CallConfig) {
    this._core = new DocCore(this, call);
    this.scriptInfo = new ScriptInfo(this);
    this.styles = new StyleCollection(this);
    this.events = new EventList(this);
    this.koko = Object.freeze({
      lektor: new Settings<LektorKeys>(this, 'lektor', LEKTOR_KEYS),
      rules: new Settings<RulesKeys>(this, 'rules', RULES_KEYS),
      styles: new KokoStyleRules(this),
      lexicon: new EpisodeLexicon(this),
      sources: new Sources(this),
    });
    this._extra = new ItemCollection<RawSection>(this._core, 'extraSections');
    this.extraSections = this._extra;
    this.#seriesAtom = this._core.atom('series');
    this.#analysis = new Derived(this._core, () => analyze(this.#snapshot()), 'analysis', true);
    this.#diagnostics = new Derived(this._core, () => Object.freeze(this.#computeDiagnostics()), 'diagnostics', true);
    this.#rules = new Derived(this._core, () => this.#computeRules(), 'rules', true);
    this.#utterances = new Derived(
      this._core,
      () => {
        const a = this.#analysis.get();
        const auto = a.settings.rules.Numbers === 'auto';
        return Object.freeze(a.utterances.map((u) => new Utterance(u, auto)));
      },
      'utterances',
      true,
    );
    markRaw(this);
  }

  // ------------------------------------------------------------ AssOwner

  /** @internal */
  _atom(name: string): Atom {
    return this._core.atom(name);
  }

  /** @internal */
  _lineChanged(ev: AssEvent, atoms: Atom[], path: string[], kind: 'update' | 'replace' = 'update'): void {
    const list = this.events.items;
    const i = list.indexOf(ev);
    const affected = new Set<AssEvent>([ev]);
    if (i > 0) affected.add(list[i - 1]!);
    if (i >= 0 && i + 1 < list.length) affected.add(list[i + 1]!);
    const prev = this.#analysis.peek();
    if (prev) {
      const u = prev.lines.get(ev.id)?.utteranceId;
      if (u) for (const utt of prev.utterances) if (utt.id === u) for (const id of utt.lineIds) {
        const e = list.find((x) => x.id === id);
        if (e) affected.add(e);
      }
    }
    // Zmiana czasu może zmienić kolejność i łączenie — wtedy odśwież wszystkie linie.
    const timing = path.includes('start') || path.includes('end') || path.includes('style') || path.includes('name') || path.includes('type');
    const lineAtoms = timing ? list.map((e) => e.analysisAtom) : [...affected].map((e) => e.analysisAtom);
    this._core.change([...atoms, ...lineAtoms], { targetId: ev.id, kind, path });
  }

  /** @internal */
  _globalChanged(atoms: Atom[], targetId: string | null, path: string[], kind: 'insert' | 'remove' | 'update' | 'move' | 'replace'): void {
    this._core.change([...atoms, ...this.events.items.map((e) => e.analysisAtom)], { targetId, kind, path });
  }

  /** @internal */
  _lineAnalysis(id: string): LineAnalysis {
    return this._core.untrack(() => {
      const base = this.#analysis.get().lines.get(id);
      if (!base) return EMPTY_ANALYSIS;
      const extra = this.#rules.get().byLine.get(id);
      if (!extra?.length) return base;
      let merged = this.#mergedLines.get(base);
      if (!merged || merged.diagnostics.length !== base.diagnostics.length + extra.length) {
        merged = Object.freeze({ ...base, diagnostics: Object.freeze([...base.diagnostics, ...extra]) });
        this.#mergedLines.set(base, merged);
      }
      return merged;
    });
  }

  // ------------------------------------------------------------ reguły pluginów (§2.9)

  #computeRules(): RuleResults {
    const cfg = resolveConfig(this._core.call);
    const active = cfg.list('rules').filter(({ item }) => {
      const s = cfg.rules[item.code];
      return s === undefined ? item.enabled !== false : s !== 'off';
    });
    const byLine = new Map<string, Diagnostic[]>();
    const all: Diagnostic[] = [];
    if (!active.length) {
      this.#ruleMemo.clear();
      return { byLine, all };
    }
    const a = this.#analysis.get();
    const utterances = this.#utterances.get();
    const uttById = new Map(utterances.map((u) => [u.id, u]));
    const settings = a.settings as unknown as RuleSettings;
    const settingsSig = JSON.stringify(a.settings);
    const lines: RuleLineView[] = [];
    for (const e of this.events.items) {
      if (e._type !== 'Dialogue' && e._type !== 'Comment') continue;
      const la = a.lines.get(e.id);
      const utt = la?.utteranceId ? uttById.get(la.utteranceId) : undefined;
      lines.push(Object.freeze({
        id: e.id, text: e._text, style: e._style, actor: e._name, start: e._start, end: e._end,
        comment: e._type === 'Comment', spokenText: la?.spokenText ?? '', ...(utt ? { utterance: utt } : {}),
      }));
    }
    const make = (rule: AssRule, r: RuleReport): Diagnostic => {
      const s = cfg.rules[rule.code];
      const level = s === 'error' || s === 'warning' || s === 'info' ? s : (r.level ?? rule.level);
      return extensionDiag({ code: rule.code, level, title: rule.title, ...(rule.hint !== undefined ? { hint: rule.hint } : {}), ...(r.params ? { params: r.params } : {}) }, r.targetId, cfg.messages);
    };
    const failed = (rule: AssRule, owner: string, e: unknown, targetId?: string) =>
      diag('KF009', { ...(targetId ? { targetId } : {}), params: { rule: rule.code, plugin: owner, message: String(e) } });
    const push = (d: Diagnostic) => {
      all.push(d);
      if (d.targetId) {
        const l = byLine.get(d.targetId) ?? [];
        l.push(d);
        byLine.set(d.targetId, l);
      }
    };
    const memo = new Map<string, { sig: string; diags: Diagnostic[] }>();
    for (const { owner, item: rule } of active) {
      if (rule.scope === 'line') {
        for (const line of lines) {
          const k = `${rule.code}\u0000${line.id}`;
          const u = line.utterance;
          const sig = JSON.stringify([line.text, line.style, line.actor, line.start, line.end, line.comment, line.spokenText, u?.id, u?.text, u?.lineIds, settingsSig, cfg.rules[rule.code]]);
          let hit = this.#ruleMemo.get(k);
          if (!hit || hit.sig !== sig) {
            let diags: Diagnostic[];
            try {
              diags = (rule.check(line, settings) ?? []).map((r) => make(rule, r));
            } catch (e) {
              diags = [failed(rule, owner, e, line.id)];
            }
            hit = { sig, diags };
          }
          memo.set(k, hit);
          hit.diags.forEach(push);
        }
      } else {
        try {
          for (const r of rule.check({ lines, utterances }, settings) ?? []) push(make(rule, r));
        } catch (e) {
          push(failed(rule, owner, e));
        }
      }
    }
    this.#ruleMemo = memo;
    return { byLine, all };
  }

  // ------------------------------------------------------------ tworzenie

  /** Pusty dokument Koko-ASS (`ScriptType: v4.00+`, `KokoAnime Version: 1`, styl Default). */
  static create(opts: { kokoVersion?: 1 | null; config?: CallConfig } = {}): KokoAss {
    const doc = new KokoAss(opts.config);
    doc.scriptInfo.items.push({ id: newId('si'), kind: 'pair', key: 'ScriptType', value: 'v4.00+' });
    if (opts.kokoVersion !== null) doc.scriptInfo.items.push({ id: newId('si'), kind: 'pair', key: 'KokoAnime Version', value: String(opts.kokoVersion ?? 1) });
    const map = new Map<string, string>();
    for (const f of STYLE_FORMAT) map.set(f, STYLE_DEFAULTS[f]!);
    doc.styles.items.push(new AssStyle(doc, map));
    return doc;
  }

  /** Parsuje tekst pliku. Nieobsługiwana wersja (KK002) → `KokoErrors`. Synchroniczne. */
  static parse(text: string, opts: AssParseOptions = {}): KokoAss | KokoErrors {
    const doc = new KokoAss(opts.config);
    doc.#path = opts.path;
    const diags: Diagnostic[] = [];
    if (doc._core.reactive === false && resolveConfig(opts.config).cap('reactivity')) diags.push(diag('KF006'));
    let src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
    const normalized = nfc(src);
    if (normalized !== src) diags.push(diag('KF001'));
    src = normalized;
    const { preamble, sections } = splitSections(src.split(/\r\n|\n|\r/));
    doc._preamble = preamble;
    const pos = (line: number) => ({ line, column: 1 });

    for (const sec of sections) {
      const name = foldCase(sec.name);
      if (name === 'script info') {
        for (const { text: l, line } of sec.lines) {
          if (!l.trim()) continue;
          if (l.trimStart().startsWith(';')) {
            doc.scriptInfo.items.push({ id: newId('si'), kind: 'comment', key: '', value: l.trimStart().slice(1).trimStart(), sourceLine: line });
            continue;
          }
          const c = l.indexOf(':');
          if (c < 0) {
            doc.scriptInfo.items.push({ id: newId('si'), kind: 'comment', key: '', value: l.trim(), sourceLine: line });
            continue;
          }
          doc.scriptInfo.items.push({ id: newId('si'), kind: 'pair', key: l.slice(0, c).trim(), value: l.slice(c + 1).trim(), sourceLine: line });
        }
      } else if (name === 'v4+ styles') {
        let format: string[] = [...STYLE_FORMAT];
        for (const { text: l, line } of sec.lines) {
          if (!l.trim() || l.trimStart().startsWith(';')) continue;
          const c = l.indexOf(':');
          if (c < 0) continue;
          const kind = l.slice(0, c).trim();
          const rest = l.slice(c + 1);
          if (foldCase(kind) === 'format') {
            format = rest.split(',').map((x) => x.trim());
            doc._styleExtraColumns = format.filter((f) => !STYLE_FORMAT.some((s) => foldCase(s) === foldCase(f)));
          } else if (foldCase(kind) === 'style') {
            const vals = splitFields(rest, format.length).map((x) => x.trim());
            const map = new Map<string, string>();
            format.forEach((f, i) => {
              const canon = STYLE_FORMAT.find((s) => foldCase(s) === foldCase(f)) ?? f;
              map.set(canon, vals[i] ?? '');
            });
            const st = new AssStyle(doc, map);
            st.sourceLine = line;
            doc.styles.items.push(st);
          }
        }
      } else if (name === 'events') {
        let format: string[] = [...EVENT_FORMAT];
        for (const { text: l, line } of sec.lines) {
          if (!l.trim() || l.trimStart().startsWith(';')) continue;
          const c = l.indexOf(':');
          if (c < 0) continue;
          const kind = l.slice(0, c).trim();
          const rest = l.slice(c + 1);
          if (foldCase(kind) === 'format') {
            format = rest.split(',').map((x) => x.trim());
            continue;
          }
          const vals = splitFields(rest.replace(/^ /, ''), format.length);
          const get = (field: string) => {
            const i = format.findIndex((f) => foldCase(f) === foldCase(field) || (field === 'Name' && foldCase(f) === 'actor'));
            return i < 0 ? undefined : vals[i];
          };
          const d: AssEventData = { type: kind === 'Dialogue' || kind === 'Comment' ? kind : kind };
          const num = (v: string | undefined) => (v === undefined ? 0 : Number.parseInt(v.trim(), 10) || 0);
          d.layer = num(get('Layer'));
          const s = parseAssTime(get('Start') ?? '');
          const e = parseAssTime(get('End') ?? '');
          if (s === undefined || e === undefined) diags.push(diag('KK006', { position: pos(line), params: { field: s === undefined ? 'Start' : 'End' } }));
          d.start = s ?? 0;
          d.end = e ?? d.start;
          d.style = (get('Style') ?? 'Default').trim();
          d.name = (get('Name') ?? '').trim();
          d.marginL = num(get('MarginL'));
          d.marginR = num(get('MarginR'));
          d.marginV = num(get('MarginV'));
          d.effect = (get('Effect') ?? '').trim();
          d.text = get('Text') ?? '';
          const ev = new AssEvent(doc, d);
          ev.sourceLine = line;
          doc.events.items.push(ev);
        }
      } else if (name === 'koko lektor' || name === 'koko rules') {
        const target = name === 'koko lektor' ? doc.koko.lektor : doc.koko.rules;
        const table = name === 'koko lektor' ? LEKTOR_KEYS : RULES_KEYS;
        for (const { text: l, line } of sec.lines) {
          if (!l.trim()) continue;
          if (l.trimStart().startsWith(';')) {
            target.items.push({ id: newId('kv'), kind: 'comment', key: '', raw: l.trimStart().slice(1).trimStart(), sourceLine: line });
            continue;
          }
          const eq = l.indexOf('=');
          if (eq < 0) {
            diags.push(diag('KK006', { position: pos(line), params: { line: l.trim() } }));
            continue;
          }
          const keyRaw = l.slice(0, eq).trim();
          const raw = l.slice(eq + 1).trim();
          const canon = canonicalKeyName(table as never, keyRaw) as string | undefined;
          const key = canon ?? keyRaw;
          // Powtórzony klucz → wygrywa ostatni.
          target.items = target.items.filter((it) => !(it.kind === 'pair' && foldCase(it.key) === foldCase(key)));
          target.items.push({ id: newId('kv'), kind: 'pair', key, raw, sourceLine: line });
        }
      } else if (name === 'koko styles') {
        for (const { text: l, line } of sec.lines) {
          if (!l.trim() || l.trimStart().startsWith(';')) continue;
          const eq = l.indexOf('=');
          if (eq < 0) {
            diags.push(diag('KK006', { position: pos(line), params: { line: l.trim() } }));
            continue;
          }
          const pattern = l.slice(0, eq).trim();
          const val = l.slice(eq + 1).trim();
          const params: { key: string; value: string }[] = [];
          let skip = false;
          if (foldCase(val) === 'skip') skip = true;
          else {
            for (const part of val.split(/\s+/u).filter(Boolean)) {
              const e = part.indexOf('=');
              if (e <= 0) {
                if (foldCase(part) === 'skip') skip = true;
                else diags.push(diag('KK006', { position: pos(line), params: { value: part } }));
                continue;
              }
              params.push({ key: foldCase(part.slice(0, e)), value: part.slice(e + 1) });
            }
          }
          const rule = new KokoStyleRule(doc, pattern, skip, params);
          rule.sourceLine = line;
          doc.koko.styles.items.push(rule);
        }
      } else if (name === 'koko lexicon') {
        for (const { text: l, line } of sec.lines) {
          const it = parseLexiconLine(doc, l, line, diags);
          if (it) doc.koko.lexicon.items.push(it);
        }
        markFlattened(doc.koko.lexicon.items);
      } else if (name === 'koko sources') {
        for (const { text: l, line } of sec.lines) {
          if (!l.trim() || l.trimStart().startsWith(';')) continue;
          const eq = l.indexOf('=');
          const label = eq < 0 ? '' : l.slice(0, eq).trim();
          const pairs = eq < 0 ? null : parsePairs(l.slice(eq + 1).trim());
          if (!label || !pairs) {
            diags.push(diag('KK007', { position: pos(line), params: { line: l.trim() } }));
            continue;
          }
          const src = new SourceEntry(doc, label, pairs);
          src.sourceLine = line;
          doc.koko.sources.items.push(src);
        }
      } else {
        const lines = sec.lines.map((x) => x.text);
        while (lines.length && !lines[lines.length - 1]!.trim()) lines.pop();
        doc._extra.items.push({ id: newId('sec'), name: sec.name, lines });
      }
    }

    // Wersja formatu.
    const verItem = [...doc.scriptInfo.items].reverse().find((i) => i.kind === 'pair' && foldCase(i.key) === 'kokoanime version');
    if (verItem) {
      const v = verItem.value.trim();
      if (/^\d+$/.test(v) && Number(v) > KOKO_ASS_VERSION) {
        const d = diag('KK002', { params: { version: v }, position: pos(verItem.sourceLine ?? 1) });
        return new KokoErrors([d], [...diags, d]);
      }
    }
    doc.#parseDiags = diags;
    if (opts.seriesLexicon) doc.seriesLexicon = opts.seriesLexicon;
    return doc;
  }

  /**
   * Wczytuje plik przez plugin `fs` razem z leksykonem serii (`SeriesLexicon`, KK009).
   */
  static async load(path: string, opts: AssLoadOptions = {}): Promise<KokoAss | KokoErrors> {
    const cfg = resolveConfig(opts.config);
    const fs = cfg.cap('fs');
    if (!fs) return new KokoErrors([diag('KF002', { level: 'error', params: { capability: 'fs' } })]);
    let text: string;
    try {
      text = await fs.readText(path);
    } catch (e) {
      return new KokoErrors([pluginFailure(e, cfg.capOwner('fs'))]);
    }
    const doc = KokoAss.parse(text, { path, ...(opts.config ? { config: opts.config } : {}) });
    if (doc instanceof KokoErrors) return doc;
    const rules = doc.koko.rules;
    const sl = rules.get('SeriesLexicon');
    if (foldCase(sl) === 'none') return doc;
    const explicit = rules.isSet('SeriesLexicon');
    const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '.';
    const lexPath = fs.resolve(dir, sl);
    try {
      if (!(await fs.exists(lexPath))) {
        if (explicit) doc.#parseDiags.push(diag('KK009', { params: { path: lexPath } }));
        return doc;
      }
      const lx = KokoLexicon.parse(await fs.readText(lexPath), opts.config ? { config: opts.config } : {});
      if (lx instanceof KokoErrors) doc.#parseDiags.push(...lx.all);
      else {
        doc.#parseDiags.push(...lx.diagnostics.filter((d) => d.level !== 'info'));
        doc.#series = lx;
        doc.#bindSeries(lx);
      }
    } catch (e) {
      doc.#parseDiags.push(pluginFailure(e, cfg.capOwner('fs')));
    }
    return doc;
  }

  // ------------------------------------------------------------ leksykon serii

  /** Ścieżka pliku podana w `parse`/`load`. */
  get path(): string | undefined {
    return this.#path;
  }

  /** Dołączony leksykon serii (używany, gdy `SeriesLexicon` ≠ `none`). */
  get seriesLexicon(): KokoLexicon | null {
    this.#seriesAtom.track();
    return this.#series;
  }
  set seriesLexicon(lx: KokoLexicon | null) {
    this.#series = lx;
    this.#bindSeries(lx);
    this._globalChanged([this.#seriesAtom], null, ['seriesLexicon'], 'replace');
  }

  #bindSeries(lx: KokoLexicon | null): void {
    this.#seriesUnsub?.();
    this.#seriesUnsub = lx ? lx.onChange(() => this._globalChanged([this.#seriesAtom], null, ['seriesLexicon'], 'update')) : null;
  }

  /** Spłaszcza leksykon serii do `[Koko Lexicon]` (Koko-Lexicon §3) i ustawia `SeriesLexicon = none`. */
  flattenSeriesLexicon(): boolean {
    const lx = this.#series;
    if (!lx) return false;
    this._core.batch('flattenSeriesLexicon', () => {
      const items = this.koko.lexicon.items.filter((i) => !i._flattened);
      const episodeWords = items.filter((i) => i.kind === 'entry').flatMap(entryWords);
      const lines = flattenLines(lx.effectiveEntries(), episodeWords);
      const flat: EpisodeLexiconItem[] = [];
      for (const l of lines) {
        const it = parseLexiconLine(this, l, 0, []);
        if (it) flat.push(it);
      }
      for (const f of flat) f._flattened = true;
      this.koko.lexicon.items = [...items, ...flat];
      this.koko.rules.set('SeriesLexicon', 'none');
      this.#series = null;
      this.#bindSeries(null);
      this._globalChanged([this.koko.lexicon.atom, this.#seriesAtom], null, ['koko', 'lexicon'], 'replace');
    });
    return true;
  }

  /**
   * Odtwarza leksykon serii z bloku spłaszczonego (Koko-Lexicon §3.1) — bez `title`, które przepada.
   * `null`, gdy bloku nie ma (albo jest niezamknięty lub powtórzony).
   */
  extractSeriesLexicon(): KokoLexicon | null {
    const flat = this.koko.lexicon.items.filter((i) => i._flattened && i.kind === 'entry');
    if (!this.koko.lexicon.items.some((i) => i._flattened)) return null;
    const lx = KokoLexicon.create(this._core.call ? { config: this._core.call } : {});
    for (const it of flat) lx.entries.add(it._key, it.toEntry());
    return lx;
  }

  /** Cofa spłaszczenie (Koko-Lexicon §3.1). false, gdy blok niezamknięty, powtórzony albo go brak. */
  unflattenSeriesLexicon(lexicon?: KokoLexicon): boolean {
    const items = this.koko.lexicon.items;
    if (!items.some((i) => i._flattened)) return false;
    this._core.batch('unflattenSeriesLexicon', () => {
      this.koko.lexicon.items = items.filter((i) => !i._flattened);
      this.koko.rules.set('SeriesLexicon', undefined);
      if (lexicon) {
        this.#series = lexicon;
        this.#bindSeries(lexicon);
      }
      this._globalChanged([this.koko.lexicon.atom, this.#seriesAtom], null, ['koko', 'lexicon'], 'replace');
    });
    return true;
  }

  // ------------------------------------------------------------ analiza

  #snapshot(): AnalysisInput {
    return {
      events: this.events.items.map((e, index) => ({
        id: e.id, index, type: e._type, start: e._start, end: e._end, style: e._style, name: e._name, effect: e._effect, text: e._text,
      })),
      lektor: this.koko.lektor.items.filter((i) => i.kind === 'pair').map((i) => ({ id: i.id, key: i.key, raw: i.raw })),
      rules: this.koko.rules.items.filter((i) => i.kind === 'pair').map((i) => ({ id: i.id, key: i.key, raw: i.raw })),
      styles: this.koko.styles.items.map((r) => ({ id: r.id, pattern: r._pattern, skip: r._skip, params: r.params.map((p) => ({ ...p })) })),
      lexicon: this.koko.lexicon.items.filter((i) => i.kind === 'entry').map((i) => ({ id: i.id, key: i._key, stem: i._stem, value: i._value, aliases: [...i._aliases], forms: i._forms.map(([k, v]) => [k, v] as [string, string]) })),
      series: this.#series ? this.#series._effectiveRaw() : null,
      ...this.#pluginInputs(),
    };
  }

  #pluginInputs(): Pick<AnalysisInput, 'defaultVoice' | 'normalizers' | 'messages'> {
    const cfg = resolveConfig(this._core.call);
    const normalizers = cfg
      .list('normalizers')
      .filter(({ item }) => {
        if (item.id.startsWith('koko/')) return false; // zarezerwowane dla etapów wbudowanych
        if (item.languages && !item.languages.includes('pl')) return false;
        const s = cfg.normalizers[item.id];
        return item.activation === 'always' ? s !== 'off' : s === 'on';
      })
      .map(({ owner, item }) => ({ id: item.id, order: item.order, owner, normalize: item.normalize.bind(item) }));
    return { defaultVoice: cfg.defaults.voice, normalizers, messages: cfg.messages };
  }

  // ------------------------------------------------------------ import i eksport (§2.11)

  /**
   * Import z formatu zarejestrowanego przez plugin (`formats`) albo wbudowanego `ass`.
   * Nieznany format → KF012; wyjątek kodera → KF004.
   */
  static async import(format: string, input: string | Blob, opts: FormatOptions & { language?: string } = {}): Promise<KokoAss | KokoErrors> {
    const cfg = resolveConfig(opts.config);
    const found = findCodec(cfg, format);
    if (!found?.codec.import) return new KokoErrors([diag('KF012', { params: { format, operation: 'import' } })]);
    try {
      const r: unknown = await found.codec.import(input, opOptions(opts, { ...(opts.language ? { language: opts.language } : {}), ...(opts.config ? { config: opts.config } : {}) }));
      if (r instanceof KokoAss || r instanceof KokoErrors) return r;
      return new KokoErrors([diag('KF004', { params: { plugin: found.owner, message: 'import() nie zwrócił KokoAss' } })]);
    } catch (e) {
      if (opts.signal?.aborted) return new KokoErrors([diag('KF005', { level: 'error' })]);
      return new KokoErrors([pluginFailure(e, found.owner)]);
    }
  }

  /** Eksport do formatu zarejestrowanego przez plugin albo wbudowanego `ass` (bez sekcji Koko). */
  async export(format: string, opts: FormatOptions & Record<string, unknown> = {}): Promise<string | Blob | KokoErrors> {
    const cfg = resolveConfig((opts.config as CallConfig | undefined) ?? this._core.call);
    const found = findCodec(cfg, format);
    if (!found?.codec.export) return new KokoErrors([diag('KF012', { params: { format, operation: 'export' } })]);
    try {
      const r: unknown = await found.codec.export(this, opOptions(opts, opts));
      if (typeof r === 'string' || r instanceof Blob || r instanceof KokoErrors) return r;
      return new KokoErrors([diag('KF004', { params: { plugin: found.owner, message: 'export() nie zwrócił string | Blob' } })]);
    } catch (e) {
      if (opts.signal?.aborted) return new KokoErrors([diag('KF005', { level: 'error' })]);
      return new KokoErrors([pluginFailure(e, found.owner)]);
    }
  }

  #computeDiagnostics(): Diagnostic[] {
    const out: Diagnostic[] = [...this.#parseDiags];
    const at = (line?: number) => (line ? { position: { line, column: 1 } } : {});
    // KokoAnime Version
    const ver = this.scriptInfo.items.filter((i) => i.kind === 'pair' && foldCase(i.key) === 'kokoanime version').pop();
    if (ver && !/^\d+$/.test(ver.value.trim())) out.push(diag('KK006', { targetId: ver.id, params: { key: 'KokoAnime Version', value: ver.value }, ...at(ver.sourceLine) }));
    // Nieznane klucze
    for (const [s, table] of [[this.koko.lektor, LEKTOR_KEYS], [this.koko.rules, RULES_KEYS]] as const) {
      for (const it of s.items) {
        if (it.kind === 'pair' && canonicalKeyName(table as never, it.key) === undefined)
          out.push(diag('KK001', { targetId: it.id, params: { key: it.key }, ...at(it.sourceLine) }));
      }
    }
    for (const sec of this._extra.items) {
      if (/^koko /i.test(sec.name)) out.push(diag('KK001', { targetId: sec.id, params: { section: sec.name } }));
    }
    // Duplikaty leksykonu (KK010)
    // Słowo (klucz, alias, forma) w kilku wpisach — obowiązuje ostatnie wystąpienie (Koko-ASS §2).
    const seen = new Map<string, EpisodeLexiconItem>();
    for (const it of this.koko.lexicon.items) {
      if (it.kind !== 'entry') continue;
      const dup = new Set<string>();
      for (const w of entryWords(it)) {
        const f = foldCase(w);
        const prev = seen.get(f);
        if (prev && prev !== it) dup.add(w);
        seen.set(f, it);
      }
      for (const w of dup) out.push(diag('KK010', { targetId: it.id, params: { key: it._key, word: w }, ...at(it.sourceLine) }));
    }
    // Źródła (KK007, KK010)
    const labels = new Set<string>();
    for (const s of this.koko.sources.items) {
      const why = validateSource(s.fields);
      if (why) out.push(diag('KK007', { targetId: s.id, params: { label: s._label, reason: why }, ...at(s.sourceLine) }));
      const f = foldCase(s._label);
      if (labels.has(f)) out.push(diag('KK010', { targetId: s.id, params: { label: s._label }, ...at(s.sourceLine) }));
      labels.add(f);
    }
    out.push(...this.#analysis.get().diagnostics);
    out.push(...this.#rules.get().all);
    return out;
  }

  /** Diagnostyki synchroniczne (bez KK101, KK302, KK303). */
  get diagnostics(): readonly Diagnostic[] {
    return this.#diagnostics.get();
  }

  /** Wypowiedzi po klasyfikacji i łączeniu (bez rozbicia grup > 510 tokenów). */
  get utterances(): readonly Utterance[] {
    return this.#utterances.get();
  }

  /** Efektywne ustawienia `[Koko Lektor]` i `[Koko Rules]`. */
  get settings(): EffectiveSettings {
    return this.#analysis.get().settings;
  }

  /** Leksykon po rozwiązaniu (odcinek + seria) — dla pluginu G2P. */
  get resolvedLexicon(): ResolvedLexicon {
    return { entries: this.#analysis.get().lexicon };
  }

  /** @internal */
  _analysisResult(): AnalysisResult {
    return this.#analysis.get();
  }

  /**
   * Diagnostyki wymagające pluginu `g2p` (KK101, KK302, KK303) — razem z synchronicznymi.
   */
  async check(opts: CheckOptions = {}): Promise<readonly Diagnostic[]> {
    const base = [...this.diagnostics];
    const cfg = resolveConfig(opts.config);
    const g2p = cfg.cap('g2p');
    if (!g2p) return [...base, diag('KF002', { params: { capability: 'g2p' } })];
    const extra: Diagnostic[] = [];
    try {
      const vocab = await g2p.ipaVocabulary();
      const bad = (ipa: string) => [...ipa].filter((c) => !/\s/u.test(c) && !vocab.has(c));
      for (const it of this.koko.lexicon.items) {
        if (it.kind === 'entry' && !it._value.startsWith('~')) {
          const b = [it._value, ...it._forms.map(([, v]) => v)].flatMap(bad);
          if (b.length) extra.push(diag('KK101', { targetId: it.id, params: { key: it._key, symbols: [...new Set(b)].join(' ') }, ...(it.sourceLine ? { position: { line: it.sourceLine, column: 1 } } : {}) }));
        }
      }
      for (const e of this.#series?._effectiveRaw() ?? []) {
        if (e.kind !== 'ipa') continue;
        const vals = [e.value, ...e.forms.map(([, v]) => v)];
        const b = vals.flatMap(bad);
        if (b.length) extra.push(diag('KK101', { params: { key: e.key, symbols: [...new Set(b)].join(' '), origin: 'series' } }));
      }
      for (const ev of this.events.items) {
        for (const r of ev.kk.ranges) {
          if (r.kind !== 'ipa') continue;
          const b = bad(r.value);
          if (b.length) extra.push(diag('KK101', { targetId: ev.id, params: { symbols: [...new Set(b)].join(' ') } }));
        }
      }
      const { diagnostics } = await this.#resolve(cfg, opts.signal);
      extra.push(...diagnostics);
    } catch (e) {
      extra.push(pluginFailure(e, cfg.capOwner('g2p')));
    }
    return [...base, ...extra];
  }

  /**
   * Wypowiedzi ostateczne: grupy `join` przekraczające 510 tokenów są rozbijane (KK302),
   * wypowiedzi > 510 tokenów oznaczane do podziału (KK303). Wymaga pluginu `g2p`.
   */
  async resolveUtterances(opts: CheckOptions = {}): Promise<readonly Utterance[] | KokoErrors> {
    const cfg = resolveConfig(opts.config);
    if (!cfg.cap('g2p')) return new KokoErrors([diag('KF002', { level: 'error', params: { capability: 'g2p' } })]);
    try {
      return (await this.#resolve(cfg, opts.signal)).utterances;
    } catch (e) {
      if (opts.signal?.aborted) return new KokoErrors([diag('KF005', { level: 'error' })]);
      return new KokoErrors([pluginFailure(e, cfg.capOwner('g2p'))]);
    }
  }

  async #resolve(cfg: ReturnType<typeof resolveConfig>, signal?: AbortSignal): Promise<{ utterances: Utterance[]; diagnostics: Diagnostic[] }> {
    const g2p = cfg.cap('g2p')!;
    const a = this.#analysis.get();
    const lex = { entries: a.lexicon };
    const auto = a.settings.rules.Numbers === 'auto';
    const out: Utterance[] = [];
    const diagnostics: Diagnostic[] = [];
    const tokens = async (segs: CanonicalSegment[]) => {
      if (signal?.aborted) throw new Error('aborted');
      const ipa = await g2p.toIpa(segs, lex);
      let n = 0;
      for (const p of ipa) n += await g2p.tokenCount(p);
      return n;
    };
    for (const u of a.utterances) {
      if (u.lineIds.length > 1 && (await tokens(u.segments)) > TOKEN_LIMIT) {
        diagnostics.push(diag('KK302', { targetId: u.id, params: { lines: u.lineIds.length } }));
        u.lineIds.forEach((lid, i) => {
          const ev = this.events.items.find((e) => e.id === lid)!;
          const lineSegs = u.lineSegments[i]!;
          const d: UtteranceData = { id: lid, lineIds: [lid], start: ev._start, end: ev._end, params: u.params, segments: lineSegs, lineSegments: [lineSegs], text: segmentsText(lineSegs) };
          out.push(new Utterance(d, auto));
        });
        continue;
      }
      out.push(new Utterance(u, auto));
    }
    // KK303 — wypowiedzi nadal za długie.
    const final: Utterance[] = [];
    for (const u of out) {
      const n = await tokens([...u.segments]);
      if (n > TOKEN_LIMIT) {
        diagnostics.push(diag('KK303', { targetId: u.id, params: { tokens: n } }));
        final.push(new Utterance({ id: u.id, lineIds: [...u.lineIds], start: u.start, end: u.end, params: { ...u.params }, segments: [...u.segments], lineSegments: [], text: u.text }, auto, Math.ceil(n / TOKEN_LIMIT)));
      } else final.push(u);
    }
    final.sort((x, y) => x.start - y.start);
    return { utterances: final, diagnostics };
  }

  // ------------------------------------------------------------ pozostałe

  /** Grupuje zmiany: jedno zdarzenie `replace` z etykietą i jedno odświeżenie atomów. */
  batch(label: string, fn: () => void): void {
    this._core.batch(label, fn);
  }

  /** Rejestruje słuchacza zmian; zwraca funkcję wyrejestrowującą. */
  onChange(listener: ChangeListener): () => void {
    return this._core.onChange(listener);
  }

  /** Czy dokument używa atomów pluginu `reactivity` (powiązane przy tworzeniu). */
  get reactive(): boolean {
    return this._core.reactive;
  }

  /** Kopia przez zapis kanoniczny i ponowne parsowanie (nowe ID). */
  clone(): KokoAss {
    const r = KokoAss.parse(this.toString(), { ...(this.#path ? { path: this.#path } : {}), seriesLexicon: this.#series });
    return r instanceof KokoErrors ? KokoAss.create() : r;
  }

  /** Zapis kanoniczny (specyfikacja API §3.2). Domyślnie LF, bez BOM. */
  toString(opts: { lineEnding?: 'lf' | 'crlf'; bom?: boolean } = {}): string {
    const L: string[] = [];
    L.push(...this._preamble);
    L.push('[Script Info]');
    for (const it of this.scriptInfo.items) L.push(it.kind === 'comment' ? `; ${it.value}`.trimEnd() : `${it.key}: ${it.value}`);
    const settingsSection = (title: string, s: Settings<object>) => {
      if (!s.items.length) return;
      L.push('', `[${title}]`);
      for (const it of s.items) L.push(it.kind === 'comment' ? `; ${it.raw}`.trimEnd() : `${it.key} = ${it.raw}`);
    };
    settingsSection('Koko Lektor', this.koko.lektor as unknown as Settings<object>);
    settingsSection('Koko Rules', this.koko.rules as unknown as Settings<object>);
    if (this.koko.styles.items.length) {
      L.push('', '[Koko Styles]');
      for (const r of this.koko.styles.items) {
        const order = ['speed', 'gain', 'mode'];
        const ps = [...r.params].sort((a, b) => (order.indexOf(a.key) < 0 ? 99 : order.indexOf(a.key)) - (order.indexOf(b.key) < 0 ? 99 : order.indexOf(b.key)));
        const val = r._skip ? ['skip', ...ps.map((p) => `${p.key}=${p.value}`)].join(' ') : ps.map((p) => `${p.key}=${p.value}`).join(' ');
        L.push(`${r._pattern} = ${val}`.trimEnd());
      }
    }
    if (this.koko.lexicon.items.length) {
      L.push('', '[Koko Lexicon]');
      for (const it of this.koko.lexicon.items) {
        if (it.kind === 'comment') L.push(`; ${it._text}`.trimEnd());
        else if (it._form === 'full') L.push(`${it._key} = ${formatInlineTable(it._shape())}`);
        else L.push(`${it._key}${it._stem ? '*' : ''} = ${it._value}`);
      }
    }
    if (this.koko.sources.items.length) {
      L.push('', '[Koko Sources]');
      for (const s of this.koko.sources.items) {
        const keys = [...SOURCE_FIELDS.filter((k) => s.fields.has(k)), ...[...s.fields.keys()].filter((k) => !(SOURCE_FIELDS as readonly string[]).includes(k))];
        L.push(`${s._label} = ${keys.map((k) => `${k}=${formatKkValue(s.fields.get(k)!)}`).join(' ')}`);
      }
    }
    L.push('', '[V4+ Styles]');
    const format = [...STYLE_FORMAT, ...this._styleExtraColumns];
    L.push(`Format: ${format.join(', ')}`);
    for (const st of this.styles.items) {
      L.push(`Style: ${format.map((f) => st.fields.get(f) ?? STYLE_DEFAULTS[f] ?? '').join(',')}`);
    }
    L.push('', '[Events]');
    L.push(`Format: ${EVENT_FORMAT.join(', ')}`);
    for (const e of this.events.items) {
      L.push(`${e._type}: ${[e._layer, formatAssTime(e._start), formatAssTime(e._end), e._style, e._name, e._marginL, e._marginR, e._marginV, e._effect, e._text].join(',')}`);
    }
    for (const sec of this._extra.items) {
      L.push('', `[${sec.name}]`, ...sec.lines);
    }
    const eol = opts.lineEnding === 'crlf' ? '\r\n' : '\n';
    return (opts.bom ? '﻿' : '') + L.join(eol) + eol;
  }
}

const EMPTY_ANALYSIS: LineAnalysis = Object.freeze({ read: false, spokenText: '', displayText: '', diagnostics: Object.freeze([]) });

/** @internal Wynik reguł pluginów. */
interface RuleResults {
  byLine: Map<string, Diagnostic[]>;
  all: Diagnostic[];
}

/** Opcje `KokoAss.import` / `doc.export`. */
export interface FormatOptions extends OperationOptions {
  /** Nadpisanie konfiguracji dla tego wywołania. */
  config?: CallConfig;
}

function opOptions<T extends object>(opts: OperationOptions, rest: T): OperationOptions & T {
  const { signal, onProgress } = opts;
  const out = { ...rest } as OperationOptions & T & { config?: unknown };
  delete out.config;
  if (signal) out.signal = signal;
  if (onProgress) out.onProgress = onProgress;
  return out;
}

const BUILTIN = '@koko-anime/formats';

/** Wbudowany format `ass`: zwykły ASS. Import tworzy szkielet Koko (wersja 1), eksport usuwa sekcje Koko. */
const ASS_CODEC: FormatCodec<KokoAss> = {
  id: 'ass',
  label: 'Advanced SubStation Alpha',
  extensions: ['.ass', '.ssa'],
  mime: 'text/x-ssa',
  async import(input, opts) {
    const text = typeof input === 'string' ? input : await input.text();
    const r = KokoAss.parse(text, (opts as { config?: CallConfig }).config ? { config: (opts as { config?: CallConfig }).config! } : {});
    if (r instanceof KokoErrors) return r;
    if (r.scriptInfo.kokoVersion === null) r.scriptInfo.kokoVersion = 1;
    return r;
  },
  async export(doc) {
    const out: string[] = [];
    let skip = false;
    for (const line of doc.toString().split('\n')) {
      const sec = /^\[(.+)\]$/.exec(line.trim());
      if (sec) skip = /^koko /i.test(sec[1]!);
      if (skip || /^kokoanime version\s*:/i.test(line.trim())) continue;
      out.push(line);
    }
    return out.join('\n').replace(/\n{3,}/g, '\n\n');
  },
  sniff: (head) => /^﻿?\s*\[Script Info\]/i.test(head),
};

function codecs(cfg: ReturnType<typeof resolveConfig>): { owner: string; codec: FormatCodec }[] {
  const byId = new Map<string, { owner: string; codec: FormatCodec }>([[ASS_CODEC.id, { owner: BUILTIN, codec: ASS_CODEC }]]);
  for (const { owner, item } of cfg.list('formats')) {
    byId.delete(item.id);
    byId.set(item.id, { owner, codec: item });
  }
  return [...byId.values()];
}

function findCodec(cfg: ReturnType<typeof resolveConfig>, id: string): { owner: string; codec: FormatCodec } | undefined {
  return codecs(cfg).find((c) => c.codec.id === id);
}

/** Formaty importu/eksportu: wbudowany `ass` i formaty z pluginów (`formats`). */
export function listFormats(opts: { config?: CallConfig } = {}): FormatInfo[] {
  return codecs(resolveConfig(opts.config)).map(({ owner, codec }) => {
    const info: FormatInfo = { id: codec.id, label: codec.label, extensions: [...codec.extensions], canImport: !!codec.import, canExport: !!codec.export, plugin: owner };
    if (codec.mime) info.mime = codec.mime;
    return info;
  });
}

/** Wykrywa format po początku treści (`sniff`); ostatni pasujący plugin wygrywa. */
export function sniffFormat(head: string, opts: { config?: CallConfig } = {}): string | undefined {
  const list = codecs(resolveConfig(opts.config));
  for (let i = list.length - 1; i >= 0; i--) {
    const c = list[i]!.codec;
    try {
      if (c.import && c.sniff?.(head)) return c.id;
    } catch {
      // błędny sniff pluginu = brak dopasowania
    }
  }
  return undefined;
}

/** Słowa wpisu `[Koko Lexicon]`: klucz, aliasy, formy. */
function entryWords(it: EpisodeLexiconItem): string[] {
  return [it._key, ...it._aliases, ...it._forms.map(([k]) => k)];
}

/**
 * Linia `[Koko Lexicon]` (Koko-ASS §2): komentarz, forma prosta albo pełna (wartość od `{` = tabela TOML w jednej linii).
 * Błędy formy pełnej → kody KL z pozycją w pliku `.ass`; KL001 pomija tylko ten wpis.
 */
function parseLexiconLine(doc: KokoAss, l: string, line: number, diags: Diagnostic[]): EpisodeLexiconItem | null {
  if (!l.trim()) return null;
  const at = (column: number) => (line ? { position: { line, column } } : {});
  if (l.trimStart().startsWith(';')) {
    const it = new EpisodeLexiconItem(doc, 'comment', { text: l.trimStart().slice(1).trim() });
    if (line) it.sourceLine = line;
    return it;
  }
  const eq = l.indexOf('=');
  const keyRaw = eq < 0 ? '' : l.slice(0, eq).trim();
  const value = eq < 0 ? '' : l.slice(eq + 1).trim();
  if (eq < 0 || !keyRaw.replace(/\*$/, '').trim() || !value || value === '~') {
    diags.push(diag('KK006', { ...at(1), params: { line: l.trim() } }));
    return null;
  }
  let it: EpisodeLexiconItem;
  if (value.startsWith('{')) {
    const valueCol = eq + 1 + (l.slice(eq + 1).length - l.slice(eq + 1).trimStart().length) + 1;
    if (keyRaw.endsWith('*')) {
      diags.push(diag('KL004', { ...at(1), params: { key: keyRaw, reason: 'star-in-full-form' } }));
      return null;
    }
    const r = parseInlineTable(value);
    if ('error' in r) {
      diags.push(diag('KL001', { ...at(valueCol + r.column - 1), params: { key: keyRaw, message: r.error } }));
      return null;
    }
    const shape = validateEntryTable(keyRaw, r.table, (code, params) => diags.push(diag(code, { ...at(valueCol), params })));
    if (!shape) return null;
    it = new EpisodeLexiconItem(doc, 'entry', { key: keyRaw, full: shape });
  } else {
    it = new EpisodeLexiconItem(doc, 'entry', { key: keyRaw.replace(/\*$/, '').trim(), stem: keyRaw.endsWith('*'), value });
  }
  if (line) it.sourceLine = line;
  return it;
}

/** Oznacza blok spłaszczonego leksykonu (dokładnie jeden begin przed jednym end). */
function markFlattened(items: EpisodeLexiconItem[]): void {
  const begins = items.filter((i) => i.kind === 'comment' && i._text === '@koko-lexicon-begin');
  const ends = items.filter((i) => i.kind === 'comment' && i._text === '@koko-lexicon-end');
  if (begins.length !== 1 || ends.length !== 1) return;
  const b = items.indexOf(begins[0]!);
  const e = items.indexOf(ends[0]!);
  if (b > e) return;
  for (let i = b; i <= e; i++) items[i]!._flattened = true;
}

/** Zdarzenia `[Events]` w kolejności pliku. */
export class EventList extends ItemCollection<AssEvent> implements Collection<AssEvent> {
  /** @internal */ readonly owner: KokoAss;

  /** @internal */
  constructor(owner: KokoAss) {
    super(owner._core, 'events');
    this.owner = owner;
  }

  /** Linie `Dialogue`. */
  get dialogues(): readonly AssEvent[] {
    this.atom.track();
    return this.items.filter((e) => e._type === 'Dialogue');
  }

  /** Wstawia zdarzenie na pozycji albo za zdarzeniem o ID `after` (domyślnie na końcu). */
  insert(event: AssEventData = {}, at?: number | { after: string }): AssEvent {
    const ev = new AssEvent(this.owner, event);
    let idx = this.items.length;
    if (typeof at === 'number') idx = Math.max(0, Math.min(at, this.items.length));
    else if (at && 'after' in at) {
      const i = this.items.findIndex((x) => x.id === at.after);
      idx = i < 0 ? this.items.length : i + 1;
    }
    this.items.splice(idx, 0, ev);
    this.owner._globalChanged([this.atom], ev.id, ['events', ev.id], 'insert');
    return ev;
  }

  /** Usuwa zdarzenie. */
  remove(id: string): boolean {
    const i = this.items.findIndex((x) => x.id === id);
    if (i < 0) return false;
    this.items.splice(i, 1);
    this.owner._globalChanged([this.atom], id, ['events', id], 'remove');
    return true;
  }

  /** Przenosi zdarzenie na pozycję. */
  move(id: string, to: number): void {
    const i = this.items.findIndex((x) => x.id === id);
    if (i < 0) return;
    const [ev] = this.items.splice(i, 1);
    this.items.splice(Math.max(0, Math.min(to, this.items.length)), 0, ev!);
    this.owner._globalChanged([this.atom], id, ['events', id], 'move');
  }

  /** Sortowanie stabilne po czasie startu. */
  sortByStart(): void {
    this.items = this.items.map((e, i) => [e, i] as const).sort((a, b) => a[0]._start - b[0]._start || a[1] - b[1]).map(([e]) => e);
    this.owner._globalChanged([this.atom], null, ['events'], 'move');
  }

  /** Przesuwa wszystkie (albo wybrane) linie o `deltaMs` w jednej grupie zmian. */
  shift(deltaMs: number, ids?: readonly string[]): void {
    const set = ids ? new Set(ids) : null;
    this.owner.batch('shift', () => {
      for (const e of this.items) {
        if (set && !set.has(e.id)) continue;
        e.start = e._start + deltaMs;
        e.end = e._end + deltaMs;
      }
    });
  }
}

export type { LineAnalysis, SynthesisIdentity, UtteranceParams, EffectiveSettings };
