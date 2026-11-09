# Issue tracker: Seeds

Tickets for this repo live in `.seeds/` and are managed with the `sd` CLI. Warren runs them as plans.

## Conventions

- **Create a ticket**: `sd create --title "..." --type feature --body "..."`. Add `--json` to read back the id.
- **Read a ticket**: `sd show <id>`.
- **List**: `sd list`. `sd ready` shows open tickets with no open blockers.
- **Blocking**: `sd dep add <issue> <depends-on>`.
- **Labels**: `sd label add <id> <label>`.
- **Close**: `sd close <id>`.

Warren reads `.seeds/` from the default branch.

## When a skill says "publish to the issue tracker"

Create a ticket with `sd create`. Publish a spec as a ticket of type `epic`.

## After publishing the tickets of a spec

Warren's site offers plans, so finish by turning the tickets into one. Done when the plan is on the default branch.

1. Switch to the default branch and pull.
2. Run `sd plan create <epic-id> --json` and read `plan_id`.
3. Run `sd plan adopt <plan-id> <ticket-ids>`, listing every ticket blockers first. Agents build them in this order.
4. Run `sd sync`, then `git push`.
5. Tell the user: on the Warren site press Refresh clone on the project, then dispatch the plan with the `implementer` agent.

## When a skill says "fetch the relevant ticket"

Run `sd show <id>`.
