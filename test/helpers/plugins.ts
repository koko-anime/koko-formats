import { definePlugin } from '../../src/plugin/index.ts';
import type { CanonicalSegment } from '../../src/plugin/index.ts';
import { SR, decodeRaw, encodeMp3, encodeOpus } from './audio.ts';

/** G2P-atrapa: „IPA” = tekst; 1 token = 2 znaki. */
export const mockG2p = () =>
  definePlugin({
    name: 'mock-g2p',
    g2p: {
      toIpa: async (segs: CanonicalSegment[]) => [segs.map((s) => (s.t === 'pause' ? ' ' : s.s)).join(' ')],
      tokenCount: async (ipa: string) => Math.ceil(ipa.length / 2),
      ipaVocabulary: async () => new Set([...'abcdefghijklmnopqrstuvwxyzɔɲʑɕ']),
    },
  });

export const synthCalls: { speed: number; text: string }[] = [];

/** Synteza-atrapa: 55 ms na znak / prędkość, ton zależny od tekstu. */
export const mockSynth = () =>
  definePlugin({
    name: 'mock-synth',
    synth: {
      info: async () => ({ engine: 'mock 1.0', model: 'mock-model', g2p: 'mock-g2p 1.0' }),
      synthesize: async (req) => {
        const text = req.ipa.join(' ');
        synthCalls.push({ speed: req.speed, text });
        const ms = Math.round((text.length * 55) / req.speed);
        const n = Math.round((ms * SR) / 1000);
        const f = 200 + (text.length % 7) * 50;
        const pcm = new Float32Array(n);
        for (let i = 0; i < n; i++) pcm[i] = 0.25 * Math.sin((2 * Math.PI * f * i) / SR);
        return { pcm, sampleRate: SR, durationMs: ms };
      },
    },
  });

export const encodeCalls: { raw: boolean; samples: number }[] = [];

export const ffmpegEncoder = () =>
  definePlugin({
    name: 'ffmpeg',
    encoder: {
      mp3: async (pcm, o) => {
        encodeCalls.push({ raw: !!o.rawFrames, samples: pcm.length });
        return encodeMp3(pcm, { rawFrames: !!o.rawFrames });
      },
      opus: async (pcm) => encodeOpus(pcm),
      decode: async (blob, codec) => ({ pcm: decodeRaw(new Uint8Array(await blob.arrayBuffer()), codec === 'opus' ? 'ogg' : 'mp3'), sampleRate: SR }),
    },
  });
