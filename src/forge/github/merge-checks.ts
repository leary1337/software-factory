import type { CheckRun, CheckSummary, ForgeResult } from "../contract.ts";
import { toForgeError } from "./errors.ts";
import { requestGitHub } from "./http.ts";
import { parseCheckRun, readJson } from "./readers.ts";

type Input = {
	readonly mint: () => Promise<ForgeResult<{ readonly secret: string }>>;
	readonly url: string;
	readonly commit: string;
	readonly fetch: typeof fetch;
};
type Source = "check-runs" | "status";
const invalid = (): ForgeResult<never> => ({
	ok: false,
	error: {
		kind: "http_error",
		detail: "Merge checks are incomplete or malformed",
	},
});
function record(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}
function parseRun(value: unknown, source: Source, commit: string): CheckRun | null {
	const row = record(value);
	if (source === "check-runs") {
		const parsed = parseCheckRun(row);
		return parsed?.name.trim() && row.head_sha === commit ? parsed : null;
	}
	if (
		typeof row.context !== "string" ||
		!row.context.trim() ||
		!["pending", "success", "error", "failure"].includes(String(row.state))
	)
		return null;
	return {
		name: row.context,
		status: row.state === "pending" ? "in_progress" : "completed",
		conclusion: row.state === "success" ? "success" : row.state === "pending" ? null : "failure",
		jobId: null,
		detailsUrl: null,
	};
}
async function readPage(
	input: Input,
	source: Source,
	page: number,
): Promise<ForgeResult<{ runs: CheckRun[]; total: number }>> {
	const minted = await input.mint();
	if (!minted.ok) return minted;
	const response = await requestGitHub({
		url: `${input.url}/${source}?per_page=100&page=${page}${source === "check-runs" ? "&filter=latest" : ""}`,
		token: minted.value.secret,
		fetch: input.fetch,
		context: "read merge checks",
	});
	if (!response.ok) return { ok: false, error: toForgeError(response.error) };
	const body = record(await readJson(response.response));
	const rows = body[source === "check-runs" ? "check_runs" : "statuses"];
	const total = body.total_count;
	if (!Array.isArray(rows) || typeof total !== "number" || !Number.isInteger(total) || total < 0)
		return invalid();
	if (source === "status" && body.sha !== input.commit) return invalid();
	const parsed = rows.map((value) => parseRun(value, source, input.commit));
	const runs = parsed.filter((row): row is CheckRun => row !== null);
	return runs.length === rows.length ? { ok: true, value: { runs, total } } : invalid();
}
async function readSource(input: Input, source: Source): Promise<ForgeResult<CheckRun[]>> {
	const runs: CheckRun[] = [];
	let expected: number | undefined;
	for (let page = 1; page <= 100; page++) {
		const result = await readPage(input, source, page);
		if (!result.ok) return result;
		const { runs: rows, total } = result.value;
		if (expected !== undefined && total !== expected) return invalid();
		expected = total;
		runs.push(...rows);
		if (runs.length === total) return { ok: true, value: runs };
		if (!rows.length || runs.length > total) return invalid();
	}
	return invalid();
}
/** Every page of both APIs is mandatory. An absent API is not an empty passing set. */
export async function readGitHubMergeChecks(input: Input): Promise<ForgeResult<CheckSummary>> {
	const checks = await readSource(input, "check-runs");
	if (!checks.ok) return checks;
	const statuses = await readSource(input, "status");
	if (!statuses.ok) return statuses;
	const runs = [...checks.value, ...statuses.value];
	const failed = runs.some(
		(run) =>
			run.status === "completed" &&
			!["success", "neutral", "skipped"].includes(run.conclusion ?? ""),
	);
	const conclusion = failed
		? "failing"
		: runs.some((run) => run.status !== "completed")
			? "pending"
			: runs.length
				? "passing"
				: "unknown";
	return { ok: true, value: { runs, conclusion } };
}
