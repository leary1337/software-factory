# Unattended projects with real data

The operator can provision non-secret research inputs for a local project under
`WARREN_PROJECT_INPUTS_ROOT/<project-id>/`. Set this environment variable on the
Warren server, outside repository configuration.

Warren resolves only that project's directory and rejects symlinks and special
files. Agents receive its absolute path as `WARREN_PROJECT_INPUTS` and can read it
without receiving server, recovery or delivery credentials.

The same directory survives into the independent verification sandbox.
Other agent mounts, credentials, caches and mutable worktrees remain excluded.

Store immutable archives, their hashes and a short manifest in this directory.
Commands must restore into their disposable workspace before opening writable
database connections or replaying transactions.

The operator chooses the data scope and refresh policy. Missing project inputs
do not grant access to another project's directory or to arbitrary host paths.

Use base-branch `acceptance.checks` to run project-specific commands against the
reviewed commit, and link ticket criteria with `[check: <id>]`.
See [acceptance evidence](acceptance-evidence.md) for receipts and artifact limits.

An owner can delegate conventional protected paths for reviewed plans:

```yaml
pr:
  autoMerge:
    verification: warren
    method: merge
    requiredChecks: [test]
    reviewedPaths: ["scripts/**", "deploy/**", "pyproject.toml"]
```

Only independent reviewed-plan delivery applies `reviewedPaths` from the fetched
base branch. Standalone runs and native forge arming retain the original policy.

Explicit `protectedPaths`, verification commands, structural diff restrictions
and `.warren/config.yaml` remain protected. Review failures and missing or failed
checks still stop delivery, even for delegated paths.

The delegation authorizes merging code, not executing production operations.
Production changes still need the project's actual prerequisites and evidence.

For long restore/replay or training tasks, set `[sandbox] timeout_minutes` in
`burrow.toml`; the Codex adapter default is 20 minutes. Commit working code before
long experiments. Interrupted local work is captured in Warren's recovery bundle.

The forge credential must read both GitHub Checks and commit statuses, in
addition to the repository/PR permissions needed for delivery. A token that can
push branches may still receive 403 for either CI API. Verify those permissions
before starting an unattended plan. After correcting a delivery-only refusal,
retry review: Warren reuses a verified PASS on the same commit and retries
publication. A changed head or missing gate witness requires a fresh review.
