# Repeatable factory pilot

The live pilot is restricted to `leary1337/factory-sandbox`. It complements
deterministic runtime tests; simulated adapters are never counted as live model
evidence. Preserve existing sandbox tickets and branches.

## Run and capture

Start the factory from the source checkout being evaluated, with one automatic
run at a time. Use an isolated data directory and client config for the pilot.
Do not share one ChatGPT auth file between active servers: first drain and stop
the primary instance, retaining its startup command and data directory, then
restore it after the pilot. Never log credentials or commit the client config.

Register `https://github.com/leary1337/factory-sandbox` on that instance and
prepare small test issues in its Seeds tracker. An issue must describe real
behaviour and use approved `[check: id]` acceptance mappings when enabled.

```sh
bun scripts/factory-pilot.ts --project <sandbox-project-id> \
  --issues <test-issue-id> --out test-results/factory-pilot.json
```

The command checks the project's exact repository before dispatch. It records
the source HEAD plus a SHA-256 of tracked and nonignored source files, so a dirty
checkout is identified honestly. It observes for at most 45 minutes by default
(`--timeout` accepts 1–120 minutes). Each HTTP read is bounded. It writes a
portable, owner-readable receipt after each poll, containing run/PR identifiers,
reviewed commits, gate verification, acceptance results and artifact hashes.
Prompts, artifact bytes and credential values are excluded.

Exit 0 means the plan succeeded and source files did not change during
observation. Exit 2 means attention, failure, timeout, or changed source. A timeout
does not cancel the model; inspect the existing receipt and resume observation
instead of dispatching a duplicate:

```sh
bun scripts/factory-pilot.ts --project <sandbox-project-id> \
  --plan <existing-plan-id> --out test-results/factory-pilot-followup.json
```

Keep the pre-merge receipt as well as the post-merge receipt. The final plan state
alone cannot distinguish factory auto-merge from an explicitly authorized manual
merge. Record the merge actor and method in the pilot notes.

## Cases and evidence

| Case | Required evidence |
|---|---|
| Backend change | Real implementer and cold reviewer runs; independent gate on the reviewed SHA; PR result |
| UI change | Real rendered app check, fresh browser report/screenshot from runtime acceptance; phone and desktop |
| Rework | Proven blocking finding, rework on the same branch, a fresh review and gate on the new SHA |
| Cancellation/restart | Only a pilot job is interrupted; no next ticket runs; saved work and recovery result are inspected |
| Merge safety | Base advance or missing branch protection refuses automatic merge with the precise reason |
| Delivery | Actual application deployment at the merged SHA, deployment status, and application smoke response |

Run backend/UI work first. Use intentionally failing acceptance in a dedicated
test case to establish refusal, then repair through a new approved baseline.
Do not count merely changing a reviewer prompt to say CHANGES as a reproduced
defect. Cancellation/restart tests must never interrupt another project's job.

The private sandbox's current GitHub plan may refuse branch protection with
HTTP 403. That is a valid `protection_required` result, not an auto-merge pass.
Do not change repository visibility, upgrade billing or relax the guard as a
test workaround. A separately authorized manual merge can test continuation,
but the report must name it as manual.

The sandbox's original deployment workflow only echoes a line. It is not a
production deployment. Until a real target and smoke URL exist, mark live
delivery as not run and cite deterministic delivery tests separately. A green
workflow that never deploys the app must not count as end-to-end delivery.

Record each pilot's source fingerprint, sandbox base/head SHA, run and PR links,
observed outcomes, owner interventions, elapsed time, and remaining unverified
cases. Live credentials and machine-local receipts remain outside git.
