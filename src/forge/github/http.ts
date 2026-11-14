/**
 * GitHub REST transport — request execution.
 *
 * The single `fetch` boundary for `api.github.com` (plan pl-d1c9 step 1).
 * Composes the header builder (headers.ts), the fail-soft readers
 * (readers.ts), the error classifier (errors.ts), and the retry policy
 * (retry.ts) into one result-union call. The injected-`fetch` convention
 * the four pre-consolidation clients shared is preserved: pass `fetch`
 * in tests, omit it in production.
 *
 * The result carries the raw `Response` on success so callers keep owning
 * body parsing — this module transports; the domain owns meaning
 * (forge-contract.md §3).
 */

import { classifyGitHubHttpError, type GitHubHttpError, networkError } from "./errors.ts";
import { buildGitHubHeaders } from "./headers.ts";
import { readText, truncate } from "./readers.ts";
import { type GitHubRetryOptions, withGitHubRetry } from "./retry.ts";

export type GitHubTransportResult =
	| { readonly ok: true; readonly response: Response }
	| { readonly ok: false; readonly error: GitHubHttpError };

export interface GitHubRequestInput {
	/** Absolute URL, or a path relative to the API base resolved by the caller. */
	readonly url: string;
	readonly method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
	readonly token: string;
	/** JSON-serializable request body; omitted when undefined. */
	readonly body?: unknown;
	/** Injected fetch seam; defaults to `globalThis.fetch`. */
	readonly fetch?: typeof fetch;
	/** Subsystem User-Agent override (see headers.ts). */
	readonly userAgent?: string;
	/** Short call-site label folded into error messages, e.g. `GET /pulls/7`. */
	readonly context: string;
	/** Per-attempt deadline through response-body consumption (default 30 seconds). */
	readonly requestTimeoutMs?: number;
	/** GET retry tuning. Mutations never retry here: their outcome may already be committed. */
	readonly retry?: GitHubRetryOptions;
}

/** Cap on response-body text folded into an error message. */
const ERROR_BODY_MAX_CHARS = 500;

/**
 * Execute one GitHub REST request: build headers, fetch, classify a
 * non-2xx response, and retry transient GET failures per the module policy.
 * Mutations return unknown outcomes for domain reconciliation, even with retry options.
 * Never throws — a thrown fetch surfaces as a `network` error.
 */
export async function requestGitHub(input: GitHubRequestInput): Promise<GitHubTransportResult> {
	const fetchImpl = input.fetch ?? globalThis.fetch;
	const headers = buildGitHubHeaders(input.token, {
		...(input.userAgent !== undefined ? { userAgent: input.userAgent } : {}),
	});
	const init: RequestInit = {
		method: input.method ?? "GET",
		headers,
		...(input.body !== undefined ? { body: JSON.stringify(input.body) } : {}),
	};

	const retry = init.method === "GET" ? (input.retry ?? {}) : { ...input.retry, maxRetries: 0 };
	const retried = await withGitHubRetry(async () => {
		// Keep this signal attached after headers: successful body parsing belongs to the caller.
		const signal = AbortSignal.timeout(input.requestTimeoutMs ?? 30_000);
		let res: Response;
		try {
			res = await fetchImpl(input.url, { ...init, signal });
		} catch (err) {
			return {
				ok: false,
				error: networkError(signal.aborted ? new Error("request timed out") : err, input.context),
			};
		}
		if (!res.ok) {
			const text = truncate(await readText(res), ERROR_BODY_MAX_CHARS);
			return {
				ok: false,
				error: classifyGitHubHttpError(res.status, res.headers, text, input.context),
			};
		}
		return { ok: true, value: res };
	}, retry);
	if (!retried.ok) return retried;
	return { ok: true, response: retried.value };
}
