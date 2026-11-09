---
name: connect-project
description: Connect an existing repository or a new idea to the software factory.
disable-model-invocation: true
---

Connect one project to the factory. Decide the branch from the request: a path or repo name means **existing**, an idea means **new**. Ask when it is unclear. Run scripts from the factory repo root.

The Warren GitHub token has access to all of the owner's repositories, so connecting a project needs no token change. If `register` fails on repository access, the token's repository access is the first thing to check.

## Existing repository

1. Read the repo and find its checks. Propose one quality gate command that runs lint, types and tests, and get the user's confirmation. Done when the user has confirmed a command that passes on the repo today.
2. Run `bun scripts/connect-project.ts existing <path> --gate "<command>"`.
3. Read `factory/skill-pack/pstack/skills/create-verification-skill/SKILL.md` and follow it inside the project.
4. Use the `domain-modeling` skill with the user to write `GLOSSARY.md` in the project. Done when the terms the code leans on most are defined.
5. Run the gate in the project, then `bun scripts/connect-project.ts finish <path>`.
6. Tell the user the two steps left to them, in order: merge the PR, run the `register` command the script printed.

## New idea

1. Use the `grilling` skill to settle what the project is, who it is for and its first slice. Done when a project name and that slice are agreed.
2. Run `bun scripts/connect-project.ts new <name>`.
3. Use the `domain-modeling` skill to write `GLOSSARY.md` in `~/Prog/<name>`, commit and push it.
4. Tell the user: run the `register` command the script printed, then open a session in the project and run `/to-spec` and `/to-tickets`.

## Starting the work

Tickets run with the following command, listing ids in the order they should be built:

`bun src/cli/main.ts plan run --project <prj_id> --agent implementer --issues <id1,id2> --max-cost-usd 5`
