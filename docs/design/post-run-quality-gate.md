# Post-run quality gate

**Kind:** contract
**Design state:** approved
**Delivery:** shipped
**Arrived:** 2026-11-10
**Shipped:** v0.19.3
**Current truth:** `src/runtime/local/post-run-gate.ts`, `src/plan-runs/review.ts`,
and `src/core/quality-gate.ts`

Warren runs the project's quality gate itself, as a deterministic step with
no model in it. The gate runs in the run's own sandbox right after the agent
exits. Its result is a run event. The plan-run review step reads that event
to pick the next step, and the reviewer gets it in its prompt.

## Why

Before this record, each LLM role in the plan-run chain ran the gate on its
own: the implementer, then the reviewer, then each rework. The evidence is
`run_ppcz40v8nd70` (a Next.js project, gate = `pnpm install` + `next build` +
smoke). The code was ready after 1.5 minutes. The agents then spent about 33
minutes on the gate, because each of them ran it again on the same code. The
implementer also committed with a red gate, because nothing made a red gate
stop the chain.

A gate is a command with an exit code. A model adds nothing to it. So warren
runs the command, records the facts, and acts on them.

## The contract

### Which runs get the gate

Two facts arm the gate for a run. Both must be present:

1. The agent's frontmatter says `qualityGate: warren`. The builtin
   `implementer` and `rework` roles declare it
   (`src/registry/builtins/factory-roles.ts`). The `reviewer` does not,
   because it commits nothing.
2. The project configured a gate command: `.warren/config.yaml`
   `qualityGate`, which dispatch puts in the run env as
   `WARREN_QUALITY_GATE`.

When either fact is missing, the run behaves exactly as before, and the
agent prompts tell the agent to run the gate through the usual
resolution chain.

### Where it runs

The local drive loop (`src/runtime/local/drive.ts`) owns the step. The
local and docker providers share that loop, so both get the gate.

- The gate runs only after the agent finished cleanly: exit 0, no cancel,
  no OOM kill, no stream error, and a terminal envelope that reports no
  error.
- The gate spawns through the same sandbox seam as the agent
  (`runSandboxed`, or the docker spawn seam), with the same profile and
  command env. It sees the same workspace, network policy, proxy, and
  toolchain. Dependencies the agent installed are still there.
- The gate never runs on the host. This follows the project rule that
  warren never runs repository scripts on the host.
- The command is `sh -c <qualityGate>`. A short wrapper prints
  `git rev-parse HEAD` first, so the result names the commit it judged.

### How the run waits for it

The domain reaps a run when it sees the agent's terminal envelope
(`result` or `agent_end`). While the gate is armed, the drive loop holds
those envelopes back. It appends them only after the gate's finished
event. So the bridge keeps reading during the gate, and reap starts only
when the gate is done. The run stays `running` for the duration of the
gate.

The gate has a time limit of 30 minutes (`POST_RUN_GATE_TIMEOUT_MS`).
This is less than the watchdog's 45-minute heartbeat. The started event
re-anchors that heartbeat. At the limit, warren kills the gate and
records `timedOut: true`.

A cancel during the gate kills the gate process (`record.proc` points at
it while it runs) and settles the run as `cancelled`.

### The event

The gate appends two events of kind `quality_gate` on the `system` stream.
`src/core/quality-gate.ts` holds the shape and the reader.

```json
{ "type": "quality_gate", "phase": "started", "command": "pnpm check" }
{ "type": "quality_gate", "phase": "finished", "command": "pnpm check",
  "exitCode": 1, "timedOut": false, "durationMs": 412000,
  "sha": "3f2c…", "logTail": "…last 6000 bytes of stdout + stderr…" }
```

`error` is present instead of a verdict when warren could not start the
command. The run's own outcome stays the agent's: a red gate does not fail
the run. Reap pushes the commits as usual, and the PR opens.

Green means `exitCode === 0`, no timeout, and no `error`. A timeout counts
as red. A start error is neither green nor red.

### What the review step does with it

`src/plan-runs/review.ts` reads the newest `quality_gate` event of a run
through `EventsRepo.latestOfKind`. A fixed-size tail is not enough,
because reap's bookkeeping events land after the gate.

After each code-changing step (the implementer, then each rework), the
step's own gate decides:

| Gate after the step | Next step |
|---|---|
| red (exit ≠ 0 or timeout) | `rework` at once, with the command, the exit, the commit, and the log tail as findings. No reviewer runs. |
| red, and the reworks are used up | finish as `changes_left`, with the gate failure as the report |
| green | `reviewer`, with the gate result in its prompt |
| start error, or no gate recorded | `reviewer`, told to run the gate itself |

A red-gate rework counts against `MAX_REWORKS`, the same as a
review-driven one. The `plan_run.review_step` event of a rework carries
`cause: "gate" | "review"`.

### The reviewer does not run the gate again

The reviewer's prompt names the command, the commit, and the duration of
the green run. Reap adds bookkeeping commits (`.seeds/`, `.mulch/`) after
the gate, so `HEAD` on the PR branch is not the gate's commit. The prompt
therefore gives the reviewer an exact check:

```bash
git diff --quiet <sha> HEAD -- . ':(exclude).seeds' ':(exclude).mulch'
```

Exit 0 means the code is the code the gate judged, and the reviewer does
not run the gate. Any other result, or an unknown commit, means the
reviewer runs the gate as before.

## Boundaries

- Warren does not commit what the gate writes. A gate that changes tracked
  files leaves them uncommitted, and reap pushes the agent's commits only.
- The gate runs once per code-changing run, also when the run changed
  nothing. The review step does not compare commits across runs.
- A standalone `implementer` run, outside a plan-run, also gets the gate.
  Its result is a run event only. Nothing acts on it.
- The retired k8s in-pod entrypoint (`src/runtime/container/`) has no gate
  step.
