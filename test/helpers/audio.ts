import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const SR = 24000;

/** Ton sinusoidalny (PCM float32 mono). */
export function tone(ms: number, freq = 440, amp = 0.3): Float32Array {
  const n = Math.round((ms * SR) / 1000);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin((2 * Math.PI * freq * i) / SR);
  return out;
}

/** Uruchamia ffmpeg; czytelny błąd, gdy go brak w PATH. */
function ffmpeg(args: string[]): void {
  const r = spawnSync('ffmpeg', args);
  if (r.error) throw new Error(`ffmpeg niedostępny (${r.error.message}) — testy audio wymagają ffmpeg z libmp3lame i libopus w PATH`);
  if (r.status !== 0) throw new Error(`ffmpeg: ${String(r.stderr)}`);
}

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'koko-'));
}

/** Kodowanie MP3 CBR 64 kbit/s @ 24 kHz mono, bez rezerwuaru bitów (LAME --nores). */
export function encodeMp3(pcm: Float32Array, opts: { rawFrames?: boolean } = {}): Uint8Array {
  const d = tmp();
  writeFileSync(join(d, 'in.f32'), Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength));
  ffmpeg(['-hide_banner', '-loglevel', 'error', '-f', 'f32le', '-ar', String(SR), '-ac', '1', '-i', join(d, 'in.f32'),
    '-c:a', 'libmp3lame', '-b:a', '64k', '-reservoir', '0', '-write_xing', opts.rawFrames ? '0' : '1', '-id3v2_version', '0', '-f', 'mp3', join(d, 'out.mp3')]);
  return new Uint8Array(readFileSync(join(d, 'out.mp3')));
}

export function encodeOpus(pcm: Float32Array): Uint8Array {
  const d = tmp();
  writeFileSync(join(d, 'in.f32'), Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength));
  ffmpeg(['-hide_banner', '-loglevel', 'error', '-f', 'f32le', '-ar', String(SR), '-ac', '1', '-i', join(d, 'in.f32'),
    '-c:a', 'libopus', '-b:a', '32k', '-f', 'ogg', join(d, 'out.opus')]);
  return new Uint8Array(readFileSync(join(d, 'out.opus')));
}

/** Dekodowanie bez kompensacji opóźnień (surowe próbki, jak w definicji encoderDelay). */
export function decodeRaw(bytes: Uint8Array, fmt: 'mp3' | 'ogg' = 'mp3'): Float32Array {
  const d = tmp();
  writeFileSync(join(d, `in.${fmt}`), bytes);
  const args = ['-hide_banner', '-loglevel', 'error'];
  if (fmt === 'mp3') args.push('-flags2', '+skip_manual');
  args.push('-i', join(d, `in.${fmt}`), '-f', 'f32le', '-ac', '1', '-ar', String(SR), join(d, 'out.f32'));
  ffmpeg(args);
  const buf = readFileSync(join(d, 'out.f32'));
  return new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
}
