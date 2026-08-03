import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['cjs', 'esm'],
  dts: true,
  outDir: 'dist',
  clean: true,
  splitting: false,
  sourcemap: true,
  esbuildOptions(options) {
    options.platform = 'node';
  },
});
