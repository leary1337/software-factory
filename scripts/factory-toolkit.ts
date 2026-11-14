import { Command } from "commander";
import { enrollPersonalToolkit } from "../src/toolkit/distribution.ts";
import { installPersonalMcp } from "../src/toolkit/install.ts";
import { probeFreeRemote } from "../src/toolkit/remote.ts";
import { activeToolkitVersion } from "../src/toolkit/versions.ts";

const program = new Command().description("Inspect and deliver the shared free MCP catalog");
program
	.command("install")
	.requiredOption("--home <path>", "explicit personal home")
	.option("--apply", "apply after preflight; default is read-only")
	.action(async (options: { home: string; apply?: boolean }) =>
		console.log(JSON.stringify(await installPersonalMcp(options.home, options.apply))),
	);
program
	.command("enroll")
	.requiredOption("--home <path>", "explicit personal home")
	.action(async (options: { home: string }) => {
		const version = await activeToolkitVersion();
		await enrollPersonalToolkit(options.home, version);
		console.log(JSON.stringify({ version, enrolled: true }));
	});
program
	.command("doctor")
	.action(async () =>
		console.log(
			JSON.stringify(await Promise.all([probeFreeRemote("exa"), probeFreeRemote("context7")])),
		),
	);
try {
	await program.parseAsync();
} catch (error) {
	console.error(error instanceof Error ? error.message : "Toolkit operation failed");
	process.exitCode = 1;
}
