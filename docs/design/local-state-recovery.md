# Local installation backup and single ownership

**Kind:** contract
**Design state:** approved
**Delivery:** shipped
**Arrived:** 2026-11-14
**Shipped:** local factory redesign
**Current truth:** `src/installation/`, `src/locks/file-lock.ts`, `src/cli/commands/state.ts`, `src/server/main/index.ts`

A persistent installation identity travels with every copy. Before boot, the server
holds an OS file lock for that identity and for the canonical database path. Lock
files live outside the copied data directory. Process death releases the lock;
there is no stale PID takeover. Activating a restored directory records it as the
active location, so the older copy cannot later start an obsolete queue.

Stop the local factory before running `warren state backup --to <new-directory>`.
The backup includes the SQLite database, queue, event history, effect receipts,
working copies, private Git directories, recovery bundles, and immutable toolkits.
External project checkout directories are copied into the backup too. The database
must live under the data directory; Postgres backup is outside this local workflow.
The copy is private and its operator summary contains counts and locations, not
credential contents.

`warren state restore --from <backup> --to <new-directory>` verifies database
integrity, migration compatibility, and artifact hashes. The restored queue is
explicitly disabled. Restoration itself cannot dispatch work or contact a forge.
`warren state activate --data-dir <restored-directory>` checks exclusive ownership
and refuses activation if the original database recorded newer actions after the
backup. When the original is unavailable, explicit `--allow-source-unavailable`
authorizes proceeding after inspecting the saved action receipts; external outcomes
still require reconciliation before further writes.

Activation rewrites stored checkout paths, private Git pointers, alternates, and
workspace manifests to the new location. It prepares relocated bytes in a private
staging copy, records a durable activation intent, then replaces changed files
atomically. An interrupted activation can repeat the same command: it verifies
old or prepared hashes and completes the remaining replacements. The queue stays
disabled until the transfer finishes.

Returning to an older factory binary is permitted only when that binary recognizes
the recorded migration version. Returning to an older data snapshot after newer
actions is refused. Keep the original and backup until a restored copy has passed
its verification; these commands never delete them.

Tests restore a nonempty queue and external checkout, recover pending Git work,
reject corrupted artifacts and newer-action rollback, verify database symlink
aliases share ownership, interrupt activation between file replacements, and kill
an owner process to prove OS lock release. These are local Mac tests; VPS deployment
remains deferred.
