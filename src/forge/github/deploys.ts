/** GitHub Deployments, compare and Actions calls behind the Production panel. */

import type {
	DeployRecord,
	DeployRun,
	ForgeDeploys,
	ForgeResult,
	PendingChanges,
	RepoRef,
} from "../contract.ts";
import { toForgeError } from "./errors.ts";
import { GITHUB_API_BASE } from "./headers.ts";
import { requestGitHub } from "./http.ts";
import { readJson } from "./readers.ts";

const USER_AGENT = "software-factory-deploys";

function malformed<T>(surface: string): ForgeResult<T> {
	return { ok: false, error: { kind: "http_error", detail: `GitHub returned invalid ${surface}` } };
}

function deployState(state: unknown): DeployRecord["state"] {
	if (state === "success" || state === "inactive") return state;
	if (state === "failure" || state === "error") return "failure";
	if (state === "in_progress" || state === "queued" || state === "pending") return "in_progress";
	return "unknown";
}

export class GitHubDeploys implements ForgeDeploys {
	constructor(
		private readonly mint: (ref: RepoRef) => Promise<ForgeResult<{ readonly secret: string }>>,
		private readonly slug: (ref: RepoRef) => string,
		private readonly fetchImpl?: typeof fetch,
	) {}

	private async call(
		ref: RepoRef,
		path: string,
		method: "GET" | "POST" = "GET",
		body?: object,
	): Promise<ForgeResult<unknown>> {
		const minted = await this.mint(ref);
		if (!minted.ok) return minted;
		const result = await requestGitHub({
			url: `${GITHUB_API_BASE}/repos/${this.slug(ref)}/${path}`,
			method,
			token: minted.value.secret,
			userAgent: USER_AGENT,
			context: `${method} /${path}`,
			...(body !== undefined ? { body } : {}),
			...(this.fetchImpl !== undefined ? { fetch: this.fetchImpl } : {}),
		});
		if (!result.ok) return { ok: false, error: toForgeError(result.error) };
		return { ok: true, value: method === "GET" ? await readJson(result.response) : null };
	}

	async listDeployments(
		ref: RepoRef,
		environment: string,
		limit: number,
		page = 1,
	): Promise<ForgeResult<readonly DeployRecord[]>> {
		const query = `deployments?environment=${encodeURIComponent(environment)}&per_page=${limit}&page=${page}`;
		const listed = await this.call(ref, query);
		if (!listed.ok) return listed;
		if (!Array.isArray(listed.value)) return malformed("deployment history");
		const rows = listed.value as ReadonlyArray<{
			id: number;
			sha: string;
			created_at: string;
		}>;
		const records: DeployRecord[] = [];
		for (const row of rows) {
			if (
				!row ||
				typeof row.id !== "number" ||
				typeof row.sha !== "string" ||
				typeof row.created_at !== "string"
			)
				return malformed("deployment record");
			const statuses = await this.call(ref, `deployments/${row.id}/statuses?per_page=1`);
			if (!statuses.ok) return statuses;
			if (!Array.isArray(statuses.value)) return malformed("deployment statuses");
			const latest = ((statuses.value ?? []) as ReadonlyArray<{ state?: unknown }>)[0];
			records.push({ sha: row.sha, createdAt: row.created_at, state: deployState(latest?.state) });
		}
		return { ok: true, value: records };
	}

	async compare(ref: RepoRef, base: string, head: string): Promise<ForgeResult<PendingChanges>> {
		const compared = await this.call(ref, `compare/${base}...${encodeURIComponent(head)}`);
		if (!compared.ok) return compared;
		const body = compared.value as {
			ahead_by?: number;
			commits?: ReadonlyArray<{ sha: string; commit: { message: string } }>;
		};
		if (!body || typeof body.ahead_by !== "number" || !Array.isArray(body.commits))
			return malformed("commit comparison");
		return {
			ok: true,
			value: {
				aheadBy: body.ahead_by ?? 0,
				commits: (body.commits ?? [])
					.map((c) => ({ sha: c.sha, title: c.commit.message.split("\n")[0] ?? "" }))
					.reverse(),
			},
		};
	}

	async listRuns(
		ref: RepoRef,
		workflow: string,
		limit: number,
	): Promise<ForgeResult<readonly DeployRun[]>> {
		const path = `actions/workflows/${encodeURIComponent(workflow)}/runs?per_page=${limit}`;
		const listed = await this.call(ref, path);
		if (!listed.ok) return listed;
		if (
			!listed.value ||
			typeof listed.value !== "object" ||
			!Array.isArray((listed.value as { workflow_runs?: unknown }).workflow_runs)
		)
			return malformed("workflow runs");
		const runs =
			(
				listed.value as {
					workflow_runs?: ReadonlyArray<{
						id: number;
						status: string;
						conclusion: string | null;
						head_sha: string;
						created_at: string;
						html_url: string;
						display_title?: string;
					}>;
				}
			).workflow_runs ?? [];
		if (runs.some((run) => !run || typeof run.id !== "number" || typeof run.status !== "string"))
			return malformed("workflow run status");
		return {
			ok: true,
			value: runs.map((run) => ({
				id: run.id,
				...(run.display_title === undefined ? {} : { displayTitle: run.display_title }),
				status: run.status,
				conclusion: run.conclusion,
				sha: run.head_sha,
				createdAt: run.created_at,
				url: run.html_url,
			})),
		};
	}

	async resolveCommit(ref: RepoRef, branch: string): Promise<ForgeResult<string>> {
		const result = await this.call(ref, `commits/${encodeURIComponent(branch)}`);
		if (!result.ok) return result;
		const body = result.value as { sha?: unknown } | null;
		return typeof body?.sha === "string" && /^[a-f0-9]{40}$/.test(body.sha)
			? { ok: true, value: body.sha }
			: { ok: false, error: { kind: "http_error", detail: "Cannot resolve deployment branch" } };
	}

	async readWorkflow(ref: RepoRef, workflow: string, branch: string): Promise<ForgeResult<string>> {
		const result = await this.call(
			ref,
			`contents/.github/workflows/${encodeURIComponent(workflow)}?ref=${encodeURIComponent(branch)}`,
		);
		if (!result.ok) return result;
		const body = result.value as { content?: unknown; encoding?: unknown } | null;
		if (body?.encoding !== "base64" || typeof body.content !== "string")
			return {
				ok: false,
				error: { kind: "http_error", detail: "Cannot read deployment workflow" },
			};
		return { ok: true, value: Buffer.from(body.content, "base64").toString("utf8") };
	}

	async dispatch(
		ref: RepoRef,
		workflow: string,
		branch: string,
		inputs?: Readonly<Record<string, string>>,
	): Promise<ForgeResult<void>> {
		const path = `actions/workflows/${encodeURIComponent(workflow)}/dispatches`;
		const sent = await this.call(ref, path, "POST", { ref: branch, ...(inputs ? { inputs } : {}) });
		return sent.ok ? { ok: true, value: undefined } : sent;
	}
}
