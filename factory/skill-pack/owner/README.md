# Pinned owner skills

These are unmodified copies from the Matt Pocock commit in `../LOCK.json`.
Their complete directories include the reference files they read. They are for
interactive owner sessions; run homes receive only the separate runtime pack.

Open a Codex chat in the factory checkout. `.agents/skills/` links these pinned
sources, so `$grill-with-docs`, `$domain-modeling`, `$to-spec`, `$to-tickets`,
`$wayfinder`, `$prototype` and `$retro` work without a Marketplace installation.
Name the target project path explicitly when working on a connected repository.
The same procedures can be read directly from `skills/<name>/SKILL.md`.

When an upstream procedure says “call the Skill tool”, invoke the named skill
through the host if available, or read its pinned `SKILL.md` and follow the
procedure with the tools the host actually exposes. The pack also includes
`grilling`, `research` and `writing-for-agents`, which those procedures reference.
The target project's `docs/agents/issue-tracker.md` supplies the Seeds tracker
instructions; it replaces upstream's generic setup prerequisite.

For the weekly manual retrospective, invoke `$retro` on a real session or plan
run. Drain its actual events with
`bun --env-file=/dev/null src/cli/main.ts tail <run-id> --no-follow` from the factory
checkout. Follow `factory.learning` events back to their source review/run and
check logs; record only observed failures and proposed checks. `context.metrics`
events describe injected byte counts and rough estimates, not measured model
context consumption or per-skill billing. Then read
`../pstack/skills/correct/SKILL.md` for the correction workflow. Use `ml record`
inside a project with Mulch to keep accepted lessons, and deliver factory changes
through a PR. This is a manual workflow, not a scheduled patrol.

`$connect-project` is the entry point for existing repositories and new ideas.
