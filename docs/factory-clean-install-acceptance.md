# Clean local installation acceptance

The current factory package passed a clean local installation check on macOS arm64 on
2026-11-14. This is evidence for a working-tree snapshot, not a published release or a
VPS deployment. The installation was separate from the owner's running factory and
used no Codex credentials.

Run the reproducible check from a checkout with the UI already built:

```bash
bun run build:ui
bun run scripts/factory-acceptance/clean-install.ts .scratch/factory-redesign/evidence/37-clean-install.json
```

The script creates an actual npm tarball, unpacks it into a fresh temporary directory,
installs production dependencies there, and compares every packed file with its source
SHA-256. It runs the packaged CLI and server, then stops that server. The evidence JSON
contains the tarball integrity, source HEAD, file hash manifest, temporary artifact
location, timestamps, and assertions. No global installation is replaced.

## Recorded result

The latest evidence JSON records the source HEAD, start and finish times, and the
number of files checked. The source includes uncommitted redesign changes; individual
file hashes identify that snapshot precisely, while HEAD alone does not.

| Check | Observed result |
| --- | --- |
| Package contents | Every packed file matched its source hash; exact count is in the report |
| Production dependency installation | Fresh dependencies under the temporary package |
| CLI bootstrap | Packaged `prime` completed |
| Runtime | Local; Codex and Claude Code adapters available |
| Active agent definitions | Seven; no Pi or automatic patrol agents |
| Skills | 73 catalog entries; 59 factory skills materialized for each CLI |
| Skill consistency | Codex and Claude receipts shared the catalog version |
| MCP catalog | Exa, Context7, Graphify, Playwright |
| New project template | Generated `.gitignore` includes dependencies and `.env` exclusions |
| Server | Loopback random port, fake forge, fresh data directory |
| UI | HTML and both referenced assets served successfully |
| State isolation | Empty run and plan queues; separate HOME and Git config |
| Shutdown | SIGTERM exited successfully |

The artifact contains neither Docker runtime/entrypoints nor Pi execution, external
extensions, or system sandbox entrypoints. Historical parsers can remain for existing
records. Production dependencies do not require the retired infrastructure packages.

The package guard checks the canonical `gitignore.template` as well as the skill
catalog. npm excludes a file named `.gitignore` even when explicitly listed, so the
shared scaffold helper materializes the template under its final `.gitignore` name.
Both new-project entry points consume that helper.

## Evidence and limits

Machine evidence is stored locally at
`.scratch/factory-redesign/evidence/37-clean-install.json` with its adjacent
`37-clean-install.hashes.json`. The report contains the SHA-256 of that complete
manifest and the SHA-512 integrity of the tarball. Keeping those values in the machine
report avoids a self-reference when this document is included in the package.

This check covers packaging, installation, bootstrap, materialization and isolation.
It does not call a model, contact MCP services, verify a user's GitHub permissions,
or claim that task preparation and independent review passed. Ticket 38 provides the
separate real-task acceptance evidence. The fake forge deliberately prevents this
installation check from publishing repositories or PRs.

The clean installation needed no manual runtime repair. Two earlier harness checks
were narrowed before the passing run: macOS `/var` aliases were canonicalized, and
retained historical parser files were distinguished from retired executable
entrypoints. A later fresh run additionally verified the packaged project ignore
rules. Repeat the check when packaged inputs change; do not treat this snapshot as
proof for a later artifact.

The approved redesign UI also received a measured bundle baseline through the
repository's supported update command. JavaScript measured 782,759 bytes raw and
227,532 bytes gzip, compared with earlier ceilings of 740,082 and 216,380 bytes.
This covers the new project settings, plan approval/revisions, toolkit and readiness
controls, compact task history, and visible environment repair/rollback without a new
heavy UI dependency. The budget file records the explicit
feature allowance and the tool's standard headroom.

The final UI verification ran 551 browser cases successfully, with five deliberate
skips. After the last recovery projection correction, all 16 focused recovery and
task-page smoke cases passed again. The matrix covered 393px and 1440px viewports in
light and dark themes; no laptop-rendered golden baselines were generated. Terminal
merged tasks and completed work are collapsed, active delivery and incidents remain
visible, and full legacy instructions remain inside task details.
