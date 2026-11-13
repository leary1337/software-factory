import { describe, expect, test } from "bun:test";
import { parseBaseAutoMergeConfig } from "./auto-merge-git.ts";
import { decideAutoMerge } from "./auto-merge-policy.ts";
import { qualityGateProtectedPaths } from "./auto-merge-risk-paths.ts";

function decision(path: string, raw = "pr:\n  autoMerge: {}\n") {
	return decideAutoMerge({
		config: parseBaseAutoMergeConfig(raw),
		changedPaths: { kind: "changed", paths: [path] },
		forgeCanArm: true,
		ciFixerRun: false,
	});
}

describe("factory risk protection", () => {
	test.each([
		".github/workflows/deploy.yml",
		"services/api/scripts/check.sh",
		"scripts/deploy.sh",
		"deploy.sh",
		"deploy/production.yaml",
		"infra/main.tf",
		"services/api/Dockerfile",
		"docker-compose.prod.yml",
		"compose.override.yaml",
		"nginx.conf",
		"infra/nginx/sites/default",
		"db/migrations/001.sql",
		"prisma/schema.prisma",
		"src/api/auth.ts",
		"src/auth/session.ts",
		"src/auth-controller.ts",
		"src/payments/charge.ts",
		"src/payment-service.ts",
		"src/billing/invoice.ts",
		"package.json",
		"ui/package-lock.json",
		"Makefile",
		"CLAUDE.md",
		".agents/skills/review/SKILL.md",
		".gitmodules",
	])("requires review for %s even with an empty project list", (path) => {
		expect(decision(path)).toEqual({ decision: "skip", reason: "protected_path", paths: [path] });
	});

	test("keeps ordinary implementation eligible and project additions additive", () => {
		expect(decision("src/author/profile.ts")).toEqual({ decision: "arm", method: "squash" });
		const config = "pr:\n  autoMerge:\n    protectedPaths: [src/custom-security/]\n";
		expect(decision("src/custom-security/token.ts", config).decision).toBe("skip");
		expect(decision("scripts/check.sh", config).decision).toBe("skip");
	});

	test("protects gate files read from the base config without executing shell text", () => {
		const command = 'bash "validation scripts/check.sh" && bun tools/verify.ts && bash verify.sh';
		expect(qualityGateProtectedPaths(command)).toEqual([
			"validation scripts/check.sh",
			"tools/verify.ts",
			"verify.sh",
		]);
		const config = `qualityGate: ${JSON.stringify(command)}\npr:\n  autoMerge: {}\n`;
		expect(decision("tools/verify.ts", config).decision).toBe("skip");
		expect(decision("validation scripts/check.sh", config).decision).toBe("skip");
	});

	test("fails closed when the base gate has an invalid shape", () => {
		expect(decision("src/file.ts", "qualityGate: []\npr:\n  autoMerge: {}\n")).toEqual({
			decision: "skip",
			reason: "off",
		});
	});
});
