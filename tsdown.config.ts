import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    config: 'src/config/index.ts',
    plugin: 'src/plugin/index.ts',
    ass: 'src/ass/index.ts',
    lexicon: 'src/lexicon/index.ts',
    numbers: 'src/numbers/index.ts',
    pack: 'src/pack/index.ts',
    timing: 'src/timing/index.ts',
    mp3: 'src/mp3/index.ts',
    'crypto-noble': 'src/crypto-noble/index.ts',
  },
  format: 'esm',
  dts: true,
  platform: 'neutral',
  target: 'es2022',
  clean: true,
  sourcemap: true,
});
