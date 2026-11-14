import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateDeploymentWorkflow } from "./deployment-workflow.ts";
import { prepareSetupWorkflow } from "./setup-workflow.ts";

test("proposes pinned manual delivery while preserving application release steps", async () => {
	const root = await mkdtemp(join(tmpdir(), "setup-workflow-"));
	try {
		await mkdir(join(root, ".github/workflows"), { recursive: true });
		const path = join(root, ".github/workflows/deploy.yml");
		await writeFile(
			path,
			`name: Deploy\non:\n  push:\n    branches: [main]\njobs:\n  deploy:\n    steps:\n      - uses: actions/checkout@v4\n      - run: ./deploy/release.sh $GITHUB_SHA \${GITHUB_SHA}\n`,
		);
		const config = { autoDeploy: true, shaInput: "factory_sha" };
		expect(await prepareSetupWorkflow(root, config)).toEqual([".github/workflows/deploy.yml"]);
		const source = await readFile(path, "utf8");
		expect(source).toContain("./deploy/release.sh");
		expect(source).toContain("FACTORY_RELEASE_SHA");
		expect(source).not.toContain("./deploy/release.sh $GITHUB_SHA");
		expect(source).not.toContain("push:");
		expect(validateDeploymentWorkflow(source, "factory_sha")).toBe(true);
		expect(await prepareSetupWorkflow(root, config)).toEqual([]);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("preserves long multiline command bodies through YAML round trip", async () => {
	const root = await mkdtemp(join(tmpdir(), "setup-workflow-long-"));
	try {
		await mkdir(join(root, ".github/workflows"), { recursive: true });
		const path = join(root, ".github/workflows/deploy.yml");
		const command = [
			'python3 -c \'import json; payload = {"release": "a-long-release-name", "ready": True}; print(payload["release"] if payload["ready"] else "application-is-not-ready")\'',
			"python3 -c 'import sys",
			'if not True or not {"generated_at": True}.get("generated_at") or not {"phase": True}.get("phase") or not {"short_gap_hours": True}.get("short_gap_hours") or any(',
			'    key in {} for key in ("schedule_error", "match_error")',
			"):",
			"    sys.exit(1)",
			"'",
			'printf "%s\\n" "$GITHUB_SHA"',
			'python3 -c \'import sys; print("a very long diagnostic message to ensure that YAML folding never inserts newlines inside this Python inline conditional" if len(sys.argv) == 1 else "unexpected")\'',
		].join("\n");
		await writeFile(
			path,
			`on: workflow_dispatch\njobs:\n  deploy:\n    steps:\n      - uses: actions/checkout@v4\n      - run: |-\n${command
				.split("\n")
				.map((line) => `          ${line}`)
				.join("\n")}\n`,
		);
		await prepareSetupWorkflow(root, { autoDeploy: true, shaInput: "factory_sha" });
		const parsed = Bun.YAML.parse(await readFile(path, "utf8")) as {
			jobs: { deploy: { steps: { run?: string }[] } };
		};
		expect(parsed.jobs.deploy.steps[1]?.run).toBe(
			'export GITHUB_SHA="$FACTORY_RELEASE_SHA"\n' +
				command.replaceAll("$GITHUB_SHA", `\${FACTORY_RELEASE_SHA}`),
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
