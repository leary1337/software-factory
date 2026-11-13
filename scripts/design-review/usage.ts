#!/usr/bin/env bun

import { existsSync, readFileSync } from "node:fs";

import type { Usage } from "./outcome.ts";

function num(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/** The usage figures from a parsed execution file, or nulls. */
export function extractUsage(messages: unknown): Usage {
	const list = Array.isArray(messages) ? messages : [];
	const results = list.filter(
		(m): m is Record<string, unknown> =>
			typeof m === "object" && m !== null && (m as { type?: unknown }).type === "result",
	);
	const result = results[results.length - 1];
	return { turns: num(result?.num_turns) };
}

/** Parse a `usage.json` this script wrote; null when absent or malformed. */
export function parseUsage(text: string | null): Usage | null {
	if (text === null) return null;
	try {
		const raw = JSON.parse(text) as Record<string, unknown> | null;
		return { turns: num(raw?.turns) };
	} catch {
		return null;
	}
}

if (import.meta.main) {
	const path = process.argv[2] ?? "";
	let parsed: unknown = null;
	try {
		parsed = path !== "" && existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
	} catch {
		parsed = null;
	}
	console.log(JSON.stringify(extractUsage(parsed)));
}
