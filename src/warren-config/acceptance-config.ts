import { z } from "zod";

const artifactPath = z
	.string()
	.min(1)
	.max(500)
	.refine(
		(path) =>
			!path.startsWith("/") &&
			!path.includes("\\") &&
			path.split("/").every((part) => part !== ".." && part !== "." && part !== ""),
		"artifacts must be relative file paths without traversal",
	);

export const AcceptanceConfigSchema = z
	.object({
		enforce: z.boolean().default(false),
		requireBrowser: z.boolean().default(false),
		checks: z
			.array(
				z
					.object({
						id: z
							.string()
							.regex(/^[a-z0-9][a-z0-9-]*$/)
							.max(80),
						command: z.string().trim().min(1).max(4000),
						browser: z.boolean().default(false),
						artifacts: z.array(artifactPath).max(4).default([]),
					})
					.strict(),
			)
			.max(20)
			.default([]),
	})
	.strict()
	.refine(
		(policy) => new Set(policy.checks.map((check) => check.id)).size === policy.checks.length,
		"acceptance check ids must be unique",
	);
