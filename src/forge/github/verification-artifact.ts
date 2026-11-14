import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { ForgeResult } from "../contract.ts";
import { buildGitHubHeaders, GITHUB_API_BASE } from "./headers.ts";

const Artifact = z.object({
	id: z.number().int().positive(),
	name: z.string(),
	expired: z.literal(false),
	size_in_bytes: z.number().int().min(1).max(1_000_000),
	digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
	workflow_run: z.object({ id: z.number().int().positive() }),
});
async function bytes(response: Response): Promise<Uint8Array> {
	if (!response.ok || !response.body) throw new Error("Artifact download failed");
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let length = 0;
	try {
		while (true) {
			const next = await reader.read();
			if (next.done) break;
			length += next.value.byteLength;
			if (length > 1_000_000) throw new Error("Verification artifact exceeds its limit");
			chunks.push(next.value);
		}
	} finally {
		await reader.cancel();
	}
	return Buffer.concat(chunks);
}

/** Only a small, digest-verified artifact from the already matched workflow run is accepted. */
export async function readVerificationArtifact(input: {
	slug: string;
	runId: number;
	artifactName: string;
	token: string;
	fetch?: typeof fetch;
}): Promise<ForgeResult<unknown>> {
	const fetchImpl = input.fetch ?? fetch;
	const base = `${GITHUB_API_BASE}/repos/${input.slug}`;
	try {
		const listed = await fetchImpl(`${base}/actions/runs/${input.runId}/artifacts?per_page=100`, {
			headers: buildGitHubHeaders(input.token),
			redirect: "error",
			signal: AbortSignal.timeout(30_000),
		});
		const body = JSON.parse(new TextDecoder().decode(await bytes(listed))) as {
			artifacts?: unknown[];
		};
		const matching = (body.artifacts ?? []).filter(
			(item) =>
				!!item && typeof item === "object" && "name" in item && item.name === input.artifactName,
		);
		if (matching.length !== 1) throw new Error("Expected one named verification artifact");
		const artifact = Artifact.parse(matching[0]);
		if (artifact.workflow_run.id !== input.runId)
			throw new Error("Artifact belongs to another workflow run");
		const first = await fetchImpl(`${base}/actions/artifacts/${artifact.id}/zip`, {
			headers: buildGitHubHeaders(input.token),
			redirect: "manual",
			signal: AbortSignal.timeout(30_000),
		});
		let response = first;
		if (first.status === 302) {
			const location = first.headers.get("location");
			if (!location || new URL(location).protocol !== "https:")
				throw new Error("Invalid artifact redirect");
			await first.body?.cancel();
			// Signed storage redirects must never receive the GitHub credential.
			response = await fetchImpl(location, {
				redirect: "error",
				signal: AbortSignal.timeout(30_000),
			});
		}
		const archive = await bytes(response);
		if (`sha256:${createHash("sha256").update(archive).digest("hex")}` !== artifact.digest)
			throw new Error("Artifact digest mismatch");
		const directory = await mkdtemp(join(tmpdir(), "factory-proof-"));
		try {
			const path = join(directory, "artifact.zip");
			await writeFile(path, archive, { mode: 0o600 });
			const text = execFileSync("unzip", ["-p", path, "factory-verification.json"], {
				encoding: "utf8",
				maxBuffer: 64_000,
				timeout: 5_000,
			});
			return { ok: true, value: JSON.parse(text) };
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	} catch {
		return {
			ok: false,
			error: {
				kind: "http_error",
				detail: "Cannot verify the workflow's application evidence artifact",
			},
		};
	}
}
