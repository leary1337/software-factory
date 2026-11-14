import { z } from "zod";
import { ValidationError } from "../../core/errors.ts";
import { applyToolkitVersion } from "../../toolkit/distribution.ts";
import { probeFreeRemote } from "../../toolkit/remote.ts";
import { verifyToolkitDependencies } from "../../toolkit/verification.ts";
import { publishToolkitVersion, toolkitStatus } from "../../toolkit/versions.ts";
import { jsonResponse } from "../response.ts";
import type { RouteHandler } from "../types.ts";
import { readJsonBody } from "./index.ts";

export function toolkitStatusHandler(): RouteHandler {
	return async () => jsonResponse(200, await toolkitStatus());
}

export function toolkitCheckHandler(): RouteHandler {
	return async () =>
		jsonResponse(200, {
			candidate: await publishToolkitVersion(),
			dependencies: verifyToolkitDependencies(),
			probes: await Promise.all([probeFreeRemote("exa"), probeFreeRemote("context7")]),
		});
}

export function toolkitApplyHandler(): RouteHandler {
	return async (ctx) => {
		const parsed = z
			.object({ version: z.string().regex(/^[a-f0-9]{64}$/) })
			.strict()
			.safeParse(await readJsonBody(ctx));
		if (!parsed.success) throw new ValidationError("Choose a verified toolkit version");
		try {
			await applyToolkitVersion(parsed.data.version);
		} catch (error) {
			throw new ValidationError(error instanceof Error ? error.message : "Toolkit update failed");
		}
		return jsonResponse(200, await toolkitStatus());
	};
}
