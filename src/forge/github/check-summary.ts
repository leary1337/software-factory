import type { CheckRun, CheckSummary, ForgeError, ForgeResult } from "../contract.ts";
import { toForgeError } from "./errors.ts";
import { requestGitHub } from "./http.ts";
import { parseCheckRun, readJson, rollUp } from "./readers.ts";

const error = (error: ForgeError): ForgeResult<never> => ({ ok: false, error });
const success = (value: CheckSummary): ForgeResult<CheckSummary> => ({ ok: true, value });
/** Legacy CI display rollup; reviewed merge uses the stricter complete reader. */
export async function readCheckSummary(input: {
	enabled: boolean;
	mint: () => Promise<ForgeResult<{ secret: string }>>;
	url: string;
	fetch: typeof fetch;
}): Promise<ForgeResult<CheckSummary>> {
	if (!input.enabled) {
		return error({
			kind: "unsupported",
			detail:
				"capabilities.checkRuns is false (fine-grained PAT cannot reach the Checks API — §5/§6.7)",
		});
	}
	const minted = await input.mint();
	if (!minted.ok) return error(minted.error);
	const result = await requestGitHub({
		url: `${input.url}/check-runs?per_page=100`,
		method: "GET",
		token: minted.value.secret,
		userAgent: "warren-forge-github",
		context: "GET /check-runs",
		fetch: input.fetch,
	});
	if (!result.ok) return error(toForgeError(result.error));
	const body = (await readJson(result.response)) as { check_runs?: unknown } | null;
	const raw = Array.isArray(body?.check_runs) ? body.check_runs : [];
	const runs = raw.map(parseCheckRun).filter((r): r is CheckRun => r !== null);
	return success({ conclusion: rollUp(runs), runs });
}
