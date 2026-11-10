/**
 * Dopasowanie czasowe (Koko-ASS §4.6) i dopasowanie wypowiedzi do osi czasu (Koko-Pack §6.3).
 * Czyste funkcje — długości klipów dostarcza callback (synteza).
 */
import { diag, type Diagnostic } from '../core/diagnostics.ts';
import { round4 } from '../core/hash.ts';
import type { ClipJson, TimeRangeJson } from '../pack/json-types.ts';

/** Wypowiedź wejściowa dopasowania czasowego. */
export interface FitInput {
  /** ID wypowiedzi. */
  id: string;
  /** `u.Start` (ms). */
  start: number;
  /** `u.End` — koniec slotu bez pożyczania (ms). */
  end: number;
  /** Efektywny `offset` wypowiedzi (ms). */
  offset: number;
  /** Prędkość bazowa `s0`. */
  s0: number;
  /** `smax = s0 · maxSpeed`. */
  smax: number;
  /** Znana długość przy `s0` — pomija pierwszą syntezę (stan „do przeliczenia”). */
  baseDuration?: number;
}

/** Ustawienia timingu z `[Koko Lektor]`/`[Koko Rules]`. */
export interface FitSettings {
  /** `MinGap` — minimalna cisza między klipami (ms). */
  minGap: number;
  /** `BorrowGap` — można zająć ciszę do następnej wypowiedzi. */
  borrowGap: boolean;
  /** `MaxDelay` — próg KK403 (ms). */
  maxDelay: number;
}

/** Wynik dopasowania jednej wypowiedzi. */
export interface FitResult {
  /** ID wypowiedzi. */
  id: string;
  /** Start klipu (ms). */
  t0: number;
  /** Koniec slotu (ms). */
  slotEnd: number;
  /** Prędkość faktycznie użyta (po `round4`). */
  speed: number;
  /** Długość klipu (ms). */
  duration: number;
  /** Długość przy prędkości bazowej (ms). */
  baseDuration: number;
  /** Opóźnienie względem `start + offset` (ms). */
  delay: number;
  /** KK401–KK403. */
  diagnostics: Diagnostic[];
}

/** Zwraca długość klipu (ms) przy danej prędkości — zwykle przez syntezę. */
export type Measure = (u: FitInput, speed: number) => Promise<number>;

/** Opcje `fitUtterances`. */
export interface FitOptions {
  /** Przerwanie. */
  signal?: AbortSignal;
  /** Koniec poprzedniego klipu (gdy liczone od środka listy). */
  prevEnd?: number;
}

function startOf(u: { start: number; offset: number }): number {
  return u.start + u.offset;
}

/** Kroki 3–6 Koko-ASS §4.6 dla jednej wypowiedzi przy znanych `t0` i `slotEnd`. */
export async function fitOne(u: FitInput, t0: number, slotEnd: number, settings: FitSettings, measure: Measure): Promise<FitResult> {
  const diagnostics: Diagnostic[] = [];
  const slot = slotEnd - t0;
  const s0 = round4(u.s0);
  const smax = round4(Math.max(u.smax, u.s0));
  const base = u.baseDuration ?? (await measure(u, s0));
  let s = s0;
  let d = base;
  if (d > slot) {
    if (slot <= 0) {
      s = smax;
      if (s !== s0) d = await measure(u, s);
    } else {
      s = round4(Math.min((s0 * d) / slot, smax));
      if (s !== s0) d = await measure(u, s);
      if (d > slot && s < smax) {
        const s2 = round4(Math.min((s * d) / slot, smax));
        if (s2 !== s) {
          s = s2;
          d = await measure(u, s);
        }
      }
    }
  }
  if (s / s0 > 1.15) diagnostics.push(diag('KK401', { targetId: u.id, params: { speed: s, ratio: round4(s / s0) } }));
  if (d > slot) diagnostics.push(diag('KK402', { targetId: u.id, params: { overflow: d - slot } }));
  const delay = t0 - startOf(u);
  if (delay > settings.maxDelay) diagnostics.push(diag('KK403', { targetId: u.id, params: { delay } }));
  return { id: u.id, t0, slotEnd, speed: s, duration: d, baseDuration: base, delay, diagnostics };
}

/** Koniec slotu (krok 2 Koko-ASS §4.6). */
export function slotEndOf(u: FitInput, next: FitInput | undefined, settings: FitSettings): number {
  return settings.borrowGap && next ? Math.max(u.end, startOf(next)) : u.end;
}

/**
 * Dopasowanie czasowe wypowiedzi (Koko-ASS §4.6) — sekwencyjnie, po syntezie każdej poprzedniej.
 * `utterances` w kolejności Start (przy równym Start — kolejność w pliku).
 */
export async function fitUtterances(utterances: readonly FitInput[], settings: FitSettings, measure: Measure, opts: FitOptions = {}): Promise<FitResult[]> {
  const out: FitResult[] = [];
  let prevEnd = opts.prevEnd;
  for (let i = 0; i < utterances.length; i++) {
    if (opts.signal?.aborted) break;
    const u = utterances[i]!;
    const t0 = prevEnd === undefined ? startOf(u) : Math.max(startOf(u), prevEnd + settings.minGap);
    const r = await fitOne(u, t0, slotEndOf(u, utterances[i + 1], settings), settings, measure);
    out.push(r);
    prevEnd = r.t0 + r.duration;
  }
  return out;
}

// ---------------------------------------------------------------- Koko-Pack §6.3

