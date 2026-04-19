# Observability

## Purpose

This document defines local and development observability for zmail.

## Runtime Surface

zmail keeps Pino JSON logs as the canonical log format. By default logs go to
stdout only. A local file sink can be enabled for Loki ingestion:

```bash
mise run dev:obs
```

The Prometheus metrics endpoint is disabled by default. Enable it only on a
local or private bind address. The local observability app task enables it and
the Loki-tailored JSON log file together:

```bash
mise run dev:obs
```

Default routes:

- `GET /healthz`
- `GET /readyz`
- `GET /metrics`, only when metrics are enabled
- `GET /ops/health`, authenticated and restricted to `org_operator` or higher

`/healthz` and `/readyz` are shallow probes and must not read org storage.
`/ops/health` may read active org storage after session and org resolution.

## Configuration

Non-secret defaults live in `zmail.toml`:

```toml
[observability]
metrics_enabled = false
metrics_path = "/metrics"
log_file = ""
otlp_enabled = false
otlp_endpoint = ""
service_instance_id = ""
```

Environment variables override TOML:

```env
ZMAIL_METRICS_ENABLED=false
ZMAIL_METRICS_PATH=/metrics
ZMAIL_LOG_FILE=
ZMAIL_OTLP_ENABLED=false
ZMAIL_OTLP_ENDPOINT=http://127.0.0.1:4318
ZMAIL_SERVICE_INSTANCE_ID=
```

`service_instance_id` defaults to hostname plus process id when unset.

## Local Stack

The local stack lives under `ops/observability` and includes Grafana, Loki,
Prometheus, and Alloy.

Commands:

```bash
mise run obs:up
mise run dev:obs
mise run obs:logs
mise run obs:down
```

Open Grafana at:

```text
http://127.0.0.1:3000
```

Prometheus scrapes `host.docker.internal:56711` at `/metrics`. Alloy tails
`.observability/logs/zmail.ndjson`, parses JSON, applies low-cardinality Loki
labels, and sends logs to Loki.

## Metrics Contract

Allowed metric labels:

- `org_id`
- `account_id`
- `job_kind`
- `scope_type`
- `status`
- `phase`
- `method`
- normalized `route`
- `status_class`

Disallowed metric labels:

- email addresses
- sender addresses
- subject lines
- message bodies or snippets
- raw HTTP paths
- OAuth or provider tokens
- raw exception messages

HTTP metrics must use normalized route labels. Unknown routes collapse to their
first segment with `/*`.

## Progress and ETA

Worker sync jobs write live progress into `jobs.meta_json`. `/runs`, account
detail pages, metrics, and SSE updates consume that shared progress shape.

Backfill ETA is approximate because Gmail UID spans can be sparse. The ETA
model uses `account_sync_state.backfill_snapshot_uid`,
`account_sync_state.backfill_next_uid`, and recent completed backfill job
durations.

## Privacy Rules

Logs and metrics must not include tokens, email addresses, message snippets,
message bodies, or raw RFC822 paths. IDs, counts, status values, durations,
model names, normalized route labels, and sanitized error types are allowed.

OTLP traces are configured but disabled by default. The first local
observability contract uses Prometheus scraping and Loki log tailing.
