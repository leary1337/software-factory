import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { locateReadmeStatusVersion } from "../scripts/version-bump.ts";
import { VERSION } from "./index.ts";

const REPO_ROOT = resolve(import.meta.dir, "..");

function readVersionFromPackageJson(): string {
	const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, "package.json"), "utf8")) as {
		version?: string;
	};
	if (!pkg.version) throw new Error("package.json is missing a version field");
	return pkg.version;
}

/**
 * The README "Status" section carries a human-facing version tag of the
 * located by the release bumper. It is the same version surfaced by
 * package.json and src/index.ts, so it must never drift out of sync.
 */
function readVersionFromReadme(): string {
	const readme = readFileSync(resolve(REPO_ROOT, "README.md"), "utf8");
	return locateReadmeStatusVersion(readme).version;
}

describe("version sync", () => {
	test("keeps README, package.json, and src/index.ts on the same version", () => {
		const pkgVersion = readVersionFromPackageJson();
		const readmeVersion = readVersionFromReadme();
		expect(readmeVersion).toBe(pkgVersion);
		expect(VERSION).toBe(pkgVersion);
	});
});
