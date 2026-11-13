# Post-run quality gate

**Kind:** historical-evidence
**Design state:** superseded
**Delivery:** not-in-core
**Arrived:** 2026-11-13

[PR #1](https://github.com/leary1337/software-factory/pull/1) proposed moving
the project's quality gate into Warren. Its design ran the command in the
agent's workspace after the implementer and each rework, before releasing
the agent's terminal event. The coordinator would send a failing result to
rework and brief the reviewer on a passing result.

The shipped [independent quality gate](../factory-merge-safety.md#independent-gate-execution)
runs after review. Warren reads the approved command from the target branch
and runs it in a fresh sandbox checkout of the pinned PR commit. It records
the process result and verifies that tracked files stayed unchanged. The
reviewer's verdict and the runtime witness both gate automated delivery.
The implementer and rework continue to run their configured checks.
