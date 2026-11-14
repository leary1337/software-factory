# Docker execution retired

Factory task execution uses the local runtime. `WARREN_RUNTIME=docker` now
fails with a migration hint rather than launching a container or silently
changing the backend. The old factory images, Compose setup and container
entrypoint commands have been removed.

Follow [the local Codex runtime guide](../codex-runtime.md) for the current
setup. This retirement applies to the factory runtime, not to application
projects: an approved application release may still build and deploy Docker
containers.

Existing run records, backend identifiers and historical logs are retained.
Common finalization and salvage live under `src/runtime/finalization/`.
