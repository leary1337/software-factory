import type { ForgeResult } from "../contract.ts";
import { toForgeError } from "./errors.ts";
import { requestGitHub } from "./http.ts";
import { readJson } from "./readers.ts";

/** Recover an acknowledged-or-lost POST using a stable marker before retrying. */
export async function writeReviewComment(input: {
	mint: () => Promise<ForgeResult<{ readonly secret: string }>>;
	url: string;
	body: string;
	key: string;
	userAgent: string;
	fetch: typeof fetch;
}): Promise<ForgeResult<void>> {
	const marker = `<!-- ${input.key} -->`;
	const minted = await input.mint();
	if (!minted.ok) return minted;
	const request = { token: minted.value.secret, userAgent: input.userAgent, fetch: input.fetch };
	for (let page = 1; page <= 100; page++) {
		const found = await requestGitHub({
			...request,
			url: `${input.url}?per_page=100&page=${page}`,
			method: "GET",
			context: "find review comment",
		});
		if (!found.ok) return { ok: false, error: toForgeError(found.error) };
		const rows: unknown = await readJson(found.response);
		if (!Array.isArray(rows))
			return { ok: false, error: { kind: "http_error", detail: "Invalid comment list" } };
		if (rows.some((row) => typeof row?.body === "string" && row.body.includes(marker)))
			return { ok: true, value: undefined };
		if (rows.length < 100) {
			const posted = await requestGitHub({
				...request,
				url: input.url,
				method: "POST",
				body: { body: `${input.body}\n\n${marker}` },
				context: "publish review comment",
				retry: { maxRetries: 0 },
			});
			return posted.ok
				? { ok: true, value: undefined }
				: { ok: false, error: toForgeError(posted.error) };
		}
	}
	return {
		ok: false,
		error: { kind: "http_error", detail: "Review comment history exceeds recovery limit" },
	};
}
