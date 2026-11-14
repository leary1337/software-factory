/** GraphQL envelope interpretation over the shared bounded, non-retrying POST transport. */
import type { GitHubHttpError } from "./errors.ts";
import { GITHUB_API_BASE } from "./headers.ts";
import { type GitHubRequestInput, requestGitHub } from "./http.ts";
import { readJson } from "./readers.ts";

/** The GraphQL endpoint, derived from the same base the REST transport uses. */
export const GITHUB_GRAPHQL_URL = `${GITHUB_API_BASE}/graphql`;

/** One GraphQL API error, as GitHub returns it inside the 200 envelope. */
export interface GitHubGraphQLError {
	readonly message: string;
	readonly type?: string;
}

/** One GraphQL failure: an HTTP-level error, or a 200 with a non-empty `errors` array. */
export type GitHubGraphQLFailure =
	| { readonly kind: "http"; readonly error: GitHubHttpError }
	| { readonly kind: "graphql"; readonly errors: readonly GitHubGraphQLError[] };

export type GitHubGraphQLResult =
	| { readonly ok: true; readonly data: unknown }
	| { readonly ok: false; readonly error: GitHubGraphQLFailure };

export interface GitHubGraphQLRequestInput
	extends Omit<GitHubRequestInput, "url" | "method" | "body"> {
	/** The GraphQL document. POSTs never retry: a received mutation may already have succeeded. */
	readonly query: string;
	/** JSON-serializable variables; omitted when undefined. */
	readonly variables?: unknown;
}

/** Narrow one raw `errors` row to `{message, type}`; a row without a message string drops. */
function parseGraphQLError(raw: unknown): GitHubGraphQLError | null {
	if (typeof raw !== "object" || raw === null) return null;
	const obj = raw as Record<string, unknown>;
	if (typeof obj.message !== "string") return null;
	return typeof obj.type === "string"
		? { message: obj.message, type: obj.type }
		: { message: obj.message };
}

/** Preserve GraphQL semantic errors while sharing HTTP deadlines and mutation reconciliation. */
export async function requestGitHubGraphQL(
	input: GitHubGraphQLRequestInput,
): Promise<GitHubGraphQLResult> {
	const { query, variables, ...transport } = input;
	const result = await requestGitHub({
		...transport,
		url: GITHUB_GRAPHQL_URL,
		method: "POST",
		body: { query, ...(variables !== undefined ? { variables } : {}) },
	});
	if (!result.ok) return { ok: false, error: { kind: "http", error: result.error } };
	const body = (await readJson(result.response)) as { data?: unknown; errors?: unknown } | null;
	if (body === null) {
		return {
			ok: false,
			error: {
				kind: "http",
				error: {
					kind: "http_error",
					status: 200,
					retryAfterMs: null,
					message: `${input.context} returned an unreadable body`,
				},
			},
		};
	}
	const rawErrors = Array.isArray(body.errors) ? body.errors : [];
	if (rawErrors.length > 0) {
		const errors = rawErrors
			.map(parseGraphQLError)
			.filter((e): e is GitHubGraphQLError => e !== null);
		return { ok: false, error: { kind: "graphql", errors } };
	}
	return { ok: true, data: body.data };
}
