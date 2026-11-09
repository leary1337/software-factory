import { describe, expect, test } from "bun:test";
import type { ReapExec, ReapFs } from "../runs/reap/types.ts";
import { DockerProvider } from "./docker/provider.ts";
import { UnknownRuntimeError } from "./errors.ts";
import { LocalProvider } from "./local/provider.ts";
import {
	DEFAULT_RUNTIME_KIND,
	type RuntimeProviderDeps,
	resolveRuntimeKind,
	resolveRuntimeProvider,
} from "./registry.ts";

const deps: RuntimeProviderDeps = {};

describe("resolveRuntimeKind", () => {
	test("defaults to local when WARREN_RUNTIME is unset", () => {
		expect(resolveRuntimeKind({})).toBe("local");
		expect(DEFAULT_RUNTIME_KIND).toBe("local");
	});

	test("treats a blank / whitespace value as unset (default local)", () => {
		expect(resolveRuntimeKind({ WARREN_RUNTIME: "" })).toBe("local");
		expect(resolveRuntimeKind({ WARREN_RUNTIME: "   " })).toBe("local");
	});

	test("accepts the explicit local selector", () => {
		expect(resolveRuntimeKind({ WARREN_RUNTIME: "local" })).toBe("local");
	});

	test("accepts the docker selector (warren-3732, sibling containers)", () => {
		expect(resolveRuntimeKind({ WARREN_RUNTIME: "docker" })).toBe("docker");
	});

	test("fails loudly on an unknown value rather than falling back", () => {
		expect(() => resolveRuntimeKind({ WARREN_RUNTIME: "nomad" })).toThrow(UnknownRuntimeError);
	});
});

describe("resolveRuntimeProvider", () => {
	test("resolves LocalProvider by default", () => {
		const provider = resolveRuntimeProvider(deps, {});
		expect(provider).toBeInstanceOf(LocalProvider);
	});

	test("resolves LocalProvider for explicit WARREN_RUNTIME=local", () => {
		const provider = resolveRuntimeProvider(deps, { WARREN_RUNTIME: "local" });
		expect(provider).toBeInstanceOf(LocalProvider);
	});

	test("accepts the LocalProvider fs/exec seam so reap's fallback can route through the registry", () => {
		// warren-aa4a: the reap pipeline's fallback resolves through
		// `resolveRuntimeProvider({ fs, exec })` instead of constructing a
		// LocalProvider inline. The fs/exec slices are LocalProvider-only
		// (finalize's disk/shell seam) and must not disturb resolution.
		const fs: ReapFs = {
			mkdirp: () => Promise.resolve(),
			readFile: () => Promise.resolve(null),
			writeFile: () => Promise.resolve(),
			readdir: () => Promise.resolve([]),
		};
		const exec: ReapExec = {
			run: () => Promise.resolve({ stdout: "", stderr: "" }),
		};
		const provider = resolveRuntimeProvider({ ...deps, fs, exec }, {});
		expect(provider).toBeInstanceOf(LocalProvider);
	});

	test("advertises the full local capability set", () => {
		const provider = resolveRuntimeProvider(deps, {});
		expect(provider.capabilities).toEqual({
			previewPorts: true,
			networkPolicy: "domain-allowlist",
			longLived: true,
			midRunSteering: true,
			enforcedResourceLimits: true,
			workspaceArchive: true,
			workspaceGc: true,
		});
	});

	test("resolves DockerProvider for WARREN_RUNTIME=docker (warren-3732)", () => {
		const provider = resolveRuntimeProvider(deps, { WARREN_RUNTIME: "docker" });
		expect(provider).toBeInstanceOf(DockerProvider);
	});

	test("DockerProvider advertises the honest docker v1 capability set", () => {
		const provider = resolveRuntimeProvider(deps, { WARREN_RUNTIME: "docker" });
		expect(provider.capabilities).toEqual({
			previewPorts: false,
			networkPolicy: "coarse",
			longLived: true,
			midRunSteering: true,
			enforcedResourceLimits: true,
			workspaceArchive: false,
			workspaceGc: true,
		});
	});

	test("garbage selector throws UnknownRuntimeError", () => {
		expect(() => resolveRuntimeProvider(deps, { WARREN_RUNTIME: "nomad" })).toThrow(
			UnknownRuntimeError,
		);
		expect(() => resolveRuntimeProvider(deps, { WARREN_RUNTIME: "nomad" })).toThrow(/nomad/);
	});
});
