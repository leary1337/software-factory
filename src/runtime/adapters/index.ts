/**
 * The agent-runtime adapter registry (warren-c80e phase 1, GH #846).
 *
 * One entry per {@link KNOWN_RUNTIME_IDS} member, so the record cannot go
 * stale: adding a runtime id to the union fails the build here until its
 * adapter is declared. This mirrors `src/core/usage-shape.ts`, which keys
 * its readers the same way.
 *
 * ## Two ways to ask
 *
 * `adapterFor(runtimeId)` is the direct lookup, for a caller that knows
 * which harness produced the thing it is holding.
 *
 * The aggregate accessors (`harnessStatePrefixes()`,
 * `providerErrorEnvelopeTypes()`) are the union across every adapter, for a
 * caller that does not. Both of this phase's tenants are in the second
 * group today, and the union is what keeps this refactor behavior-neutral:
 * the flat constants it replaces were themselves runtime-agnostic, applied
 * to every run regardless of harness. Narrowing either call site to the
 * run's own adapter would change which runs are affected, which is a
 * behavioral change and belongs to whoever threads the run's runtime id
 * down to reap, not to the move that creates the seam.
 */

import { isRetiredRuntimeId, KNOWN_RUNTIME_IDS, type RuntimeId } from "../../core/wire.ts";
import { claudeCodeAdapter } from "./claude-code.ts";
import { codexAdapter } from "./codex.ts";
import { piAdapter } from "./pi.ts";
import type { AgentFrontmatter, AgentRuntimeAdapter } from "./types.ts";

// Phase-2 harness surface (warren-7933) — additive re-exports so the k8s
// in-pod rewiring (warren-0efe) can consume the lifted types from the
// registry root.
export type {
	AdapterEventKind,
	AdapterExtractMetadataContext,
	AdapterPrepareContext,
	AdapterRuntimeEvent,
	AdapterSpawnContext,
	AgentFrontmatter,
	AgentRuntimeAdapter,
	SpawnCommand,
	SteeringMessage,
} from "./types.ts";

/**
 * Every adapter, keyed by runtime id. `satisfies` rather than a bare
 * annotation so a missing key is a compile error and an unknown key is too.
 */
export const RUNTIME_ADAPTERS = {
	"claude-code": claudeCodeAdapter,
	pi: piAdapter,
	codex: codexAdapter,
} satisfies Record<RuntimeId, AgentRuntimeAdapter>;

/** The adapter for one runtime id. Total over the union, so never null. */
export function adapterFor(runtimeId: RuntimeId): AgentRuntimeAdapter {
	return RUNTIME_ADAPTERS[runtimeId];
}

/** Executable adapters only; historical decoders remain available through adapterFor. */
export function allAdapters(): readonly AgentRuntimeAdapter[] {
	return KNOWN_RUNTIME_IDS.filter((id) => !isRetiredRuntimeId(id)).map(
		(id) => RUNTIME_ADAPTERS[id],
	);
}

/** Stateful parsers are instantiated once per process. Stateless adapters keep their parser. */
export function eventParserFor(adapter: AgentRuntimeAdapter, frontmatter?: AgentFrontmatter) {
	return adapter.createEventParser?.(frontmatter) ?? adapter.parseEvents ?? (() => []);
}

/** Collect one declared list across every adapter, de-duplicated, in id order. */
function union(pick: (adapter: AgentRuntimeAdapter) => readonly string[]): readonly string[] {
	return [...new Set(Object.values(RUNTIME_ADAPTERS).flatMap(pick))];
}

/**
 * Every harness-owned state prefix warren knows about, across all runtimes.
 * Reap's dirty-path classifier reads this: it inspects a workspace without
 * knowing which harness produced it, so it must ignore any harness's
 * scratch (warren-f6f2).
 */
export function harnessStatePrefixes(): readonly string[] {
	return union((adapter) => adapter.harnessStatePrefixes);
}

/**
 * Every git exclude pattern the harnesses declare, across all runtimes. The
 * workspace materializer installs the union (warren-194a): a workspace is
 * materialized before the run's runtime id is consulted, and an exclude for a
 * harness that will not run there is inert.
 */
export function commitExcludes(): readonly string[] {
	return union((adapter) => adapter.commitExcludes ?? []);
}

/**
 * Every envelope type that can carry a terminal provider error, across all
 * runtimes. The reap-time classifier reads a persisted event log without
 * the run's runtime id in hand, so it reads the union (warren-edc3).
 */
export function providerErrorEnvelopeTypes(): readonly string[] {
	return union((adapter) => adapter.terminalErrorEnvelopeTypes);
}
