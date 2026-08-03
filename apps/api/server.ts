import './src/shared/env/load-root-env'; // loads the repo root .env before anything else
import './src/shared/monitoring'; // installs Sentry instrumentation before Express is required
import { createApp } from './app';
import { assertMasterKey } from './src/gateway/connections/crypto';
import { assertEmailConfig, assertUnsubscribeSecret } from './src/email';
import { assertAuthConfig } from './src/shared/auth';
import { AuthRepository, FirstRunService } from './src/auth';

// Fail fast if the gateway encryption key is missing or the wrong length.
assertMasterKey();
// Fail fast on a misconfigured email environment — a bad SES setup must not
// surface as silent non-delivery hours after deploy.
assertEmailConfig();
// Every notification body carries an unsubscribe link, minted with this secret.
// Without it in production the API would mail links that can never be honoured —
// and RFC 8058 requires bulk senders to honour them.
assertUnsubscribeSecret();
// Sessions and claim tokens are signed with BETTER_AUTH_SECRET. Missing it in
// production would mean nobody can sign in, so refuse to start instead.
assertAuthConfig();

// `API_PORT` is the repo-wide name for this port (root `.env`): Compose maps it
// to the host, and `apps/web/vite.config.ts` points its dev proxy at it. `PORT`
// stays ahead of it because that is what Compose sets inside the container and
// what most PaaS hosts inject; the 3000 at the end is only a last resort for an
// environment that sets neither.
const PORT = parseInt(process.env.PORT ?? process.env.API_PORT ?? '3000', 10);
const app = createApp();

app.listen(PORT, async () => {
  console.log(`API server listening on http://localhost:${PORT}`);
  // Printed only while the instance has no accounts, so a restart never hands
  // out a fresh way in. This is how a self-hosted install with no email
  // transport gets its first owner.
  try {
    await new FirstRunService(new AuthRepository()).printClaimUrlIfUnclaimed();
  } catch (err) {
    // A database that is not reachable yet must not stop the server from
    // listening — health checks and the eventual retry both need it up.
    console.error('[first-run] could not determine whether this instance is claimed', err);
  }
});
