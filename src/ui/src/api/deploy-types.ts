export interface ProjectDeployRecord {
	sha: string;
	createdAt: string;
	state: "success" | "failure" | "in_progress" | "unknown";
}

export interface ProjectDeployOverview {
	configured: true;
	workflow: string;
	environment: string;
	branch: string;
	current: ProjectDeployRecord | null;
	behind: { count: number; changes: Array<{ sha: string; title: string }> } | null;
	activeRun: { id: number; status: string; url: string } | null;
	history: ProjectDeployRecord[];
	activePlan: { merged: number; total: number } | null;
	error: string | null;
}

export type ProjectDeployResponse = ProjectDeployOverview | { configured: false };
