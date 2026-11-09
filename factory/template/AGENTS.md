# __PROJECT__

Go API in `cmd/` and `internal/`, React app in `web/`.

## Run

- API: `go run ./cmd/server` (port 8000, `PORT` overrides it).
- Web: `cd web && bun install && bun run dev`. Vite proxies `/api` to the API.
- One binary: `cd web && bun run build`, then `go build -tags embed -o bin/server ./cmd/server`.

## Conventions

- `scripts/check.sh` is the quality gate.
- UI controls come from `web/src/components/ui`, in the shadcn/ui style.
