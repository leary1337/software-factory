/** Install before boot: a signal during startup still drains the eventual server handle. */
export async function serveUntilSignal<T extends { stop(): Promise<void> }>(
	boot: () => Promise<T>,
	signals: Pick<NodeJS.EventEmitter, "on" | "off"> = process,
): Promise<void> {
	const signal = Promise.withResolvers<void>();
	const onSignal = () => signal.resolve();
	signals.on("SIGTERM", onSignal);
	signals.on("SIGINT", onSignal);
	try {
		const server = await boot();
		await signal.promise;
		await server.stop();
	} finally {
		signals.off("SIGTERM", onSignal);
		signals.off("SIGINT", onSignal);
	}
}
