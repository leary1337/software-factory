# Factory merge safety

Automatic merge is opt-in twice: the factory start preset enables review-driven
merge, and the project's default branch must contain `pr.autoMerge`. A PASS does
not bypass the policy. The factory reads the policy and the diff from a fresh
remote Git snapshot and merges only the reviewed head commit.

## Independent gate execution

Review-driven merge also verifies the target branch. Its fresh remote snapshot
pins both base and head, and proves that the base is an ancestor of the reviewed
head. In that case the independently tested head tree is also the integration
tree. If the base advanced without being incorporated, automatic merge stops
with `stale_base`; update the PR branch and rerun review and the gate. A clean
textual merge alone is not evidence of compatibility.

GitHub's merge API accepts an expected head SHA but no expected base SHA. To
close the base-advance race after the snapshot, Warren requires classic branch
protection with at least one required status check, **Require branches to be up
to date before merging**, and **Do not allow bypassing the above settings**
(`enforce_admins`). The token must be able to read branch protection. Warren
reads the current base again after protection, and GitHub enforces the rule at
merge time. Missing, unreadable, loose or bypassable protection stops with
`protection_required`. Ruleset-only protection and other forges are currently
unverified and require manual merge.

The factory does not create checks or change repository protections. A project
using only local gates must either configure a real required check and these
protections, or keep manual merging. This also applies when the repository's
GitHub plan cannot enable the required protections. Operators must keep branch
protection and the PR target stable during delivery; concurrent administrative
policy removal or retargeting is outside this guarantee. See GitHub's
[strict checks and bypass policy](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches).

Merge refusals preserve a structured reason, next action and relevant paths in
the operator-only plan child's `reviewMerge` result. Permanent refusals stop
after the first attempt. Only classified transient forge failures retry, at most
three times. Unknown exceptions stop without exposing raw transport errors.

After review, the local runtime stops the reviewer process group and creates a
second checkout from the pinned commit in Warren's trusted Git object store.
It does not read the reviewer's Git configuration, index, worktree or dependency
directory. Git preparation disables hooks, fsmonitor, replacement objects and
ambient Git configuration. The gate runs inside the existing sandbox boundary
with fresh HOME and caches, read-only Git metadata and the project's network
policy. It receives no reviewer credentials or callback token.
On macOS, a short per-gate temporary alias keeps Unix socket paths within the
platform limit. It points into the fresh HOME and is removed with the checkout;
the sandbox does not gain access to shared host sockets.

The configured `qualityGate` must bootstrap its own dependencies. For example,
an operator can configure `bun install --frozen-lockfile && bun run check:all --bail`
for a Bun project whose install and check scripts are approved. Package access
must be permitted by that project's sandbox network policy. A gate that assumes
the agent's preinstalled dependencies fails closed; Warren does not run an
installation script on the host or copy the agent's dependency directory.

Warren records the actual process exit code. After stopping the gate process
group, it hashes the tracked source again and refuses a success witness if files
or executable modes changed. This check uses an independent file manifest, not
Git index flags such as `assume-unchanged`. Temporary build outputs and dependency
files may be created in the disposable checkout. A timeout, cancellation,
unavailable commit, source mutation or failed gate blocks automatic merge.

The gate validates the reviewed source using the approved command; it does not
prove that the project's tests cover every requirement. Review and the protected
path policy remain necessary.

## Changes that require an operator

The baseline in `src/runs/reap/auto-merge-risk-paths.ts` always protects conventional
CI, deployment, infrastructure, Docker/Compose, nginx, migration, authentication,
payment and billing paths. It also protects agent instructions, scripts, build
manifests and dependency lockfiles. Setting `protectedPaths: []` keeps this
baseline. Project entries add protection using the existing prefix/glob rules.

Names cannot identify every security-sensitive operation. During onboarding,
inspect where the project implements identity, permissions and payments, and add
its actual paths. For example:

```yaml
pr:
  autoMerge:
    method: squash
    protectedPaths:
      - src/session-service/
      - src/checkout-provider/
      - tools/release-verification/
```

The base configuration's `qualityGate` also protects literal local script paths
it names, including quoted paths. Package manifests and conventional scripts
are already protected. Indirect scripts resolved through variables, generated
commands or other project configuration need explicit project entries. This
path policy complements independent gate execution; it is not a claim that
all tests or every semantic risk are immutable.

The `.warren/config.yaml` policy file is always protected independently of those
lists. A PR cannot weaken the policy that will authorize its own merge.

## Structural diff checks

The snapshot reads NUL-delimited Git path, raw mode and line-count output with
rename detection disabled. This includes both sides of renames and avoids
misreading filenames containing spaces, tabs or newlines.

- Symlink and submodule changes, including deletion or conversion, require
  manual review (`unsupported_file_mode`).
- More than 100 changed files or 3,000 added plus deleted lines require manual
  review (`diff_too_large`). These are conservative implementation defaults,
  not numbers recovered from the original architecture.
- Binary changes require manual review because the line-count gate cannot
  measure their size (`binary_diff`).
- Failed, incomplete or contradictory Git measurements refuse automatic merge
  (`diff_unreadable`).

These checks leave the PR available to the operator. They do not delete changes,
approve a manual merge or trigger a deployment. The policy runs for both the
review coordinator and the inherited auto-merge arming path.
