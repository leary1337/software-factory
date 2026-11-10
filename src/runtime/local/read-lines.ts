/**
 * Split a child's byte stream into lines — shared by the drive loop's agent
 * pumps and the post-run gate's log capture. A trailing partial line is
 * yielded at EOF.
 */
export async function* readLines(
	stream: ReadableStream<Uint8Array>,
): AsyncGenerator<string, void, void> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let buf = "";
	try {
		while (true) {
			const { value, done } = await reader.read();
			if (done) break;
			buf += decoder.decode(value, { stream: true });
			let idx = buf.indexOf("\n");
			while (idx !== -1) {
				yield buf.slice(0, idx);
				buf = buf.slice(idx + 1);
				idx = buf.indexOf("\n");
			}
		}
		buf += decoder.decode();
		if (buf.length > 0) yield buf;
	} finally {
		reader.releaseLock();
	}
}
