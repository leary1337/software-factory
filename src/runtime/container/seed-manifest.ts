/** The seed-file manifest the in-container workspace init reads back. */

import { RuntimeProviderError } from "../errors.ts";

export interface SeedManifestEntry {
	readonly path: string;
	readonly contents: string;
	readonly encoding?: string;
	readonly mode?: number;
}

/**
 * Parse and validate the manifest. A corrupt manifest surfaces as a
 * workspace-init failure rather than silently writing garbage.
 */
export function parseSeedManifest(raw: string): SeedManifestEntry[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		throw new RuntimeProviderError("seed manifest is not valid JSON", { cause: err });
	}
	if (!Array.isArray(parsed)) {
		throw new RuntimeProviderError("seed manifest must be a JSON array");
	}
	return parsed.map((entry, i) => {
		if (typeof entry !== "object" || entry === null) {
			throw new RuntimeProviderError(`seed manifest entry ${i} is not an object`);
		}
		const rec = entry as Record<string, unknown>;
		if (typeof rec.path !== "string" || typeof rec.contents !== "string") {
			throw new RuntimeProviderError(`seed manifest entry ${i} needs string path + contents`);
		}
		return {
			path: rec.path,
			contents: rec.contents,
			...(typeof rec.encoding === "string" ? { encoding: rec.encoding } : {}),
			...(typeof rec.mode === "number" ? { mode: rec.mode } : {}),
		};
	});
}
