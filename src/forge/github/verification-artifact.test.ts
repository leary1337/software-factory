import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readVerificationArtifact } from "./verification-artifact.ts";

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "proof-test-"));
	await writeFile(join(root, "factory-verification.json"), JSON.stringify({ sha: "a".repeat(40) }));
	execFileSync("zip", ["-q", "artifact.zip", "factory-verification.json"], { cwd: root });
	const bytes = await readFile(join(root, "artifact.zip"));
	return {
		root,
		bytes,
		artifact: {
			id: 8,
			name: "factory-verification",
			expired: false,
			size_in_bytes: bytes.length,
			digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
			workflow_run: { id: 7 },
		},
	};
}

describe("workflow verification artifact", () => {
	test("reads digest-verified evidence and strips authentication from the storage redirect", async () => {
		const f = await fixture();
		const calls: { url: string; authorization: string | null }[] = [];
		try {
			const fetcher = (async (url: string, options?: RequestInit) => {
				calls.push({ url, authorization: new Headers(options?.headers).get("authorization") });
				if (url.includes("/runs/")) return Response.json({ artifacts: [f.artifact] });
				if (url.endsWith("/zip"))
					return new Response(null, {
						status: 302,
						headers: { location: "https://storage.test/temporary" },
					});
				return new Response(f.bytes);
			}) as unknown as typeof fetch;
			const result = await readVerificationArtifact({
				slug: "o/r",
				runId: 7,
				artifactName: "factory-verification",
				token: "private-token",
				fetch: fetcher,
			});
			expect(result).toEqual({ ok: true, value: { sha: "a".repeat(40) } });
			expect(calls[0]?.authorization).toBe("Bearer private-token");
			expect(calls[2]?.authorization).toBeNull();
		} finally {
			await rm(f.root, { recursive: true, force: true });
		}
	});
	test("rejects stale, foreign, oversized and corrupted artifacts", async () => {
		const f = await fixture();
		try {
			for (const patch of [
				{ expired: true },
				{ workflow_run: { id: 9 } },
				{ size_in_bytes: 2_000_000 },
				{ digest: `sha256:${"b".repeat(64)}` },
			]) {
				const fetcher = (async (url: string) =>
					url.includes("/runs/")
						? Response.json({ artifacts: [{ ...f.artifact, ...patch }] })
						: new Response(f.bytes)) as unknown as typeof fetch;
				const result = await readVerificationArtifact({
					slug: "o/r",
					runId: 7,
					artifactName: "factory-verification",
					token: "private-token",
					fetch: fetcher,
				});
				expect(result.ok).toBe(false);
				expect(JSON.stringify(result)).not.toContain("private-token");
			}
		} finally {
			await rm(f.root, { recursive: true, force: true });
		}
	});
});
