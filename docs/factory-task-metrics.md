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
