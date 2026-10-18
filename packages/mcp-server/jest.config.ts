import type { Config } from 'jest';

const config: Config = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: '.',
  testMatch: ['<rootDir>/test/integration/**/*.test.ts'],
  setupFiles: ['<rootDir>/test/integration/jest.setup.ts'],
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.json', diagnostics: false }],
    // These suites import `apps/api/app.ts`, which pulls in better-auth. better-auth
    // and its dependency chain are ESM-only (`"type": "module"`, no CJS build). Node
    // loads them fine via native `require(esm)`, but Jest replaces `require` with its
    // own registry, which has no such support and throws "Cannot use import statement
    // outside a module" before a single test runs.
    //
    // swc rather than ts-jest, deliberately: TypeScript decides module format from the
    // file *extension*, so it emits ESM for a `.mjs` input no matter what `module`
    // says — which turns the original error into "Unexpected token 'export'". swc has
    // no such rule and honours the setting.
    //
    // Kept in step with apps/api/jest.config.ts: both exist for the same reason and
    // should drift together, not apart.
    '^.+\\.m?js$': [
      '@swc/jest',
      {
        jsc: { target: 'es2022', parser: { syntax: 'ecmascript' } },
        module: { type: 'commonjs' },
      },
    ],
  },
  // Everything in node_modules is left alone EXCEPT the ESM-only auth chain.
  // Note the nested entries: better-auth pins its own `jose`, so the path is
  // `node_modules/better-auth/node_modules/jose/…` and the pattern is tested against
  // the LAST `/node_modules/` segment too — `jose` and `@noble` must be named
  // explicitly or they are skipped and re-introduce the same syntax error.
  transformIgnorePatterns: [
    '/node_modules/(?!(better-auth|better-call|@better-auth|@better-fetch|nanostores|defu|jose|@noble|rou3|kysely)/)',
  ],
  maxWorkers: 1,
};

export default config;
