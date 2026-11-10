import type { ForgeResult } from "../contract.ts";
import { toForgeError } from "./errors.ts";
import { requestGitHub } from "./http.ts";
import { readJson } from "./readers.ts";

export type PrWriteMethod = "PATCH" | "POST" | "PUT";

/** Send one write to a GitHub pull request. */
export async function writePullRequest(input: {
	readonly mint: () => Promise<ForgeResult<{ readonly secret: string }>>;
	readonly url: string;
	readonly method: PrWriteMethod;
	readonly userAgent: string;
	readonly context: string;
	readonly body: object;
	readonly fetch: typeof fetch;
	readonly expectMerged?: boolean;
}): Promise<ForgeResult<void>> {
	const { mint, expectMerged, ...request } = input;
	const minted = await mint();
	if (!minted.ok) return { ok: false, error: minted.error };
	const result = await requestGitHub({ ...request, token: minted.value.secret });
	if (!result.ok) return { ok: false, error: toForgeError(result.error) };
	if (expectMerged) {
		const body = (await readJson(result.response)) as { merged?: unknown } | null;
		if (body?.merged !== true)
			return { ok: false, error: { kind: "http_error", detail: "Merge was not confirmed" } };
	}
	return { ok: true, value: undefined };
}
