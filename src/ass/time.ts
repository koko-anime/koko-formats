/** Czasy ASS `H:MM:SS.cc` ↔ ms. */

/** Czas ASS (`H:MM:SS.cc`) → ms; `undefined` dla złego zapisu. */
export function parseAssTime(s: string): number | undefined {
  const m = /^\s*(\d+):(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3}))?\s*$/.exec(s);
  if (!m) return undefined;
  const frac = m[4] ?? '0';
  const ms = frac.length === 1 ? Number(frac) * 100 : frac.length === 2 ? Number(frac) * 10 : Number(frac);
  return ((Number(m[1]) * 60 + Number(m[2])) * 60 + Number(m[3])) * 1000 + ms;
}

/** ms → czas ASS `H:MM:SS.cc` (zaokrąglenie do setnych). */
export function formatAssTime(ms: number): string {
  const cs = Math.max(0, Math.round(ms / 10));
  const h = Math.floor(cs / 360000);
  const m = Math.floor(cs / 6000) % 60;
  const sec = Math.floor(cs / 100) % 60;
  const c = cs % 100;
  return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}.${String(c).padStart(2, '0')}`;
}
