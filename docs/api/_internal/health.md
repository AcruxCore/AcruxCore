# Health API

> Unauthenticated on purpose — load balancers, Docker `HEALTHCHECK`, and uptime
> monitors have no API key to send.

---

### GET /api/v1/health

Pings Postgres and Redis and reports both. Returns 200 only when both
dependencies respond; 503 with the same shape otherwise, so a failed check is
visible in the body even when a monitor only looks at the status code.

```bash
curl -w '\nHTTP_STATUS:%{http_code}\n' $ACRUXCORE_BASE_URL/health
```

Response (status 200):

```json
{
  "status": "ok",
  "checks": {
    "database": { "status": "ok", "latencyMs": 8 },
    "redis": { "status": "ok", "latencyMs": 12 }
  }
}
```

A degraded dependency reports its own error without failing the other check,
e.g. `"redis": { "status": "error", "latencyMs": 3, "error": "connect ECONNREFUSED" }`.
