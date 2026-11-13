import type { ChangedPaths } from "./auto-merge-policy.ts";

/** Conservative automatic-merge ceilings; larger changes remain available for manual review. */
export const MAX_AUTO_MERGE_FILES = 100;
export const MAX_AUTO_MERGE_LINES = 3000;

interface RawFile {
	readonly path: string;
	readonly oldMode: string;
	readonly newMode: string;
}

function rawFiles(output: string): RawFile[] | null {
	const fields = output.split("\0");
	if (fields.pop() !== "" || fields.length % 2 !== 0) return null;
	const files: RawFile[] = [];
	for (let index = 0; index < fields.length; index += 2) {
		const header = /^:(\d{6}) (\d{6}) [a-f0-9]{40} [a-f0-9]{40} [A-Z]$/.exec(fields[index] ?? "");
		const path = fields[index + 1];
		if (!header?.[1] || !header[2] || !path) return null;
		files.push({ path, oldMode: header[1], newMode: header[2] });
	}
	return files;
}

interface FileStat {
	readonly path: string;
	readonly lines: number | null;
}

function fileStats(output: string): FileStat[] | null {
	const fields = output.split("\0");
	if (fields.pop() !== "") return null;
	const files: FileStat[] = [];
	for (const field of fields) {
		const match = /^(\d+|-)\t(\d+|-)\t([\s\S]+)$/.exec(field);
		if (!match?.[3]) return null;
		const lines = match[1] === "-" || match[2] === "-" ? null : Number(match[1]) + Number(match[2]);
		if (lines !== null && !Number.isSafeInteger(lines)) return null;
		files.push({ path: match[3], lines });
	}
	return files;
}

function samePaths(paths: readonly string[], files: readonly { path: string }[]): boolean {
	const actual = new Set(files.map((file) => file.path));
	return (
		actual.size === paths.length &&
		files.length === paths.length &&
		paths.every((p) => actual.has(p))
	);
}

/** Consume exact NUL-delimited Git output; incomplete measurements never authorize merge. */
export function assessAutoMergeDiff(
	paths: readonly string[],
	raw: string,
	numstat: string,
): ChangedPaths {
	if (paths.length > MAX_AUTO_MERGE_FILES)
		return {
			kind: "unsafe",
			reason: "diff_too_large",
			paths: paths.slice(0, MAX_AUTO_MERGE_FILES + 1),
		};
	const files = rawFiles(raw);
	const stats = fileStats(numstat);
	if (!files || !stats || !samePaths(paths, files) || !samePaths(paths, stats))
		return { kind: "unreadable" };
	const regularModes = new Set(["000000", "100644", "100755"]);
	const special = files.filter(
		(file) => !regularModes.has(file.oldMode) || !regularModes.has(file.newMode),
	);
	if (special.length > 0)
		return {
			kind: "unsafe",
			reason: "unsupported_file_mode",
			paths: special.map((file) => file.path),
		};
	const binary = stats.filter((file) => file.lines === null);
	if (binary.length > 0)
		return { kind: "unsafe", reason: "binary_diff", paths: binary.map((file) => file.path) };
	if (stats.reduce((sum, file) => sum + (file.lines ?? 0), 0) > MAX_AUTO_MERGE_LINES)
		return { kind: "unsafe", reason: "diff_too_large", paths };
	return { kind: "changed", paths };
}
