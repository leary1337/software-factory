# Issue tracker: Seeds

Tickets for this repo live in `.seeds/` and are managed with the `sd` CLI. Warren runs them as plans.

## Conventions

- **Create a ticket**: `sd create --title "..." --type feature --body "..."`. Add `--json` to read back the id.
- **Read a ticket**: `sd show <id>`.
- **List**: `sd list`. `sd ready` shows open tickets with no open blockers.
- **Blocking**: `sd dep add <issue> <depends-on>`.
- **Labels**: `sd label add <id> <label>`.
- **Close**: `sd close <id>`.

Commit `.seeds/` changes so Warren sees them: `sd sync`, then `git push`.

## When a skill says "publish to the issue tracker"

Create a ticket with `sd create`. Publish a spec as a ticket of type `epic`.

## When a skill says "fetch the relevant ticket"

Run `sd show <id>`.
