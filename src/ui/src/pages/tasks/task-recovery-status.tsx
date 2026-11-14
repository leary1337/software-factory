import { Alert } from "@/components/ui/alert.tsx";
import type {
	PreparationRecovery,
	RollbackRecovery,
	TaskRecoverySummary,
} from "../../../../core/task-recovery.ts";

const preparationTitles = {
	repairing: "Repairing the project environment",
	recovered: "Environment preparation recovered",
	failed: "Environment preparation failed",
	stopped: "Environment repair stopped",
};
const rollbackTitles = {
	running: "Restoring the previous verified release",
	verified: "Previous release restored and verified",
	failed: "Rollback stopped — action required",
	released: "Recovery release verified",
};
const rollbackActions = {
	running: "The queue is waiting for restoration and production checks.",
	verified: "The task still needs repair and a verified release.",
	failed:
		"The queue is stopped. Inspect production and resolve the rollback failure before resuming.",
	released: "The repaired application passed production verification.",
};

function PreparationStatus({
	recovery,
	compact,
}: {
	recovery: PreparationRecovery;
	compact: boolean;
}) {
	const stopped = recovery.state === "failed" || recovery.state === "stopped";
	const paragraphClass = compact ? "line-clamp-2" : undefined;
	return (
		<Alert
			className="text-(--color-fg)"
			title={preparationTitles[recovery.state]}
			variant={stopped ? "warning" : "info"}
		>
			<p>
				{recovery.attempt} repair {recovery.attempt === 1 ? "attempt" : "attempts"} used
			</p>
			<div className="wrap-anywhere mt-2 space-y-2">
				<p className={paragraphClass}>{recovery.reason}</p>
				{!compact && recovery.stopReason ? <p>{recovery.stopReason}</p> : null}
				<p className={paragraphClass}>{recovery.action}</p>
				<p className={paragraphClass}>{recovery.nextAction}</p>
			</div>
		</Alert>
	);
}
function RollbackStatus({ recovery, compact }: { recovery: RollbackRecovery; compact: boolean }) {
	return (
		<Alert
			className="text-(--color-fg)"
			title={rollbackTitles[recovery.state]}
			variant={recovery.state === "failed" ? "danger" : "info"}
		>
			<div className="wrap-anywhere space-y-2">
				<p className={compact ? "line-clamp-2" : undefined}>{recovery.reason}</p>
				{!compact && recovery.sha ? <p>Restoration target: {recovery.sha.slice(0, 8)}</p> : null}
				<p>{rollbackActions[recovery.state]}</p>
			</div>
		</Alert>
	);
}
export function TaskRecoveryStatus({
	recovery,
	compact = false,
}: {
	recovery?: TaskRecoverySummary;
	compact?: boolean;
}) {
	if (!recovery) return null;
	const { preparation } = recovery;
	const rollback = compact && recovery.rollback?.state === "released" ? null : recovery.rollback;
	if (!preparation && !rollback) return null;
	return (
		<div className="space-y-3">
			{preparation ? <PreparationStatus recovery={preparation} compact={compact} /> : null}
			{rollback ? <RollbackStatus recovery={rollback} compact={compact} /> : null}
		</div>
	);
}
