import { expect, test } from "bun:test";

test("base commit row renders the resolved base_sha with the pin as labelled fallback (warren-b19e)", async () => {
	const src = await Bun.file(new URL("./side-panels.tsx", import.meta.url)).text();
	expect(src.includes('label="base commit"')).toBe(true);
	expect(src.includes("run.baseSha")).toBe(true);
	// The fallback arm shows the dispatch-time pin, explicitly labelled.
	expect(src.includes("base pin")).toBe(true);
});

test("Runtime panel surfaces the salvage rescue ref, bundle, hint, and dispatch button (#1241)", async () => {
	const src = await Bun.file(new URL("./side-panels.tsx", import.meta.url)).text();
	expect(src.includes("<RescueRows run={run} />")).toBe(true);
	expect(src.includes('label="rescue"')).toBe(true);
	expect(src.includes('label="rescue bundle"')).toBe(true);
	// The hint names the CLI command; the button rides the operator gate.
	expect(src.includes("{rescue.hint}")).toBe(true);
	expect(src.includes("Dispatch from rescue")).toBe(true);
	expect(src.includes("rescueFromRunId: run.id")).toBe(true);
});

test("Run definition labels a rescue chain as rescued from (#1241)", async () => {
	const src = await Bun.file(new URL("./side-panels.tsx", import.meta.url)).text();
	expect(src.includes('"rescued from"')).toBe(true);
});
