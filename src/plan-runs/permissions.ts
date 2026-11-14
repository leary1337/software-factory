import type {
	ApprovedPlanSnapshot,
	PlanPermission,
	PlanPermissionKind,
} from "../core/plan-approval.ts";

function permissionForPath(path: string, patch: string): PlanPermissionKind | null {
	const changed = patch
		.split("\n")
		.filter((line) => /^[+-]/.test(line) && !/^(---|\+\+\+)/.test(line))
		.map((line) => line.slice(1))
		.join("\n");
	if (
		/^\.github\/workflows\//.test(path) &&
		/permissions\s*:|write-all|id-token\s*:/i.test(changed)
	)
		return "access";
	if (/(^|\/)(AGENTS\.md|CLAUDE\.md|\.agents\/|\.claude\/|\.warren\/)/.test(path))
		return "factory_rules";
	if (
		/(^|\/)(auth|authorization|permissions?|rbac|iam|policies)(\/|\.)|(^|\/)(sudoers|\.ssh)(\/|$)/i.test(
			path,
		)
	)
		return "access";
	if (
		/(migration|schema)/i.test(path) &&
		/\b(drop\s+(table|column|database)|truncate|delete\s+from|drop_table|drop_column|remove_column|RemoveField|DeleteModel)\b/i.test(
			changed,
		)
	)
		return "destructive_migration";
	return null;
}
function covers(permission: PlanPermission, kind: PlanPermissionKind, path: string): boolean {
	return (
		permission.kind === kind &&
		permission.reason.trim() !== "" &&
		permission.paths.some((pattern) => new Bun.Glob(pattern).match(path))
	);
}
/** Only specific saved grants authorize special changes; ordinary code/build/dependency edits pass. */
export function planPermissionDecision(
	snapshot: ApprovedPlanSnapshot,
	seq: number,
	paths: readonly string[],
	diff: string,
): { allowed: string[]; blocked: { path: string; kind: PlanPermissionKind }[] } {
	const permissions = [
		...snapshot.permissions,
		...(snapshot.tasks.find((task) => task.seq === seq)?.permissions ?? []),
	];
	const allowed: string[] = [];
	const blocked: { path: string; kind: PlanPermissionKind }[] = [];
	for (const path of paths) {
		const patch =
			diff.split(/^diff --git /m).find((section) => section.startsWith(`a/${path} b/${path}\n`)) ??
			diff;
		const kind = permissionForPath(path, patch);
		if (kind && !permissions.some((permission) => covers(permission, kind, path)))
			blocked.push({ path, kind });
		else allowed.push(path);
	}
	return { allowed, blocked };
}
