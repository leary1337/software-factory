import type { ReleaseVerification } from "../core/release.ts";
import { verifyWorkflowRelease, type WorkflowProofContext } from "./release-workflow-proof.ts";

async function read(url: string, timeoutMs: number, fetchImpl: typeof fetch): Promise<string> {
	const response = await fetchImpl(url, {
		method: "GET",
		redirect: "error",
		signal: AbortSignal.timeout(timeoutMs),
		headers: { "User-Agent": "software-factory-verification" },
	});
	if (!response.ok) {
		await response.body?.cancel();
		throw new Error(`Application check returned HTTP ${response.status}`);
	}
	const reader = response.body?.getReader();
	if (!reader) return "";
	let body = "";
	const decoder = new TextDecoder();
	try {
		while (true) {
			const part = await reader.read();
			if (part.done) break;
			body += decoder.decode(part.value, { stream: true });
			if (body.length > 1_000_000) throw new Error("Application check response is too large");
		}
		return body + decoder.decode();
	} finally {
		await reader.cancel();
	}
}
function version(body: string, field: string | undefined): unknown {
	if (!field) return body.trim();
	let value: unknown = JSON.parse(body);
	for (const part of field.split(".")) {
		if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
		value = (value as Record<string, unknown>)[part];
	}
	return value;
}
/** HTTP availability alone cannot establish the approved user scenario or deployed version. */
export async function verifyRelease(input: {
	sha: string;
	workflow?: WorkflowProofContext;
	smokeUrl: string;
	verification: ReleaseVerification;
	timeoutMs: number;
	fetch?: typeof fetch;
}) {
	if (input.verification.artifactName) {
		if (!input.workflow) throw new Error("Workflow verification requires a matched deployment run");
		return verifyWorkflowRelease({ ...input, workflow: input.workflow });
	}
	const fetchImpl = input.fetch ?? fetch;
	await read(input.smokeUrl, input.timeoutMs, fetchImpl);
	const observed = version(
		await read(input.verification.versionUrl, input.timeoutMs, fetchImpl),
		input.verification.shaField,
	);
	if (observed !== input.sha)
		throw new Error("Application version does not match the exact released commit");
	const page = await read(input.verification.scenarioUrl, input.timeoutMs, fetchImpl);
	if (!page.includes(input.verification.expectedText))
		throw new Error("The approved read-only application scenario failed");
	return { sha: input.sha, availability: true, version: true, scenario: true };
}
