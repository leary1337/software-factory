import type { ForgeResult } from "../contract.ts";
import { toForgeError } from "./errors.ts";
import { requestGitHub } from "./http.ts";

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
}): Promise<ForgeResult<void>> {
	const { mint, ...request } = input;
	const minted = await mint();
	if (!minted.ok) return { ok: false, error: minted.error };
	const result = await requestGitHub({ ...request, token: minted.value.secret });
	if (!result.ok) return { ok: false, error: toForgeError(result.error) };
	return { ok: true, value: undefined };
}
