import { expect, test } from "bun:test";
import { missingToolkitFiles } from "./check-package-toolkit.ts";

test("rejects an archive that contains runtime code but omits its shared catalog", () => {
	expect(
		missingToolkitFiles(["src/toolkit/graphify-mcp.ts", "src/sandbox/process-guardian.ts"]),
	).toContain("factory/toolkit/catalog.json");
});
