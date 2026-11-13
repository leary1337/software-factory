/**
 * Commander boundary helpers shared by the program definition in
 * `main.ts`: custom flag argParsers and the parse-rejection → exit-code
 * mapping. Split out of `main.ts` to keep it under the `check:size`
 * budget.
 */

import { CommanderError } from "commander";
import { PLAN_RUN_STATES, type PlanRunState } from "../core/wire.ts";
import { EXIT_USAGE } from "./output.ts";
import type { PlanRunOutput } from "./plan-run-renderer.ts";

export function resolveCliExitCode(err: unknown): number {
	if (err instanceof CommanderError) {
		return err.exitCode === 0 ? 0 : EXIT_USAGE;
	}
	return 1;
}

/**
 * Coerce a `--issues a,b,c` flag value into the ordered issue-id list
 * (warren-de42). Empty segments are dropped so a trailing comma is not an
 * error; an unset/empty flag yields undefined.
 */
export function parseIssueList(value: string | undefined): string[] | undefined {
	if (value === undefined) return undefined;
	const ids = value
		.split(",")
		.map((s) => s.trim())
		.filter((s) => s !== "");
	return ids.length > 0 ? ids : undefined;
}

/**
 * Coerce a `--output` flag value to a {@link PlanRunOutput}, defaulting
 * `ndjson` (moved from `main.ts` for the file-size budget, warren-de42).
 */
export function parsePlanRunOutput(value: string | undefined): PlanRunOutput {
	return value === "pretty" ? "pretty" : "ndjson";
}

/**
 * Coerce a `--state` flag value to a {@link PlanRunState}, or undefined when
 * unset/invalid. Membership is tested against the canonical tuple rather than
 * a locally rebuilt `Set` — that copy was drift waiting to happen (warren-d371).
 */
export function parsePlanRunState(value: string | undefined): PlanRunState | undefined {
	return value !== undefined && (PLAN_RUN_STATES as readonly string[]).includes(value)
		? (value as PlanRunState)
		: undefined;
}
