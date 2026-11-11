# Review and rework

The factory retains each reviewer's reproducing test in the run event log before
the review workspace is removed. Rework receives the complete source and command,
including the original tests from earlier rounds. A path to a temporary file is
not a transferable reproduction.

The reviewer writes a versioned JSON manifest in its private HOME. Each finding
has a stable ID, a description, a command and bounded source files. The runtime
captures these bytes, installs the project's dependencies through the configured
quality gate, and executes the reproductions against the pinned commit in the
independent gate sandbox. These commands receive the gate's isolated environment,
without model credentials. The harness cannot emit the runtime's evidence events.

A nonzero gate exit still permits reproduction replay in the verified checkout.
Pinned CHANGES from a clean model exit can request rework when those reproductions
confirm the defect. The run retains its failure status and reported usage; it is
never promoted to PASS. Crashes, cancellation and unverifiable checks remain stops.

A failing assertion exits 1; a passing regression exits 0. Timeout, cancellation,
missing evidence, an unexpected exit code or source mutation cannot close a
finding. Original sources are retained and replayed on subsequent commits. A
renamed finding cannot hide an old one, and a reworker's success message is not
closure evidence. The independent test proves only its assertions; the cold
review and the full project gate remain necessary.

After a rework, the factory continues when at least one previously failing test
passes and no previously passing reproduction regresses. New findings can start
another round, including a third or later rework. If none close, it stops with
`no_progress`; a regression stops with `regression`. A final PASS also requires
all retained reproductions and the independent quality gate to pass on the
reviewed head. UI review still runs separately when enabled.

The operator can bound this loop with environment variables:

| Variable | Default | Meaning |
|---|---:|---|
| `WARREN_REWORK_MAX_ROUNDS` | 8 | Rework runs for this task, including previous attempts |
| `WARREN_REWORK_MAX_STEPS` | 24 | Review, UI review and rework dispatches combined |
| `WARREN_REWORK_MAX_COST_USD` | 10 | Cumulative reported cost of those steps |
| `WARREN_REWORK_MAX_ACTIVE_MS` | 7200000 | Sum of their recorded execution durations |

These limits govern admission of the next step. The remaining cost also bounds
the next run's configured cap. With subscription-backed Codex, cost is an estimate
reported after the model turn, so a running step can exceed the remaining amount.
Unknown cost or duration stops admission rather than treating usage as free.
Other project, plan and runtime limits still apply. Restarting the server does
not reset usage or the finding history.

A legacy loop that stopped with CHANGES can obtain one fresh review using this
protocol, within the same budget. It keeps its old attempts and cost. Missing
historical temporary files are not claimed to have been recovered: the fresh
review must produce portable reproductions. Changing the PR head triggers a new
review; unchanged exhausted loops remain stopped.
This also covers an interrupted rework: after its recovered fixes are pushed,
the new head is compared with the last review pin and reviewed within the
remaining budget. A failed rework with an unchanged head stays stopped.
Each completed review has its own comment delivery key. Delivery retries are
deduplicated, while a later review publishes its current verdict on the PR.

The independent replay is implemented for the local runtime. Other providers
without the runtime evidence cannot satisfy this protocol. Infrastructure or
unreproducible review failures require operator attention, with no automatic
claim that the underlying finding was fixed.
