# Approved plans, bounded work, and recovery

**Kind:** contract
**Design state:** approved
**Delivery:** shipped
**Arrived:** 2026-11-14
**Shipped:** local factory redesign
**Current truth:** `src/plan-runs/approval.ts`, `src/plan-runs/revisions.ts`, `src/plan-runs/task-budget.ts`, `src/plan-runs/effects.ts`

The existing plan coordinator executes an immutable approval. Preparing an approval
saves task descriptions, acceptance criteria, order, dependencies, release boundaries,
execution and review profiles, agent definitions, effective project settings, readiness
evidence, toolkit version, permissions, and budgets. Preparation executes nothing.
Starting the same approval again returns the same queue entry. A command key cannot
be reused with a different request.

The operator reviews `POST /plan-approvals` before calling
`POST /plan-approvals/:id/start`. `GET /plan-runs/:id` includes its saved approval for
operator clients. The legacy `POST /plan-runs` path also captures an approval before
queuing work. Internal plans create a factory-owned Seeds mirror under the data
directory; project repositories need no manually maintained issue files. The database
approval is authoritative and the mirror can be rebuilt.

`POST /plan-runs/:id/revisions` saves a new revision with the owner's decision and the
expected previous revision. Started tasks retain their original description, criteria,
profiles, settings, toolkit, and budgets. Pending tasks can change or be removed; new
tasks can be added. The revision history remains available at
`GET /plan-runs/:id/approval`. Specific new permission grants may authorize a blocked
merge without changing the already executed task's acceptance criteria.

Default task limits are two repairs, three reworks, one hour per run, three hours of
aggregate active time, and one hour of aggregate external waiting. Durable attempt
reservations and run timestamps include preparation, execution, review, and checks.
Each subsequent run receives at most the remaining active allowance. Closed external
wait intervals stop accruing while agent work runs. Restarting does not reset usage.
The existing review evidence protocol must demonstrate a repaired reproduction or
previously failing check; changing a finding's wording is not progress. Approved
plans stop on no progress instead of granting an extra stalled rework.

A process interruption starts a new model session linked to the lost attempt.
Local recovery bundles preserve committed and non-ignored pending Git work. Recovery
verifies and imports the bundle into the project object store before creating the new
workspace. A failed rework resumes as a fresh rework, followed by independent review.
Intentional cancellation never authorizes recovery. After a verified deployment
rollback, a budgeted implementation attempt repairs the original task through this
same review and release chain.

External effects record intent before mutation and retain unknown outcomes. An
unknown merge or deployment must be looked up before another write or dependent
step. PR creation uses a durable intent event and a lookup by repository/head/base;
an unavailable lookup never authorizes a second PR. A reported success is distinct
from confirmed completion.

Ordinary code, dependency, and build edits follow the approved plan automatically.
Access-control paths, changes to factory instructions, and destructive migration
statements require saved grants with a reason and matching path scope. Workflow
permission and migration checks inspect changed lines, not unchanged patch context.
The exact reviewed head and independent gate remain required. This classifier is a
conservative path and patch check; independent review still evaluates the semantics
of the complete change.

Historical plan rows without an approval keep their existing decoders and lifecycle
rules. New launch surfaces always pass through approval creation. Runtime and UI use
the same coordinator and shared core types; there is no separate execution engine.
