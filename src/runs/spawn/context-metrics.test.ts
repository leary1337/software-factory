import { describe, expect, test } from "bun:test";
import { composeDispatchPrompt, measureContext } from "./context-metrics.ts";

describe("measureContext", () => {
	test("counts UTF-8 bytes without exposing prompt content or claiming skill usage", () => {
		const segments = {
			system: " role ",
			repository: " контекст ",
			task: "secret task",
			finalPrompt: composeDispatchPrompt(" role ", "secret task", " контекст "),
		};
		const result = measureContext(segments);
		expect(result.system.bytes).toBe(4);
		expect(result.repository.bytes).toBe(16);
		expect(result.finalPrompt.bytes).toBe(Buffer.byteLength(segments.finalPrompt));
		expect(result.finalPrompt.estimatedTokens).toBe(Math.ceil(result.finalPrompt.bytes / 4));
		expect(JSON.stringify(result)).not.toContain("secret task");
		expect(result.skills).toContain("not counted");
	});
});
