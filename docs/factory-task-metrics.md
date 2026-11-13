# Task metrics

The operator response from `GET /plan-runs/:id` includes `children[].metrics`.
It measures a whole task, including implementation retries, code review, UI
review, rework and delivery. Spectator responses omit these metrics.

The loader follows persisted run and coordinator links from the child's current
implementation run. It does not group every run with the same issue ID: a later
independent attempt belongs to its own plan. Duplicate links and cycles count a
run once. Missing or cross-project links set `incomplete`; traversal is bounded
to 500 linked runs and reports incompleteness if more remain.

| Field | Meaning |
| --- | --- |
| `runCount`, `missingRunCount` | Observed runs and unresolved links |
| `costUsd`, `costUnknownRuns` | Sum of known costs and count without a usable cost |
| `subscriptionEstimateRuns` | Runs whose dollars are API-equivalent subscription estimates |
| `totalTokens`, `tokenUnknownRuns` | Sum of complete input/output/cache-read/cache-write measurements and missing-run count |
| `activeMs`, `durationUnknownRuns` | Sum of execution intervals and count without a usable interval |
| `elapsedMs` | Wall time since first dispatch, ending at task termination or the current response time |
| `deliveryMs` | Wall time to completed delivery, including configured production verification; null until completed |
| `reviewCount`, `uiReviewCount`, `reworkCount` | Distinct runs in each review role |
| `firstPass` | Final review passed without CHANGES, rework or repeated review; null while unknown |
| `steeringCount`, `resumeCount` | Recorded steering messages and explicit plan resumes |
| `escalationCount` | Distinct recorded requests for owner attention |
| `postMergeIncidentCount` | Recorded factory deployment incidents |

Zero known costs or tokens are real zero measurements. When no measurements are
known, totals are null. When some are known, totals are partial and must be shown
with their unknown counts. A subscription estimate is not a payment, quota
balance or hard spending limit. Cached input is already separate from uncached
input in Warren's persisted token buckets and is counted once.

The task cards and plan screens display these whole-task costs for the current
attempt. A plan total adds its children's metrics; it never adds just the current
implementation runs. Earlier plan attempts remain separate. Task details show
the current implementation's cost as an included portion, not a second total.
Missing metrics display as unknown, and incomplete totals retain a visible
unknown remainder. A complete empty run lineage costs zero for this attempt;
missing run links do not. Cost details distinguish subscription estimates from
charges, and the implementation run limit is displayed separately from observed cost.

Task cards and task details also compare independent attempts of the same tracker
task in the same project. The selected attempt is included once in the loaded
subtotal. Task details load project history in batches of 12 plans; additional
plans can be loaded explicitly. Errors and unloaded history limit that subtotal:
it is not presented as an all-time total. A plan's own total continues to cover
only that plan attempt and all its tasks.

All displayed totals add the original task measurements before formatting.
For example, 8.5644 + 2.8644 is displayed as 11.43, while the two individually
formatted rows show 8.56 and 2.86. The expandable cost calculation shows six
decimal places and explains the 0.01 display difference. It is not another
charge. Unknown measurements remain outside the known sum and retain their
unknown remainder. Subscription equivalents remain estimates.

Active time sums run execution time, so concurrent runs can exceed elapsed wall
time. It includes a running run up to the response timestamp; queued runs have
no known execution interval. Delivery duration is not populated for skipped or
failed tasks. A terminal row missing its end timestamp remains unknown.

Escalation is not proof that the owner acted. Steering and resume are the only
owner actions counted here. Manual commits, manual merges, time spent reading a
PR, external defect reports and manual rollbacks cannot be inferred from these
events. Deployment incidents cover only the delivery verifier's observations.
Historical runs without learning events cannot provide a complete escalation
history; the counters describe recorded observations, not all possible actions.
