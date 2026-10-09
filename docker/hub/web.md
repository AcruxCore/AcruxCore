# AcruxCore dashboard

[AcruxCore](https://acruxcore.com) is an open-source platform for LLM apps. It has a prompt registry, an AI gateway, tracing, a tool catalog and evaluation. This image serves the dashboard with nginx on port 80.

nginx forwards every request under `/api/` to `http://api:3001`. The browser therefore talks to one origin, and the session cookie works without CORS settings. Run [`acruxcore/api`](https://hub.docker.com/r/acruxcore/api) as a service named `api` on the same Docker network.

The image contains no analytics or error-reporting keys. Nothing in it reports to an outside service.

## Run the whole stack

```bash
curl -O https://raw.githubusercontent.com/AcruxCore/AcruxCore/main/docker-compose.local.yml
docker compose -f docker-compose.local.yml up
```

Open http://localhost:8080 and sign up. The [`acruxcore/api` page](https://hub.docker.com/r/acruxcore/api) lists the tags and the variables a production setup needs.

## Links

- [AcruxCore website](https://acruxcore.com)
- [Quickstart: your first traced LLM call through the gateway](https://docs.acruxcore.com/docs/getting-started/quickstart)
- [Source code on GitHub](https://github.com/AcruxCore/AcruxCore) (Apache 2.0)
