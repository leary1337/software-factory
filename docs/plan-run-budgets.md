# Task and plan budgets

Projects can opt into aggregate admission limits in `.warren/config.yaml`:

```yaml
planRunBudget:
  task:
    maxRuns: 8
    maxActiveMs: 7200000
  plan:
    maxRuns: 30
    maxActiveMs: 21600000
```

Every number is positive; omit a limit to leave that resource unbounded.
`maxRuns` includes implementation, code review, UI review, rework and linked
retries. `maxActiveMs` sums their execution intervals, including runtime-owned
checks, rather than time waiting for a human or a merge.

Before each coordinator dispatch, Warren checks both the child task and the
whole plan. Reaching a limit stops the next dispatch. The current run is not
cancelled by this admission check and can exceed the remaining time;
its normal runtime timeout still applies. Missing duration blocks admission when its
limit is configured; missing run history blocks any configured budget. Unknown
usage is never treated as free work.

The usage comes from persisted runs and their review/retry links. Restarting
Warren or resuming the same plan does not reset it. A newly created plan is a
new budget scope. Failed pre-runtime run records still count as attempts.

The first configured dispatch activates the budget policy for the plan. From
then on, each dispatch reads approved limits from a fresh snapshot of the
project's default branch, even if an agent changed or removed the configuration
in a shared checkout. The accepted policy and refusal are recorded in system
events. Identical refusals are deduplicated. No database migration is required.

An exhausted plan stays available while dispatch is paused. To continue it,
inspect its usage, explicitly raise or remove the relevant limit on the approved
default branch, and refresh the project. The next coordinator attempt uses the
new limits with all previous usage retained. An unavailable or invalid approved
configuration cannot authorize another run.

Operator responses from `GET /plan-runs/:id` include `children[].budget` with
task/plan limits and usage, the next-dispatch decision and recovery action.
`blocked` means the next dispatch would be refused. `awaitingDispatch` means the
coordinator has actually encountered that refusal and no later admission cleared
it. A running task can therefore reach its next-dispatch limit without being
misrepresented as already stopped. Spectator responses omit the budget field.
