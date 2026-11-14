# IssueTracker Contract — Design Record

**Kind:** contract
**Design state:** approved
**Delivery:** shipped
**Arrived:** 2026-08-20
**Shipped:** v0.18.0
**Current truth:** `src/tracker/contract.ts`, `src/tracker/seeds-tracker.ts`, `src/core/wire-tracker.ts`, `src/seeds-cli/`

The factory uses internal Seeds for tasks and plans. Domain callers consume
`IssueTracker`, with capabilities for plans, metadata, schedules and git-native
storage. The neutral wire vocabulary and typed tracker errors remain shared
with the API and clients.

## Current behavior

- Issue reads, status maps and idempotent close are owned by `SeedsTracker`.
- Plan runs consume ordered tasks through the tracker seam.
- Missing IDs raise `IssueNotFoundError`; operational failures raise
  `TrackerError`. A tracker failure must never silently discard a task.
- Existing Seeds records, run history and delivery/recovery remain readable.
- Seeds CLI invocation is an implementation detail behind the factory API.

## Retired external integrations

FACTORY-REDESIGN ticket 08 removed `RemoteTracker`, its HTTP transport and the
standalone tracker-conformance package. The former `warren-tracker/v1` endpoint
and external bearer settings are not supported. A `tracker` block in project
configuration is rejected with a retirement explanation; remove it to use the
internal tracker. No remote credentials are loaded or forwarded.

The contract stays neutral for historical data and existing internal consumers;
it does not advertise a currently supported external provider. The judge,
campaign-controller and audit-log extensions were retired in the same change.
Their retirement does not remove built-in events, run history or diagnostics.
