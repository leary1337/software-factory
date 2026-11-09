import type { ForgeResult } from "../contract.ts";
import { requestGitHub } from "./http.ts";
import { toForgeError } from "./provider.ts";

/** Send a PR body or comment text to GitHub. */
export async function sendPrText(input: {
	readonly url: string;
	readonly method: "PATCH" | "POST";
	readonly mint: () => Promise<ForgeResult<{ readonly secret: string }>>;
	readonly userAgent: string;
	readonly context: string;
	readonly text: string;
	readonly fetch: typeof fetch;
}): Promise<ForgeResult<void>> {
	const { text, mint, ...request } = input;
	const minted = await mint();
	if (!minted.ok) return { ok: false, error: minted.error };
	const result = await requestGitHub({
		...request,
		token: minted.value.secret,
		body: { body: text },
	});
	if (!result.ok) return { ok: false, error: toForgeError(result.error) };
	return { ok: true, value: undefined };
}
