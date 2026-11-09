---
name: go-best-practices
description: Rules for writing Go in factory projects. Use when creating or editing .go files.
---

Write Go a maintainer can read top to bottom, and leave it passing the checks below.

## Errors

- Wrap with context at each boundary: `fmt.Errorf("load user %d: %w", id, err)`.
- Compare with `errors.Is` and `errors.As`.
- Handle each error once: return it or log it.

## Concurrency

- Pass `context.Context` as the first parameter of anything that does I/O or blocks, and honour its cancellation.
- Give every goroutine a known owner and exit path, using `errgroup` when goroutines can fail.
- Guard shared state with one mutex or one owning goroutine, and name which.

## Design

- Define interfaces where they are consumed, with the fewest methods the consumer needs.
- Return concrete types.
- Inject dependencies through constructors, so package-level state stays limited to constants.
- Name packages for what they provide; `util`, `common` and `helpers` hide that.

## Tests

- Use table-driven tests with `t.Run`, and `t.Parallel` when cases share nothing.
- Test through the exported API, in a `_test` package when practical.
- Use `httptest` and real temp dirs (`t.TempDir`) over mocks of things you own.

## Done

`gofmt -l .` prints nothing, and these pass: `go vet ./...`, `go test -race ./...`, and `golangci-lint run` when the project has a config for it.