/** Pełny wpis osi czasu (profil `full`, Koko-Pack §5). */
export interface TimelineUtterance {
  /** Klucz danych wejściowych syntezy — jedyna podstawa dopasowania. */
  key: string;
  /** Slot (`start` = `t0`, `end` = `slot_end`). */
  slot: TimeRangeJson;
  /** Położenie klipu. */
  clip: ClipJson;
  /** Długość przy prędkości bazowej (ms). */
  baseDuration: number;
  /** Prędkość faktycznie użyta. */
  speed: number;
  /** Efektywny gain (dB). */
  gain: number;
  /** Opóźnienie względem startu wypowiedzi (ms). */
  delay: number;
  /** Kody diagnostyk timingu. */
  diagnostics?: string[];
  /** Numery linii przy zapisie (informacyjnie). */
  lines?: number[];
  /** Czytelny tekst mówiony (informacyjnie). */
  text?: string;
}

/** Wypowiedź bieżących napisów do dopasowania. */
export interface ReconcileInput extends FitInput {
  /** Klucz wypowiedzi. */
  key: string;
  /** Efektywny gain (dB). */
  gain: number;
}

/** Stan wypowiedzi (Koko-Pack §6.3): aktualna, przesunięta, do przeliczenia, nowa, zmieniona głośność, osierocona. */
export type ReconcileState = 'current' | 'moved' | 'recompute' | 'new' | 'gain' | 'orphaned';

/** Decyzja dla wypowiedzi albo wpisu osieroconego. */
export interface ReconcileDecision {
  /** null dla wpisu osieroconego. */
  id: string | null;
  /** Klucz wypowiedzi. */
  key: string | null;
  /** Stan. */
  state: ReconcileState;
  /** „przesunięta” + zmieniony gain. */
  alsoGain?: boolean;
  /** Wpis osi czasu użyty do dopasowania (dla osieroconych — ten wpis). */
  previous?: TimelineUtterance;
  /** Wynik dopasowania (dla wypowiedzi; w trybie planu długości mogą być szacunkowe). */
  fit?: FitResult;
  /** true, gdy `fit` pochodzi z szacunku (tryb planu, bez syntezy). */
  estimated?: boolean;
}

/** Opcje `reconcileTimeline`. */
export interface ReconcileOptions {
  /** Przerwanie. */
  signal?: AbortSignal;
  /** Synteza dla wypowiedzi nowych/do przeliczenia. Bez niej — tryb planu (długości szacunkowe). */
  measure?: Measure;
}

function reusable(u: ReconcileInput, prev: TimelineUtterance, slotLen: number): boolean {
  const s0 = round4(u.s0);
  const smax = round4(u.smax);
  const speed = round4(prev.speed);
  const prevSlot = prev.slot.end - prev.slot.start;
  if (speed === s0 && prev.baseDuration <= slotLen) return true;
  if (slotLen === prevSlot && speed <= smax) return true;
  if (speed === smax && slotLen <= prevSlot) return true;
  return false;
}

/**
 * Dopasowanie wypowiedzi do istniejącej osi czasu (Koko-Pack §6.3).
 * Dopasowanie wyłącznie po kluczu; powtórzone klucze parowane w kolejności czasu.
 */
export async function reconcileTimeline(
  current: readonly ReconcileInput[],
  timeline: readonly TimelineUtterance[],
  settings: FitSettings,
  opts: ReconcileOptions = {},
): Promise<ReconcileDecision[]> {
  const pool = new Map<string, TimelineUtterance[]>();
  for (const t of [...timeline].sort((a, b) => a.clip.start - b.clip.start)) {
    const l = pool.get(t.key) ?? [];
    l.push(t);
    pool.set(t.key, l);
  }
  const used = new Set<TimelineUtterance>();
  const out: ReconcileDecision[] = [];
  let prevEnd: number | undefined;
  for (let i = 0; i < current.length; i++) {
    if (opts.signal?.aborted) break;
    const u = current[i]!;
    const prev = pool.get(u.key)?.shift();
    if (prev) used.add(prev);
    const startU = u.start + u.offset;
    const t0 = prevEnd === undefined ? startU : Math.max(startU, prevEnd + settings.minGap);
    const slotEnd = slotEndOf(u, current[i + 1], settings);
    const slotLen = slotEnd - t0;
    let d: ReconcileDecision;
    if (prev && reusable(u, prev, slotLen)) {
      const moved = prev.clip.start !== t0;
      const gainChanged = prev.gain !== u.gain;
      const state: ReconcileState = moved ? 'moved' : gainChanged ? 'gain' : 'current';
      const fit: FitResult = { id: u.id, t0, slotEnd, speed: prev.speed, duration: prev.clip.duration, baseDuration: prev.baseDuration, delay: t0 - startU, diagnostics: [] };
      if (fit.delay > settings.maxDelay) fit.diagnostics.push(diag('KK403', { targetId: u.id, params: { delay: fit.delay } }));
      d = { id: u.id, key: u.key, state, previous: prev, fit };
      if (moved && gainChanged) d.alsoGain = true;
    } else {
      const state: ReconcileState = prev ? 'recompute' : 'new';
      const input: FitInput = prev ? { ...u, baseDuration: prev.baseDuration } : u;
      let fit: FitResult;
      let estimated = false;
      if (opts.measure) fit = await fitOne(input, t0, slotEnd, settings, opts.measure);
      else {
        estimated = true;
        const guess = prev ? prev.baseDuration : Math.max(0, u.end - startU);
        fit = await fitOne(input, t0, slotEnd, settings, async (_u, speed) => Math.round((guess * round4(u.s0)) / speed));
      }
      d = { id: u.id, key: u.key, state, fit, ...(prev ? { previous: prev } : {}), ...(estimated ? { estimated } : {}) };
    }
    out.push(d);
    prevEnd = d.fit!.t0 + d.fit!.duration;
  }
  for (const t of timeline) if (!used.has(t)) out.push({ id: null, key: t.key, state: 'orphaned', previous: t });
  return out;
}
