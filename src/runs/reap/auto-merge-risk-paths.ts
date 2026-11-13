/** Baseline risk zones from the factory design; project rules can only add to them. */
export const MANDATORY_REVIEW_PATHS: readonly string[] = [
	"**/.github/**",
	"**/.gitlab-ci*",
	"**/.circleci/**",
	"**/AGENTS.md",
	"**/CLAUDE.md",
	"**/.agents/**",
	"**/.claude/**",
	"**/.warren/defaults.json",
	"**/burrow.toml",
	"**/scripts/**",
	"**/deploy/**",
	"**/deployment/**",
	"**/deploy.*",
	"**/deploy-*",
	"**/infra/**",
	"**/infrastructure/**",
	"**/*.tf",
	"**/vercel.json",
	"**/fly.toml",
	"**/render.yaml",
	"**/.gitmodules",
	"**/Dockerfile*",
	"**/docker-compose*",
	"**/compose.yml",
	"**/compose.yaml",
	"**/compose.*.yml",
	"**/compose.*.yaml",
	"**/nginx*",
	"**/nginx*/**",
	"**/migrations/**",
	"**/migration/**",
	"**/prisma/**",
	"**/auth/**",
	"**/auth.*",
	"**/auth-*",
	"**/authentication.*",
	"**/authorization.*",
	"**/payment/**",
	"**/payments/**",
	"**/payment.*",
	"**/payments.*",
	"**/payment-*",
	"**/billing/**",
	"**/package.json",
	"**/bun.lock*",
	"**/package-lock.json",
	"**/pnpm-lock.yaml",
	"**/yarn.lock",
	"**/Makefile",
	"**/makefile",
	"**/GNUmakefile",
	"**/Justfile",
	"**/justfile",
	"**/Taskfile*",
	"**/pyproject.toml",
	"**/Cargo.toml",
	"**/go.mod",
];

/**
 * Protect literal repository paths mentioned by the trusted base's gate.
 * This is lexical inspection, never shell execution. Indirect scripts and
 * project-specific security code still belong in explicit protectedPaths.
 */
export function qualityGateProtectedPaths(command: string): string[] {
	const paths = new Set<string>();
	for (const token of command.matchAll(/"([^"\n]+)"|'([^'\n]+)'|([^\s;&|()<>]+)/g)) {
		const value = (token[1] ?? token[2] ?? token[3] ?? "").replace(/^\.\//, "");
		const isLocalPath = value.includes("/") || /\.(sh|bash|py|js|ts|mjs|cjs)$/.test(value);
		if (!isLocalPath || value.startsWith("/") || value.startsWith("-")) continue;
		if (/[$`*?[\\]/.test(value) || value.split("/").includes("..")) continue;
		paths.add(value);
	}
	return [...paths];
}
