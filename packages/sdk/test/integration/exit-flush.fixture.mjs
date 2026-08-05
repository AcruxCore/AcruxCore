// Answers one question and returns — deliberately WITHOUT calling close(). Whether the
// trace arrives is entirely down to the SDK's `beforeExit` hook, which is the only thing
// this fixture exists to prove. Run as a real child process by
// `trace.integration.test.ts`: an in-process test cannot exercise `beforeExit`, because
// the test runner's own event loop never drains.
import { acruxcore } from '../../dist/index.mjs';

const hub = new acruxcore({
  apiKey: process.env.FIXTURE_API_KEY,
  baseUrl: process.env.FIXTURE_BASE_URL,
});

await hub.gateway.chat({
  model: 'stub-model',
  messages: [{ role: 'user', content: 'ping' }],
  provider: { baseUrl: process.env.FIXTURE_PROVIDER_URL, apiKey: 'p' },
});

process.stdout.write('done');
