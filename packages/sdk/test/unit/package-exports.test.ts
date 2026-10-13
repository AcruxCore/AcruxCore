import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';
import ts from 'typescript';

const PKG_DIR = path.resolve(__dirname, '../..');
const DIST = path.join(PKG_DIR, 'dist') + path.sep;

/**
 * Resolves `specifier` the way TypeScript does under `moduleResolution: nodenext`, from an ES module
 * (`.mts`) or a CommonJS (`.cts`) file inside the package, which reaches the package by self-reference.
 * Files under `dist/` count as present, so the test needs no build.
 */
function resolvedTypes(specifier: string, from: 'esm' | 'cjs'): string | undefined {
  const containing = path.join(PKG_DIR, 'test', from === 'esm' ? 'consumer.mts' : 'consumer.cts');
  const host: ts.ModuleResolutionHost = {
    fileExists: (f) => f.startsWith(DIST) || fs.existsSync(f),
    readFile: (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : undefined),
  };
  const options: ts.CompilerOptions = {
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
  };
  const mode = from === 'esm' ? ts.ModuleKind.ESNext : ts.ModuleKind.CommonJS;
  return ts.resolveModuleName(specifier, containing, options, host, undefined, undefined, mode).resolvedModule
    ?.resolvedFileName;
}

// With one `types` entry for both conditions, an ES module consumer under nodenext read the CommonJS
// declarations, so `import AcruxCore from '@acruxcoreai/sdk'` typed as the module and `new AcruxCore()`
// failed with TS2351. Each condition must point at the declarations for its own format.
describe('package exports under moduleResolution nodenext', () => {
  it.each([
    ['@acruxcoreai/sdk', 'index'],
    ['@acruxcoreai/sdk/otel', 'otel'],
  ])('%s resolves to .d.mts for import and .d.ts for require', (specifier, base) => {
    expect(resolvedTypes(specifier, 'esm')).toBe(path.join(PKG_DIR, 'dist', `${base}.d.mts`));
    expect(resolvedTypes(specifier, 'cjs')).toBe(path.join(PKG_DIR, 'dist', `${base}.d.ts`));
  });
});
