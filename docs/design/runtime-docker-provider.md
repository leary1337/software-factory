# Retired Docker runtime compatibility

**Kind:** contract
**Design state:** approved
**Delivery:** shipped
**Arrived:** 2026-08-17
**Shipped:** v0.17.0; execution retired by factory redesign ticket 05
**Current truth:** `src/runtime/registry.ts`, `src/runtime/contract.ts`, `src/runtime/finalization/`, and `src/runtime/container/log-parse.ts`

The factory no longer registers a Docker provider. An explicit
`WARREN_RUNTIME=docker` value fails before workload creation and directs the
operator to the local runtime. It never falls back silently.

The Docker CLI readiness probe, factory images, Compose files, container
entrypoint commands and container execution acceptance mode have been removed.
The local runtime retains workspace lifecycle, recovery, Git delivery and
common finalization through the neutral modules in
`src/runtime/finalization/`.

Historical backend identifiers remain in the data contract; old runs are not
renamed or deleted. The pure legacy log decoder retains timestamp, provenance
and terminal-envelope interpretation, without providing an executable path.

Docker remains a valid deployment tool for an application project when its
approved release plan calls for it. Runtime retirement does not prohibit that
project-level delivery method.

See [local setup](../codex-runtime.md) and
[the runtime-provider contract](./runtime-provider-contract.md).
