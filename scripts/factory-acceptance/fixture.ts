import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { dump } from "js-yaml";
import { defaultSpawn } from "../../src/projects/clone.ts";
import { fixtureGitOrThrow as git } from "../../src/workspace/git/test-fixture.ts";
export const UPDATED_AT = "2026-11-14T12:00:00Z";
export async function createFixture() {
	const root = await realpath(await mkdtemp(join(tmpdir(), "factory-real-plan-")));
	const remote = join(root, "remote.git");
	const host = join(root, "host");
	await git(root, ["init", "--bare", "-b", "main", remote]);
	await git(root, ["clone", remote, host]);
	const probe = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch: () => new Response("reserved"),
	});
	const port = probe.port;
	await probe.stop(true);
	const base = `http://127.0.0.1:${port}`;
	const settings = {
		qualityGate: "bun test --timeout 20000",
		preparation: { recipe: "javascript" },
		executionProfiles: {
			implementation: { runtime: "codex", model: "gpt-6.1-sol" },
			review: { runtime: "codex", model: "gpt-6.1-sol" },
		},
		repoContext:
			"This is an isolated acceptance fixture. Work only on the requested application files. Run bun test. UI review: run bun run browser-check.ts against the actual rendered app; Chrome is installed. Never change .warren settings, workflow, README or browser-check.ts; do not skip hooks or checks. All Git remotes are local bare fixtures.",
		pr: { autoMerge: { method: "merge" } },
		deploy: {
			autoDeploy: true,
			workflow: "deploy.yml",
			shaInput: "factory_sha",
			smokeUrl: `${base}/healthz`,
			timeoutMs: 120000,
			smokeTimeoutMs: 10000,
			verification: {
				versionUrl: `${base}/version`,
				shaField: "sha",
				scenarioUrl: `${base}/`,
				expectedText: "Verified fixture release",
			},
		},
		taskBudgets: {
			repairs: 2,
			reworks: 3,
			runMs: 900000,
			activeMs: 3600000,
			externalWaitMs: 300000,
		},
	};
	const files: Record<string, string> = {
		".gitignore": "node_modules/\n.artifacts/\n",
		"package.json": JSON.stringify(
			{
				name: "factory-real-acceptance",
				private: true,
				type: "module",
				packageManager: `bun@${Bun.version}`,
				dependencies: { "fixture-value": "file:./packages/value-v1" },
				devDependencies: { "@playwright/test": "1.64.0" },
			},
			null,
			2,
		),
		"packages/value-v1/package.json": JSON.stringify({
			name: "fixture-value",
			version: "1.0.0",
			type: "module",
			exports: "./index.js",
		}),
		"packages/value-v1/index.js": "export const multiplier = 2;\n",
		"packages/value-v2/package.json": JSON.stringify({
			name: "fixture-value",
			version: "2.0.0",
			type: "module",
			exports: "./index.js",
		}),
		"packages/value-v2/index.js": "export const multiplier = 3;\n",
		"src/ui/dashboard.ts":
			'export function dashboard() { return \'<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Fixture</title></head><body><main><h1>Fixture application</h1><p>Awaiting an approved release.</p></main></body></html>\'; }\n',
		"src/app.ts":
			"import { dashboard } from './ui/dashboard.ts';\nexport function app(request: Request) { const path = new URL(request.url).pathname; if(path === '/healthz') return Response.json({status:'ok'}); if(path === '/version') return Response.json({sha:process.env.APP_SHA ?? 'development'}); return new Response(dashboard(),{headers:{'content-type':'text/html'}}); }\n",
		"src/app.test.ts":
			"import {test,expect} from 'bun:test'; import {app} from './app.ts'; test('serves a healthy application',async()=>{expect((await app(new Request('http://fixture/healthz')).json()).status).toBe('ok'); expect(app(new Request('http://fixture/')).status).toBe(200);});\n",
		"server.ts":
			"import {app} from './src/app.ts'; const server=Bun.serve({hostname:'127.0.0.1',port:Number(process.env.PORT??0),fetch:app}); console.log('LISTENING '+server.port);\n",
		"browser-check.ts": `import {chromium} from '@playwright/test'; import {app} from './src/app.ts'; const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch:app}); const browser=await chromium.launch({channel:'chrome',headless:true}); try {for(const width of [393,1440]){const page=await browser.newPage({viewport:{width,height:900}});await page.goto('http://127.0.0.1:'+server.port);if(await page.locator('h1').count()!==1)throw new Error('Exactly one heading required');if(await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth))throw new Error('Horizontal overflow');const content=await page.locator('main').innerText();if(content.includes('Verified fixture release')&&(!content.includes('12')||!content.includes('${UPDATED_AT}')))throw new Error('Release content missing');console.log(JSON.stringify({width,heading:await page.locator('h1').innerText(),overflow:false}));await page.close();}}finally{await browser.close();await server.stop(true);}\n`,
		"README.md":
			"# Isolated factory acceptance fixture\n\nInstall: bun install --frozen-lockfile. Gate: bun test. Browser validation: bun run browser-check.ts (installed Google Chrome, fresh contexts, phone and desktop). Run the documented browser check for UI review. Browser script is verification infrastructure and must not be modified by application tasks.\n",
		".warren/config.yaml": dump(settings, { lineWidth: 100, noRefs: true }),
		".github/workflows/deploy.yml": `run-name: Factory deploy \${{ inputs.factory_sha }}\non:\n  workflow_dispatch:\n    inputs:\n      factory_sha:\n        required: true\njobs:\n  deploy:\n    steps:\n      - uses: actions/checkout@v4\n        with:\n          ref: \${{ inputs.factory_sha }}\n`,
	};
	for (const [path, content] of Object.entries(files)) {
		await mkdir(dirname(join(host, path)), { recursive: true });
		await writeFile(join(host, path), content);
	}
	const installed = await defaultSpawn([Bun.which("bun") ?? process.execPath, "install"], {
		cwd: host,
		timeoutMs: 120000,
	});
	if (installed.exitCode) throw new Error(`Fixture install failed: ${installed.stderr}`);
	await git(host, ["add", "."]);
	await git(host, [
		"-c",
		"user.name=Factory Acceptance",
		"-c",
		"user.email=acceptance@example.invalid",
		"commit",
		"-m",
		"fixture baseline",
	]);
	await git(host, ["push", "origin", "main"]);
	return {
		root,
		remote,
		host,
		base,
		port,
		settings,
		initialSha: (await git(host, ["rev-parse", "HEAD"])).stdout.trim(),
	};
}
export const TASKS = [
	{
		title: "Implement scoring using the existing dependency",
		description:
			"Add src/score.ts exporting score(points:number). Reject non-finite input; otherwise return Math.max(0,Math.trunc(points))*multiplier imported from fixture-value. Add meaningful Bun tests for positive, fractional, negative and invalid values. Existing dependency multiplier is2, so score(4)=8. Do not modify application UI or the dependency yet.",
		acceptance: [
			"score(4) equals8 and negative scores clamp tozero",
			"Non-finite input is rejected and fractional input truncates",
			"Existing tests and new scoring tests pass",
		],
	},
	{
		title: "Upgrade the locked fixture dependency",
		description:
			"Change the existing fixture-value dependency in package.json from file:./packages/value-v1 to file:./packages/value-v2 and regenerate bun.lock using Bun. Preserve scoring logic. Update the scoring tests for multiplier3, so score(4)=12. Do not modify either bundled dependency package or the UI. Commit package.json, bun.lock and the necessary scoring test expectations.",
		acceptance: [
			"The existing package manager and frozen lockfile install version2",
			"score(4) equals12 after an independent clean install",
			"Scoring edge cases remain tested",
		],
	},
	{
		title: "Render the verified application status",
		description: `Update src/ui/dashboard.ts to render one h1 'Verified fixture release', the calculated score for4 (12) using src/score.ts, and text 'Last data update: ${UPDATED_AT}'. Use a semantic main with clear labels and accessible responsive markup. Add a meaningful test covering the returned HTML. Run bun test and bun run browser-check.ts. Keep workflow, .warren configuration and browser verification infrastructure unchanged.`,
		acceptance: [
			"Rendered page shows Verified fixture release and score12",
			`Rendered page shows Last data update: ${UPDATED_AT}`,
			"Actual browser checks pass at393px and1440px without overflow",
		],
	},
];
