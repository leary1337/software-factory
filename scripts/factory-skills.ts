import { Command } from "commander";
import { installSkillCatalog } from "../src/runtime/local/skill-install.ts";

const command = new Command()
	.description("Inspect or install the versioned factory skills into an explicit home")
	.requiredOption("--home <directory>", "target home; never inferred from this process")
	.requiredOption("--format <format>", "agents (Codex) or claude (Claude Code)")
	.option("--audience <audience>", "personal or factory", "personal")
	.option("--pack <directory>", "alternate skill catalog root")
	.option("--apply", "apply the inspected catalog; default is read-only")
	.action(
		async (options: {
			home: string;
			format: string;
			audience: string;
			pack?: string;
			apply?: boolean;
		}) => {
			if (options.format !== "agents" && options.format !== "claude")
				throw new Error("format must be agents or claude");
			if (options.audience !== "personal" && options.audience !== "factory")
				throw new Error("audience must be personal or factory");
			const result = await installSkillCatalog({
				homePath: options.home,
				format: options.format,
				audience: options.audience,
				packDir: options.pack,
				apply: options.apply,
			});
			console.log(JSON.stringify(result));
			if (result.conflicts.length) process.exitCode = 1;
		},
	);

try {
	await command.parseAsync(process.argv);
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
}
