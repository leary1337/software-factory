# Acceptance evidence

The factory can link ticket acceptance criteria to commands approved in the
pull request's target branch. The runtime executes these commands after the
independent quality gate in its disposable, credential-free checkout of the
reviewed SHA. The reviewer cannot manufacture this receipt by writing PASS.

The reviewer marks the runtime-owned full gate as `RUNTIME_GATE: DEFERRED`.
Only a matching host receipt promotes it to `VERIFIED`. Other skipped checks
remain under `Not run:` and continue to block PASS. If a reviewer finishes
cleanly with pinned `CHANGES` and a verification command exits nonzero after
safe cleanup, the host preserves its findings in `review.check_failed`. An
acceptance failure retains the independently successful full-gate result. The
run remains failed, while the task proceeds to rework. Cancellation, model
crashes, timeouts, lost runs and invalid acceptance artifacts do not qualify for
this receipt. Harness output cannot write the reserved quality-gate, acceptance
or review evidence events.

Configure the checks in `.warren/config.yaml` on the base branch:

```yaml
qualityGate: ./scripts/check.sh
acceptance:
  enforce: true
  requireBrowser: true
  checks:
    - id: login
      command: ./verification/login.sh
      browser: true
      artifacts:
        - acceptance-output/login-report.json
        - acceptance-output/login.png
```

The ticket names approved checks, rather than supplying executable commands:

```markdown
## Acceptance criteria
- [ ] [check: login] A member signs in and reaches their dashboard.
- [ ] [check: login] Invalid credentials show an accessible error.
```

`Критерии приёмки` is also accepted as the section heading. Each unique check
runs once per review, even when several criteria refer to it. A criterion with
no mapping, or with an unknown check id, is explicitly `NOT_RUN`. The runtime
does not infer test coverage from a criterion's wording. At most 50 criteria
are evaluated; excess criteria produce an explicit unverified row.

`enforce: true` requires at least one criterion and a successful receipt for
every criterion. `requireBrowser: true` additionally runs the configured
browser checks on every review and requires a successful browser receipt. An
approved command's nonzero exit, timeout, cancellation, changed source or
invalid artifact fails verification even without `enforce`. Without an
acceptance block, legacy reviews continue and unmapped criteria remain visibly
unverified. Docker acceptance is not supported by this local-runtime feature.

The full gate and acceptance checks share one timeout budget. Gate dependencies
are available to acceptance commands, but the agent's workspace, credentials and
caches are not. Checks must wait for their browser/test processes to finish.
The `browser` flag identifies a command the operator has approved as a browser
test; it does not make arbitrary shell commands into browser tests. Assertions,
viewport coverage and application-specific meaning remain the project's job.

Artifacts must be newly created regular files inside the verification checkout,
without symlinks, and each must be at most 256 KiB. Supported contents are UTF-8
text (including JSON reports) and PNG images. Existing artifacts are refused so
a committed screenshot or output from an earlier command cannot count as fresh
evidence. The combined event is bounded to 1 MB; larger evidence fails closed.
Configure small, focused screenshots and summaries. Do not include credentials
or private customer records in reports or screenshots.

The runtime persists the artifact bytes, SHA-256, relative path, actual exit
code, command and reviewed commit in `acceptance.completed`. They survive
checkout cleanup. Operator review summaries expose these as `acceptance.criteria`
with `PASS`, `FAIL` or `NOT_RUN`, and retain the reason for a failed check. The
evidence is not a claim that every product requirement has been tested.

The factory reads policy from a fresh remote snapshot of the actual PR target
branch. Standalone reviewer runs use the project's default branch. The config
file is protected from automatic merge; literal local scripts referenced by
acceptance commands join the protected paths. Indirect scripts, application
test helpers and semantic coverage still require explicit project protection
and code review, as described in [merge safety](factory-merge-safety.md).
