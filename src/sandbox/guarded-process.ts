import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

/** Keep agent stdin separate from the lifetime channel, including stdin-held harnesses. */
export async function spawnGuardedProcess(input: {
	argv: string[];
	cwd: string;
	env: Record<string, string>;
	stdin: "pipe" | "ignore";
	lifecyclePath?: string;
}) {
	// Persist before spawning: restart must not mistake a starting guardian for no child.
	if (input.lifecyclePath)
		await writeFile(input.lifecyclePath, JSON.stringify({ state: "starting" }), { mode: 0o600 });
	const ready = Promise.withResolvers<number>();
	const proc = Bun.spawn(
		[
			process.execPath,
			fileURLToPath(new URL("./process-guardian.ts", import.meta.url)),
			input.lifecyclePath ?? "",
		],
		{
			cwd: input.cwd,
			env: input.env,
			stdin: input.stdin,
			stdout: "pipe",
			stderr: "pipe",
			ipc(message: unknown) {
				if (
					message &&
					typeof message === "object" &&
					"pid" in message &&
					typeof message.pid === "number"
				)
					ready.resolve(message.pid);
			},
		},
	);
	void proc.exited.then(() => ready.reject(new Error("sandbox guardian exited before spawn")));
	proc.send({ argv: input.argv, cwd: input.cwd, env: input.env });
	const pid = await ready.promise;
	return {
		proc,
		pid,
		cancel: () => {
			if (proc.exitCode === null) proc.send("cancel");
		},
	};
}

/** A restarted owner must wait until the guardian has stopped all workspace writers. */
export async function waitForSandboxStop(lifecyclePath: string): Promise<void> {
	for (let i = 0; i < 250; i++) {
		let state: string;
		try {
			state = await readFile(lifecyclePath, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
			throw error;
		}
		if ((JSON.parse(state) as { state?: string }).state === "stopped") return;
		await Bun.sleep(20);
	}
	throw new Error("Sandbox shutdown is unconfirmed; preserving the workspace for recovery");
}
