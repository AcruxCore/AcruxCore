# AcruxCore worker

[AcruxCore](https://acruxcore.com) is an open-source platform for LLM apps. It has a prompt registry, an AI gateway, tracing, a tool catalog and evaluation. This image runs the background jobs: evaluation runs, outbound email and the weekly usage digest.

The worker reads its jobs from the same Redis and Postgres as [`acruxcore/api`](https://hub.docker.com/r/acruxcore/api). Without a worker, evaluation runs stay queued and no email is sent.

## Run the whole stack

```bash
curl -O https://raw.githubusercontent.com/AcruxCore/AcruxCore/main/docker-compose.local.yml
docker compose -f docker-compose.local.yml up
```

Open http://localhost:8080 and sign up. The [`acruxcore/api` page](https://hub.docker.com/r/acruxcore/api) lists the tags and the variables a production setup needs.

The worker needs the same `DATABASE_URL`, `REDIS_URL`, `GATEWAY_ENCRYPTION_KEY` and email settings as the API. If the two use different email settings, the API queues mail that the worker cannot send.

## Links

- [AcruxCore website](https://acruxcore.com)
- [Quickstart: your first traced LLM call through the gateway](https://docs.acruxcore.com/docs/getting-started/quickstart)
- [Source code on GitHub](https://github.com/AcruxCore/AcruxCore) (Apache 2.0)
