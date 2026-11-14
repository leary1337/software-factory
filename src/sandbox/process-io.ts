import { join } from "node:path";
import type { SpawnCommand } from "./types.ts";

export async function writeStringStdin(
	proc: Bun.Subprocess,
	stdin: SpawnCommand["stdin"],
	holdStdin: boolean,
): Promise<void> {
	if (typeof stdin !== "string") return;
	const sink = proc.stdin;
	if (!sink || typeof sink === "number") return;
	sink.write(new TextEncoder().encode(stdin));
	// When holdStdin=true the else branch never runs, and sink.write() alone
	// only buffers in bun's userland — the bytes never reach the kernel pipe,
	// so the child blocks forever on its initial read (burrow-029d). Flush
	// explicitly to push the prompt through before we hand control back.
	if (holdStdin) await sink.flush();
	else await sink.end();
}

export function makeCloseStdin(proc: Bun.Subprocess): () => Promise<void> {
	let closed = false;
	return async () => {
		if (closed) return;
		closed = true;
		const sink = proc.stdin;
		if (!sink || typeof sink === "number") return;
		await sink.end();
	};
}

export function makeWriteStdin(proc: Bun.Subprocess): (chunk: string) => Promise<void> {
	const encoder = new TextEncoder();
	return async (chunk: string) => {
		const sink = proc.stdin;
		if (!sink || typeof sink === "number") {
			throw new Error("sandbox: child stdin is not writable");
		}
		sink.write(encoder.encode(chunk));
		// `flush()` returns a promise that resolves when the kernel buffer
		// has drained — guarantees the bytes reach the child before this
		// helper returns so callers can sequence subsequent writes against
		// observed output.
		await sink.flush();
	};
}

export function resolveCwd(workspace: string, cwd: string | undefined): string {
	if (!cwd) return workspace;
	if (cwd.startsWith("/")) return cwd;
	return join(workspace, cwd);
}
