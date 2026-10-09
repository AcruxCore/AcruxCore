# AcruxCore API

[AcruxCore](https://acruxcore.com) is an open-source platform for LLM apps. It has a prompt registry, an AI gateway, tracing, a tool catalog and evaluation. This image runs the API. Two more images complete the stack: [`acruxcore/worker`](https://hub.docker.com/r/acruxcore/worker) and [`acruxcore/web`](https://hub.docker.com/r/acruxcore/web).

## Run the whole stack

One Compose file starts Postgres, Redis, the API, the worker and the dashboard. You do not need to clone the repository.

```bash
curl -O https://raw.githubusercontent.com/AcruxCore/AcruxCore/main/docker-compose.local.yml
docker compose -f docker-compose.local.yml up
```

Open http://localhost:8080 and sign up. Email is turned off in this file, so a new account is verified at once.

Every secret in this file has a fixed default value. Use it on your own machine only.

To move to a newer release, run `docker compose -f docker-compose.local.yml pull` and start the stack again.

## The three images

| Image | What it runs | Port |
|---|---|---|
| `acruxcore/api` | The Express API. It applies pending database migrations each time it starts. | 3001 |
| `acruxcore/worker` | The background jobs: evaluation runs, email and the weekly digest. | none |
| `acruxcore/web` | The dashboard, served by nginx. nginx forwards `/api/` to a host named `api` on port 3001. | 80 |

The `web` image depends on that host name, so name the API service `api` in your own Compose file.

## Tags

- `latest` is the release that runs on acruxcore.com today.
- `sha-<commit>` is the build of one commit. Use it to pin a version.

All images are `linux/amd64`.

## Production setup

For a server, bring your own Postgres and set real secrets. The API needs at least these variables:

| Variable | Value |
|---|---|
| `DATABASE_URL` | Postgres connection string the API uses at runtime |
| `DIRECT_URL` | Direct Postgres connection string for migrations |
| `REDIS_URL` | Redis connection string, shared with the worker |
| `GATEWAY_ENCRYPTION_KEY` | Output of `openssl rand -base64 32`. It encrypts provider API keys. |
| `BETTER_AUTH_SECRET` | A long random string that signs session cookies |
| `EMAIL_UNSUBSCRIBE_SECRET` | A long random string that signs unsubscribe links |
| `APP_URL` | The public URL of the dashboard |

The full list, with email settings, is in [`.env.docker.example`](https://github.com/AcruxCore/AcruxCore/blob/main/.env.docker.example). The [self-hosting section of the README](https://github.com/AcruxCore/AcruxCore#-self-hosting) describes the production Compose file.

## Links

- [AcruxCore website](https://acruxcore.com)
- [Quickstart: your first traced LLM call through the gateway](https://docs.acruxcore.com/docs/getting-started/quickstart)
- [Source code on GitHub](https://github.com/AcruxCore/AcruxCore) (Apache 2.0)
