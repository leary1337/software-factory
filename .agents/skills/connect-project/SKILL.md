---
name: connect-project
description: Connect an existing repository or a new idea to the software factory.
disable-model-invocation: true
---

Connect one project from the factory checkout. A repository path means existing;
a new idea means new. Use the project path as the working directory for its checks
and documents. Run the connection script from the factory checkout.

Read `factory/skill-pack/owner/README.md` for the pinned owner skills and Codex
invocation mapping. The selected project must be included in the Warren GitHub
token's repository access. A new repository needs that access before registration.

## Existing repository

1. Inspect its instructions and existing checks. Establish one quality gate that
   runs the relevant lint, types and tests. The independent runtime gate starts
   from a fresh checkout and HOME, without reviewer caches or credentials. The
   command must install its declared dependencies and prepare fixtures itself,
   inside the sandbox. Confirm this contract in a disposable clean checkout.
   Reuse a gate already chosen by the
   user. Done when the exact command passes and matches any existing
   `.warren/config.yaml` `qualityGate`. The script rejects a different or missing
   gate in an existing config; edit that setting explicitly in the onboarding PR
   if a change is needed, retaining the other settings.
2. Run `bun --env-file=/dev/null scripts/connect-project.ts existing <path> --gate "<command>"`.
   Done when `factory/connect` contains Seeds, Mulch, Warren config and agent docs.
3. Read `factory/skill-pack/pstack/skills/create-verification-skill/SKILL.md`.
   Follow its repo interview and proof steps using available Codex tools. Its
   Cursor-specific output directory maps to `.agents/skills/verify-<app>/` here.
   Done when launch, doctor, one real feature, evidence and cleanup all work.
4. Use the pinned `domain-modeling` skill in the target repo. Done when
   `GLOSSARY.md` defines the terms the implementation relies on and the relevant
   decisions have ADRs where the skill's criteria apply.
   If the owner wants automatic merge, inspect actual identity, permissions,
   billing and deployment code and add its project-specific `pr.autoMerge`
   protected paths. Follow `docs/factory-merge-safety.md` in the factory checkout;
   the mandatory baseline stays enabled. Otherwise leave auto-merge off.
5. Run the gate in the project. Inspect the entire diff, then run
   `bun --env-file=/dev/null scripts/connect-project.ts finish <path>`.
   Done when the onboarding PR contains the verified configuration and docs.
6. Merge according to the user's authorization and the project's policy. After
   the PR is merged and token access is granted, run
   `bun --env-file=/dev/null scripts/connect-project.ts register <path>`.
   Done when Warren returns the project id; report any remaining access blocker.

## New idea

1. Read the pinned `grill-with-docs` skill, resolving its `grilling` and
   `domain-modeling` references through the owner pack. Done when the user has
   settled the project name, first usable slice and domain language.
2. Run `bun --env-file=/dev/null scripts/connect-project.ts new <name>`; use
   `--dir <parent>` when the user chose a different parent directory. This creates
   and pushes a private repository but leaves registration explicit.
3. In that repo, write the agreed `GLOSSARY.md`. Generate and prove the verification
   skill as in the existing-project steps, run `./scripts/check.sh`, and deliver
   those changes through a PR. Done when the default branch has passing checks,
   the glossary and a working verification recipe.
4. After token access is granted, run the printed `register` command. Continue
   with planning below from the factory checkout, naming the target project path.

## Plan and dispatch

1. Use the pinned `to-spec`, then `to-tickets` skills on the agreed first slice.
   Read the target's `docs/agents/issue-tracker.md` first: Seeds supplies their
   tracker vocabulary, including native blocking links and plan adoption.
   Done when the approved spec, ordered tickets and plan are committed and pushed
   to the project's default branch. In Codex these skills are `$to-spec` and
   `$to-tickets` in a chat opened in the factory checkout.
2. Start the factory with `bun run factory:start` (add `--no-open --no-wizard` for
   an already configured unattended launch). Refresh the project's clone, then
   dispatch the plan through Warren, or use the ordered issue ids:
   `bun --env-file=/dev/null src/cli/main.ts plan run --project <prj_id> --agent implementer --issues <id1,id2> --max-cost-usd 10`.
   A dispatch requires the user's instruction to start that work. Automatic merge
   additionally requires the project's explicit `pr.autoMerge` policy.
