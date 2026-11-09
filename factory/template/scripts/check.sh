#!/usr/bin/env bash
# The project's quality gate.
set -euo pipefail
cd "$(dirname "$0")/.."

unformatted="$(gofmt -l cmd internal web/*.go)"
if [ -n "$unformatted" ]; then
  echo "gofmt needed:" "$unformatted" >&2
  exit 1
fi
go vet ./...
golangci-lint run ./...
go test -race ./...

cd web
bun install --frozen-lockfile
bunx biome check --error-on-warnings .
bunx tsc --noEmit
bun run test
bun run build
