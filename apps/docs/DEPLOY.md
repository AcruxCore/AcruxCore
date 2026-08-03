# Deploying the Acrux Core docs site

The docs site (`apps/docs`) is a **static** Docusaurus build. `npm run build -w
@acruxcore/docs` produces `apps/docs/build/`, a folder of pre-rendered HTML that
any static host can serve. This makes hosting cheap and fully reversible.

The default target is **Cloudflare Pages** (a managed static host — see
"Why Cloudflare Pages" below). A self-hosted alternative (Caddy on the owner's
own server) is documented at the end and needs no code change beyond the CI
deploy step.

## Why Cloudflare Pages (not self-hosted)

Docs started out planned for the owner's own server (Caddy + Cloudflare CDN in
front), but moved to Cloudflare Pages before go-live:

- **Uptime is decoupled from the product VPS.** The app stack (`api`/`worker`/`web`)
  and the docs site no longer share a failure domain — a VPS reboot, disk-full
  event, or bad app deploy no longer takes the docs site down with it.
- **Global CDN and HTTPS by default**, with no Caddy config or cert renewal to
  maintain — a direct speed/SEO win over a single-region origin.
- **Same Cloudflare account already in use** for the app's Cloudflare Tunnel, so
  this adds no new vendor.

## CI

`.github/workflows/docs.yml` runs on pushes to `main` **and on pull requests**
that touch `apps/docs/**`, `docs/api/**`, or the workflow itself. On PRs it is
build-only (deploy is gated on the Cloudflare token **and** `github.event_name ==
'push'` — secrets are available to same-repo PR runs too, so the event check is
what actually keeps PRs from deploying), so a dead link or broken build is caught
before merge without ever deploying. It:

1. installs deps (`npm ci`),
2. builds the site — the build **fails on broken internal links**
   (`onBrokenLinks: 'throw'`), so a dead link blocks deploy,
3. uploads the build as an artifact, and
4. **deploys `apps/docs/build/` to Cloudflare Pages** via `wrangler pages deploy`
   — but only on push to `main` and only when the deploy secrets are set. Without
   them the job is build-only (a safe no-op deploy).

### One-time setup (owner action, in the Cloudflare dashboard)

1. **Create the Pages project:** Workers & Pages → Create application → Pages →
   Upload assets (direct upload, not "Connect to Git" — CI already builds and
   pushes the output, so a second build pipeline in Cloudflare would be a
   duplicate, drift-prone build config). Name it `acruxcore-docs` (must match
   `--project-name` in `docs.yml`). The first deploy from CI populates it.
2. **Add the custom domain:** in the project's Custom domains tab, add
   `docs.acruxcore.com`. Since the zone is already on Cloudflare, the CNAME is
   created automatically — no manual DNS edit needed.
3. **Create an API token:** My Profile → API Tokens → Create Token → permission
   `Account.Cloudflare Pages: Edit`. Note the **Account ID** too (right sidebar of
   any Cloudflare dashboard page, or `wrangler whoami`).

### Required GitHub secrets (for deploy)

| Secret | Meaning |
|--------|---------|
| `CLOUDFLARE_API_TOKEN` | Token with `Cloudflare Pages: Edit` permission. **When unset, deploy is skipped.** |
| `CLOUDFLARE_ACCOUNT_ID` | The Cloudflare account ID the Pages project lives in. |

Set both under **Settings → Secrets and variables → Actions** (Repository
secrets) in GitHub.

### Optional GitHub secret (analytics)

| Secret | Meaning |
|--------|---------|
| `GA4_MEASUREMENT_ID` | Same GA4 property as the marketing site (e.g. `G-XXXXXXXXXX`). Unset, the build skips the analytics tag entirely — see `docusaurus.config.ts`. |

## DNS

No manual DNS step — adding the custom domain in the Pages project (above)
creates the record automatically, since the domain's zone already lives on
Cloudflare. The site's canonical `url` is unchanged, still
`https://docs.acruxcore.com` in `docusaurus.config.ts`.

## Local preview of the production build

```bash
npm run build -w @acruxcore/docs
npm run serve -w @acruxcore/docs -- --port 3100   # serves apps/docs/build at :3100
```

The dev server (`npm run start -w @acruxcore/docs`) also runs on **3100** (the API
owns 3000).

## Alternative: self-hosted server (Caddy)

The original plan before moving to Cloudflare Pages. Still fully supported if
self-hosting is ever preferred again — only the CI deploy step and secrets
change; the Docusaurus build itself is unaffected.

[Caddy](https://caddyserver.com) serves the static files and gets automatic HTTPS
(no certbot cron):

```caddyfile
docs.acruxcore.com {
    root * /var/www/acruxcore-docs
    file_server
    encode gzip zstd

    # Docusaurus emits clean URLs (trailingSlash: false); serve the 404 page.
    handle_errors {
        rewrite * /404.html
        file_server
    }
}
```

Reload after changing: `sudo systemctl reload caddy`. CI would rsync
`apps/docs/build/` to the server over SSH, gated on `DOCS_SSH_HOST` /
`DOCS_SSH_USER` / `DOCS_SSH_KEY` / `DOCS_DEPLOY_PATH` secrets (`rsync -az
--delete` to mirror `build/` exactly, so removed pages disappear on the server
too) — see this file's git history for the exact workflow step.

## Other managed-host alternative (no code change)

To use Vercel or Netlify instead of Cloudflare Pages:

- **Build command:** `npm run build -w @acruxcore/docs`
- **Output directory:** `apps/docs/build`
- **Install command:** `npm ci` (run at the repo root — this is an npm workspace)

Only Docusaurus's `url`/`baseUrl` would change if the domain differs; nothing else
in the repo needs to move.

## Notes / follow-ups

- Structured data: blog posts emit `BlogPosting` JSON-LD (Docusaurus built-in),
  and every page carries site-wide `Organization` + `WebSite` JSON-LD plus Open
  Graph/Twitter and canonical tags.
- One known non-fatal build warning: a cross-reference anchor in the curl-verified
  `docs/api/optimize.md`. It's left as-is to honor the no-drift rule for
  `docs/api/` (that folder is the single source of truth for the API reference).
