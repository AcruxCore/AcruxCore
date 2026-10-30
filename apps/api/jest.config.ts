import type { Config } from 'jest';

const config: Config = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: '.',
  testMatch: ['<rootDir>/src/**/*.test.ts'],
  transform: {
    // Transpile-only (`isolatedModules` in tsconfig.jest.json): type-checking
    // every test file against the whole program was most of a cold run's CPU,
    // and it duplicated `tsc --noEmit`, which already covers the test files.
    '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.jest.json' }],
    // better-auth and its dependency chain are ESM-only (`"type": "module"`, no
    // CJS build). Node 22 loads them fine via its native `require(esm)` support,
    // so the app itself needs no change — but Jest replaces `require` with its
    // own registry, which has no such support and throws "Cannot use import
    // statement outside a module". Down-compiling just those packages to
    // CommonJS is far cheaper than migrating ~100 CJS suites to ESM.
    //
    // swc rather than ts-jest, deliberately: TypeScript decides module format
    // from the file *extension*, so it emits ESM for a `.mjs` input no matter
    // what `module` says — which turns the original error into
    // "Unexpected token 'export'". swc has no such rule and honours the setting.
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
  // `node_modules/better-auth/node_modules/jose/…` and the pattern is tested
  // against the LAST `/node_modules/` segment too — `jose` and `@noble` must be
  // named explicitly or they are skipped and re-introduce the same syntax error.
  transformIgnorePatterns: [
    '/node_modules/(?!(better-auth|better-call|@better-auth|@better-fetch|nanostores|defu|jose|@noble|rou3|kysely)/)',
  ],
  // Env defaults that must land before any module (and therefore any memoized
  // config read) is imported. See the file's own docstring.
  setupFiles: ['<rootDir>/src/test-utils/jest-env.ts'],
  // Closes the shared Redis connection / BullMQ queues / Prisma client after each
  // suite. Without it, any suite whose code path reaches `notify()` leaves an open
  // socket and Jest never exits. See the file's own docstring.
  setupFilesAfterEnv: ['<rootDir>/src/test-utils/jest-teardown.ts'],
  // Gives the run its own BullMQ key prefix, and clones the test database once
  // per extra worker before a parallel run. See `worker-isolation.ts`.
  globalSetup: '<rootDir>/src/test-utils/jest-global-setup.ts',
  // Deletes the BullMQ keys of this run's own prefix. See the file's docstring.
  globalTeardown: '<rootDir>/src/test-utils/jest-global-teardown.ts',
  // Jest's 5 s default failed whole tests on CI that take ~0.4 s locally: the
  // runner is ~5x slower and shares its cores with Postgres and Redis, so an
  // ordinary test with a signup and a few requests ran past 5 s now and then
  // (issues #501, #531). 20 s still fails a genuine hang quickly.
  testTimeout: 20_000,
  // Serial by default — each suite hits a real DB. `npm run test:parallel`
  // overrides this; each worker then gets its own database and Redis index.
  maxWorkers: 1,
};

export default config;
