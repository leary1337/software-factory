# Operations and observability

Warren exposes enough operational state to run a single-box or cluster deployment without a required observability stack. This page covers the common surface. The [Kubernetes runbook](RUNBOOK-K8S.md) adds pod-specific procedures.

## Probes

`GET /healthz` is an auth-free liveness probe. It returns a cheap `{ok: true}` response and is suitable for a container or load-balancer health check.

`GET /readyz` requires the operator bearer token. It checks the database, registered agents, project configuration, and the selected runtime. Use it during deployment and diagnosis rather than on every request.

`GET /version` reports the running warren version. Release automation uses it to prove that a rollout replaced the image.

## Structured logs

Warren writes one Pino JSON object per line to stdout. `WARREN_LOG_LEVEL` selects the minimum level and defaults to `info`.

```bash
docker compose logs -f warren | jq
kubectl -n warren logs deploy/warren | jq
```

Configure retention in the container runtime, cluster logger, or an external Pino transport. The shipped Compose file rotates its `json-file` logs.

## Request IDs

Every HTTP response includes `X-Request-ID`. Warren accepts a valid incoming ID or creates one, then binds it to the request logger. Forward the header through a reverse proxy so one value traces the request across the edge and server logs.

```bash
jq 'select(.req_id == "<request-id>")' warren.log
```

## Metrics

`GET /metrics` is bearer-gated and uses Prometheus exposition format. It reports run counts, tokens, event-stream state, and runtime-specific gauges. Kubernetes deployments also expose pod lifecycle metrics.

Use the endpoint for alerting on admission rejection, runtime loss, finalization failure, and growing queue depth. The [Kubernetes runbook](RUNBOOK-K8S.md#6-observability) lists its provider-specific metrics and alert signals.

## Tokens

Each run records input, output and cache token totals when its harness supplies
usage events. Run details and analytics expose these observations. Warren does
not price token usage or enforce monetary limits.

## Run events

`GET /runs/:id/events` returns the persisted NDJSON stream. A request follows a non-terminal run by default. Use `?follow=0` for replay, `?since=<seq>` for cursor paging, or `?limit=N` for a bounded read.

The event store is the core run record. The optional audit-log extension consumes this surface and exports a separate append-only projection. The optional judge extension stores its verdicts outside the warren database. Neither extension is part of a base installation.

## Pre-flight checks

Run the deployment-side doctor from the server environment:

```bash
warren doctor --local
```

It checks environment and runtime prerequisites that are cheaper to diagnose before a dispatch. The client-side form checks reachability, authentication, and version compatibility:

```bash
warren doctor --url https://warren.example.com
```

## Backups

The local default stores runtime state in `/data/warren.db`. The same data root also contains managed clones and runtime workspaces. Back up the database and project configuration. Treat active workspaces as recoverable run state rather than the sole copy of source changes.

Postgres deployments set `WARREN_DB_URL`. Back up that database with the operator's normal Postgres procedure. Agent pods and containers do not receive the database credential.

## Common triage order

1. Check `/healthz` and `/version`.
2. Check authenticated `/readyz`.
3. Read the run row and its bounded event tail.
4. Filter server logs by request or run ID.
5. Inspect the selected runtime: local process, sibling container, or Kubernetes pod.
6. Confirm the forge credential can fetch and push the target repository.
7. Confirm the configured admission limits did not reject or cancel the run.

Use [Docker self-hosting](self-host/docker.md) or the [Kubernetes runbook](RUNBOOK-K8S.md) for topology-specific remedies.
