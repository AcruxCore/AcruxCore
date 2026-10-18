import { defineConfig } from 'tsup';

export default defineConfig({
  // `bin` is a second entry rather than part of `index` because it has a shebang and
  // side effects (it connects a transport on import). Anything importing the library
  // must not start a server by accident.
  entry: ['src/index.ts', 'src/bin.ts'],
  format: ['cjs', 'esm'],
  dts: true,
  outDir: 'dist',
  clean: true,
  splitting: false,
  sourcemap: true,
  // `acruxcore-mcp` in package.json#bin points at dist/bin.js (the CJS build). tsup
  // carries the shebang through and chmods the output itself — verified on the built
  // file — so no banner or postbuild step is needed here.
  esbuildOptions(options) {
    options.platform = 'node';
  },
});
