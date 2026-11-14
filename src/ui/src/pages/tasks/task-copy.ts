/** Extract the owner's prose; keep the full instruction envelope in diagnostics. */
export function taskCopy(prompt: string | null | undefined, explicitTitle?: string | null) {
	const body = (prompt ?? "").replaceAll("\r\n", "\n").trim();
	const lines = body.split("\n").map((line) => line.replace(/^#{1,6}\s+/, "").trim());
	const first = lines.findIndex((line) => line.length > 0);
	const title = explicitTitle?.trim() || lines[first]?.slice(0, 180) || "Task details unavailable";
	const rest = lines
		.slice(first + 1)
		.join("\n")
		.trim();
	const operational = /^(?:Plan \S+ step \d+:.*|work on sd \S+)$/i.test(body);
	const description =
		(operational ? "Description not provided." : rest) ||
		(explicitTitle && body && body !== explicitTitle ? body : "Description not provided.");
	return { title, description: description.slice(0, 750) };
}
