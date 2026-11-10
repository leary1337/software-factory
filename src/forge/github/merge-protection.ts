import type { ForgeResult, MergeProtection } from "../contract.ts";
import { toForgeError } from "./errors.ts";
import { requestGitHub } from "./http.ts";
import { readJson } from "./readers.ts";

function record(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function strictProtection(value: unknown): boolean {
	const protection = record(value);
	const checks = record(protection.required_status_checks);
	const contexts = checks.contexts;
	const hasChecks =
		Array.isArray(contexts) &&
		contexts.length > 0 &&
		contexts.every((context) => typeof context === "string" && context.trim().length > 0);
	return checks.strict === true && hasChecks && record(protection.enforce_admins).enabled === true;
}

/** Only classic branch protection can currently prove this contract; rulesets fail closed. */
export async function readGitHubMergeProtection(input: {
	readonly mint: () => Promise<ForgeResult<{ readonly secret: string }>>;
	readonly url: string;
	readonly fetch: typeof fetch;
}): Promise<ForgeResult<MergeProtection>> {
	const minted = await input.mint();
	if (!minted.ok) return minted;
	const request = { token: minted.value.secret, fetch: input.fetch };
	const protection = await requestGitHub({
		...request,
		url: `${input.url}/protection`,
		context: "read merge protection",
	});
	if (!protection.ok) return { ok: false, error: toForgeError(protection.error) };
	const requiresUpToDate = strictProtection(await readJson(protection.response));
	const branch = await requestGitHub({
		...request,
		url: input.url,
		context: "read protected base",
	});
	if (!branch.ok) return { ok: false, error: toForgeError(branch.error) };
	const baseCommit = record(record(await readJson(branch.response)).commit).sha;
	if (typeof baseCommit !== "string" || !/^[a-f0-9]{40}$/.test(baseCommit))
		return { ok: false, error: { kind: "http_error", detail: "Invalid protected branch commit" } };
	return { ok: true, value: { baseCommit, requiresUpToDate } };
}
