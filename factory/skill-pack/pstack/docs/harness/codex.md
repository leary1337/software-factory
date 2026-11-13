# pstack in Codex

Read this before using a pstack skill in a Warren run. Warren supplies the task,
an isolated checkout, and a private home. Finish all commands and commit before
ending the turn; Warren pushes the branch and runs the review cycle.

## Skills and tools

Read pstack skills at `$HOME/.agents/pstack/skills/<name>/SKILL.md` and other
factory skills at `$HOME/.agents/skills/<name>/SKILL.md`. Follow their procedure
using the tools actually offered by the Codex session.

Use shell commands for file reads and searches (`rg`), and the available patch
tool for edits. A reference to Claude's Skill, Bash, Read, Agent, or TodoWrite
tool is a workflow instruction, not the name of a Codex tool to call.

When a skill requests independent reviewers, use Codex subagents if available.
Wait for every reviewer to finish. If subagents are unavailable, perform the
review axes sequentially and disclose that limitation. Do not invent tools.

## Unattended execution

There is no person to answer questions during a run. Resolve ordinary choices
from the ticket and repository instructions. Report a material blocker clearly.
Run quality checks in the foreground and wait for completion before committing.
Warren owns GitHub operations; finish at the commit, or at the review verdict
when assigned the reviewer role.

## Models and memory

Use the model selected by Warren. Ignore Claude/Cursor model aliases in copied
skills. Do not load `.claude/rules/pstack-models.md`.

When the repository has `.mulch/`, run `ml prime` before implementation and record
useful findings with `ml record` before the final quality gate. Codex does not use
the Claude-specific Mulch hooks. Preserve the repository's AGENTS.md instructions.
