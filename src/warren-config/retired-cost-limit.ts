/** Discard the retired monetary limit when loading existing project configuration. */
export function omitRetiredCostLimit(value: unknown): unknown {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
	return Object.fromEntries(Object.entries(value).filter(([key]) => key !== "maxCostUsd"));
}
