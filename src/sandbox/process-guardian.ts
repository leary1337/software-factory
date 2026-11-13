/** Host-owned guardian: IPC disconnect stops the entire sandbox process group. */
import { rename, writeFile } from "node:fs/promises";

interface StartMessage {
	argv: string[];
	cwd: string;
	env: Record<string, string>;
}

const marker = process.argv[2];
let child: Bun.Subprocess | undefined;
let stopping = false;
let markerWrite = Promise.resolve();

function mark(state: "running" | "stopped"): Promise<void> {
	markerWrite = markerWrite.then(async () => {
		if (!marker) return;
		const temporary = `${marker}.tmp`;
		await writeFile(temporary, JSON.stringify({ state }), { mode: 0o600 });
		await rename(temporary, marker);
	});
	return markerWrite;
}

function killGroup(): void {
	if (!child) return;
	try {
		process.kill(-child.pid, "SIGKILL");
	} catch {
		// The process group already exited.
	}
}

async function stop(code: number): Promise<void> {
	if (stopping) return;
	stopping = true;
	killGroup();
	await child?.exited;
	await mark("stopped");
	process.exit(code);
}

process.on("disconnect", () => void stop(137));
process.on("SIGTERM", () => void stop(143));
process.on("SIGINT", () => void stop(130));
process.on("message", async (message: StartMessage | "cancel") => {
	if (message === "cancel") return void stop(137);
	if (child || stopping) return;
	try {
		await mark("running");
		if (stopping) return;
		child = Bun.spawn(message.argv, {
			cwd: message.cwd,
			env: message.env,
			detached: true,
			stdin: "inherit",
			stdout: "inherit",
			stderr: "inherit",
		});
		process.send?.({ pid: child.pid });
		await stop(await child.exited);
	} catch {
		await stop(1);
	}
});
