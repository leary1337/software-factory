# Agent Composition and Runtime Compatibility

**Kind:** contract
**Design state:** approved
**Delivery:** shipped
**Arrived:** 2026-08-01
**Shipped:** before this record; live contract salvaged in v0.13.2
**Current truth:** `src/registry/schema.ts`, `src/registry/runtime-availability.ts`, `src/registry/builtins/`, `src/runs/spawn/dispatch.ts`, `src/runs/seed.ts`, and `src/runtime/adapters/`

This record describes the agent envelope, its composition into a run, and
compatibility with retired Pi executions. It replaces the original Pi
execution contract preserved during SPEC retirement (`pl-1717`,
`warren-ff89`). Factory redesign ticket 06 retires Pi execution while
preserving historical definitions and events.

## The four sides of an agent

| Side | Where it lives | Owner |
|---|---|---|
| Mind: persona and instructions | inline built-ins in `src/registry/builtins/`, frozen onto each run | agent registry |
| Memory: expertise | `.mulch/expertise/<domain>.jsonl`, when enabled for the project | mulch |
| Worklist: tasks | the project's issue tracker | tracker integration |
| Body: execution loop and tools | Codex or Claude Code adapter | runtime provider |

Warren owns the workspace, process lifecycle, events and Git delivery. Its
runtime provider consumes a neutral `RunSpec`; the selected adapter owns
the harness command and event parser. Warren does not call an external
Burrow daemon or require an external agent library. See
[runtime and supervisor](./runtime-and-supervisor.md) and
[Codex runtime](../codex-runtime.md).

## Agent definition

`src/registry/schema.ts` defines `AgentDefinition` as
`{ name, version, sections, resolvedFrom, frontmatter }`. Only the
`system` section is required. A minimal definition looks like:

```yaml
name: refactor-bot
version: 1
sections:
  system: |
    Prefer small, reviewable diffs and verify the requested behavior.
  expertise_seed: |
    {"type":"convention","domain":"refactor","content":"..."}
  workflow: |
    template: refactor
resolvedFrom: []
frontmatter:
  runtime: codex
```

The open sections bag also accepts `skills` and `burrow_config`. The
latter retains its historical name for runtime settings. Section presence
alone does not promise a harness capability; its consumer defines the
behavior.

Well-known frontmatter fields include:

- `runtime`: the execution harness. New definitions without an explicit
  runtime use `DEFAULT_RUNTIME_ID`, currently `codex`. Claude Code remains
  an executable adapter. Historical `pi` values remain valid to decode,
  but are refused for new work.
- `provider`, `model`: optional values resolved through per-run overrides,
  project defaults and the definition. The adapter determines the supported
  authentication and model behavior.
- `auto_plan_run`, `auto_plan_run_agent`: request automatic plan dispatch
  after a successful run and optionally select its child agent.
- `noCommits`: marks work that intentionally leaves the branch unchanged,
  such as the built-in reviewer.
- `tools`: a normalized legacy policy bag retained in stored definitions.
  Its former Pi flag translation has been removed; this field does not
  enforce tool restrictions in Codex or Claude Code.

`POST /runs` accepts `providerOverride` and `modelOverride`. The composer
resolves these before freezing the run's definition; it never updates the
cached registry definition with a per-run override.

## Composition flow

1. Resolve the saved agent and project, refresh the project checkout when
   needed, and load project defaults. Resolve capability-gated prompt
   fragments and provider/model overrides.
2. Resolve the effective runtime, including the planner runtime override.
   `readRunnableRuntimeId` refuses retired Pi definitions and Pi overrides
   before creating a run row or calling the runtime provider. A different
   runtime override does not reinterpret a saved Pi definition as another
   harness.
3. Freeze the effective runtime explicitly into
   `rendered_agent_json.frontmatter.runtime`. This includes an implicit
   Codex default and a project runtime override, so subsequent readers
   never need to infer the runtime from today's defaults. The frozen
   definition remains the run's identity throughout its lifetime.
4. Build workspace seed files before creating the row. `buildSeedFiles`
   emits `.warren/agent.json`, optional `.mulch/expertise/<domain>.jsonl`,
   and optional `.seeds/workflow.txt`. Expertise JSONL is validated before
   execution. Pi artifact sections are not materialized.
5. Create the run row, record dispatch context, compose the neutral
   `RunSpec`, and call `RuntimeProvider.create`. The provider owns
   workspace materialization and workload startup; failures are recorded
   through the dispatch rollback path.
6. Persist runtime events and expose them through Warren's event API.
   Steering, cancellation and finalization use the runtime provider seam.
   Reap owns Git delivery and project-specific tracker/memory effects.

The worklist belongs to the project. Changing the selected agent does not
create a separate project queue.

## Retired Pi compatibility

Pi is absent from `BUILTIN_AGENTS` and the executable list returned by
`allAdapters()`. Its binary installation, spawn command, steering/session
helpers, provider credential passthrough and CLI option types are removed.
The remaining `src/runtime/adapters/pi.ts` is a read-only decoder and
metadata record. It cannot spawn a process.

`GET /agents` excludes saved Pi definitions from executable choices.
`GET /agents/:name` still returns the original saved definition for
inspection. Existing rows, runtime IDs, outcomes and logs are not renamed,
rewritten or deleted.

Historical definitions may contain `pi_skills`, `pi_prompts` and
`pi_extensions`. These remain readable in the envelope, but seeding does
not create `.pi/skills`, `.pi/prompts` or `.pi/extensions` files. Historic
`.pi/sessions/` workspace state remains recognized by the scratch and
commit-exclusion classifiers.

`src/core/wire-runtime.ts` retains `pi` in the known wire vocabulary.
`HISTORICAL_DEFAULT_RUNTIME_ID` stays `pi` for old stored envelopes that
omitted a runtime; analytics must use that fallback, not the new-work
Codex default. New runs pin their effective runtime explicitly.

The Pi parser and golden event fixtures, tool/usage readers, terminal
error envelope classification and UI event interpretation remain in place
for historical data. Relevant regression coverage lives in
`src/runtime/adapters/parsers/`, `src/registry/runtime-availability.test.ts`,
`src/runs/analytics/tool-call-extract.test.ts`,
`src/runs/tool-calls-backfill.test.ts` and the run-detail phase tests.
