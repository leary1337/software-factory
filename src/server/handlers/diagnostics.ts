/**
 * Diagnostics handlers — `/readyz` (warren-599c / pl-9088 step 3).
 *
 * Extracted from `handlers/index.ts`. The `/healthz` + `/version`
 * inert probes live in `./meta.ts` because they don't need any of the
 * diagnostic checks subsystem.
 */

import {
	checkDatabaseReachable,
	checkPreviewAuthStrength,
	checkPreviewMaxLive,
	checkPreviewPortAllocator,
	checkWarrenConfig,
	checkWarrenConfigDeprecations,
	type DiagnosticCheck,
} from "../../diagnostics/checks.ts";
import { checkStaleSandboxWorkspaces } from "../../diagnostics/stale-workspaces.ts";
import { DEFAULT_MAX_LIVE } from "../../preview/eviction/index.ts";
import { DEFAULT_PREVIEW_PORT_RANGE, PreviewPortAllocator } from "../../preview/port-allocator.ts";
import { jsonResponse } from "../response.ts";
import type { RouteHandler, ServerDeps } from "../types.ts";

export function readyzHandler(deps: ServerDeps): RouteHandler {
	return async () => {
		const checks: DiagnosticCheck[] = [];
		// `deps.logger` is the sink for the raw failure detail the checks
		// refuse to put in the payload (warren-51de): driver text naming the
		// DB host/port/role, loader text naming the clone's absolute path.
		// The body carries a stable reason code; the log carries the rest.
		checks.push(
			await checkDatabaseReachable({
				...(deps.db !== undefined ? { db: deps.db } : {}),
				log: deps.logger,
			}),
		);
		checks.push(await staleSandboxWorkspacesReadyzCheck(deps));
		checks.push(await checkAgentsRegistered(deps));
		const warrenConfigProjects = (await deps.repos.projects.listAll()).map((p) => ({
			id: p.id,
			localPath: p.localPath,
		}));
		const warrenConfigArgs = {
			projects: warrenConfigProjects,
			log: deps.logger,
			...(deps.warrenConfigs !== undefined ? { cache: deps.warrenConfigs } : {}),
		};
		checks.push(await checkWarrenConfig(warrenConfigArgs));
		checks.push(await checkWarrenConfigDeprecations(warrenConfigArgs));
		checks.push(await previewPortAllocatorReadyzCheck(deps));
		checks.push(await previewMaxLiveReadyzCheck(deps));
		// Auth-strength probe (R-19 / docs/design/preview-environments.md, warren-8a10) reads from
		// process.env directly: server boot already validated the token shape,
		// so /readyz only needs to surface the strength heuristic against the
		// live env. Tests that don't override `process.env` get the inert
		// "preview disabled" branch.
		checks.push(checkPreviewAuthStrength({ env: process.env }));

		const allOk = checks.every((c) => c.ok);
		return jsonResponse(allOk ? 200 : 503, {
			ok: allOk,
			checks,
		});
	};
}

async function previewPortAllocatorReadyzCheck(deps: ServerDeps): Promise<DiagnosticCheck> {
	// Range is resolved at boot (`ServerDeps.previewPortRange`) so /readyz
	// doesn't re-parse env per request. Tests omit deps.previewPortRange;
	// fall back to defaults so the probe still exercises the codepath.
	const range = deps.previewPortRange ?? DEFAULT_PREVIEW_PORT_RANGE;
	if (deps.dbAdapter === undefined) {
		return {
			name: "preview_port_allocator",
			ok: true,
			message: `no db handle wired (range ${range.start}-${range.end})`,
		};
	}
	const allocator = new PreviewPortAllocator(deps.dbAdapter, range);
	return checkPreviewPortAllocator({ probe: allocator, log: deps.logger });
}

async function previewMaxLiveReadyzCheck(deps: ServerDeps): Promise<DiagnosticCheck> {
	const maxLive = deps.previewMaxLive ?? DEFAULT_MAX_LIVE;
	const previews = deps.runPreviews;
	if (previews === undefined) {
		return {
			name: "preview_max_live",
			ok: true,
			message: `no db handle wired (cap ${maxLive})`,
		};
	}
	return checkPreviewMaxLive({
		probe: { count: () => previews.countActivePreviews() },
		maxLive,
		log: deps.logger,
	});
}

async function staleSandboxWorkspacesReadyzCheck(deps: ServerDeps): Promise<DiagnosticCheck> {
	// TTL is resolved at boot (`ServerDeps.workspaceGcTtlMs`). Tests omit it;
	// degrade to an informational `ok: true` rather than guessing a TTL.
	if (deps.workspaceGcTtlMs === undefined) {
		return {
			name: "stale_sandbox_workspaces",
			ok: true,
			message: "workspace GC TTL not wired",
		};
	}
	return checkStaleSandboxWorkspaces({
		probe: {
			listByState: (state) => deps.repos.runs.listByState(state),
		},
		ttlMs: deps.workspaceGcTtlMs,
		log: deps.logger,
		...(deps.now !== undefined ? { now: deps.now() } : {}),
	});
}

async function checkAgentsRegistered(deps: ServerDeps): Promise<DiagnosticCheck> {
	const count = (await deps.repos.agents.listAll()).length;
	if (count === 0) {
		// Built-ins seed on boot (warren-d3e9), so an empty registry here
		// means seeding itself failed — an internal problem, not an
		// operator one. Keep the failure but reword the hint accordingly.
		return {
			name: "agents",
			ok: false,
			message: "no agents registered",
			hint: "check the warren server logs for built-in seed errors",
		};
	}
	return { name: "agents", ok: true };
}
