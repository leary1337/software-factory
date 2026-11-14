/** Each booted resource registers immediately, so partial startup unwinds like normal shutdown. */
export class BootCleanup {
	private readonly actions: (() => void | Promise<void>)[] = [];
	private stopping: Promise<void> | undefined;
	add(action: () => void | Promise<void>): void {
		this.actions.push(action);
	}
	stop(): Promise<void> {
		this.stopping ??= this.drain().catch((error) => {
			this.stopping = undefined;
			throw error;
		});
		return this.stopping;
	}
	private async drain(): Promise<void> {
		const errors: unknown[] = [];
		for (const action of this.actions.splice(0).reverse()) {
			try {
				await action();
			} catch (error) {
				errors.push(error);
				this.actions.unshift(action);
			}
		}
		if (errors.length)
			throw new AggregateError(errors, "Some factory resources could not stop cleanly");
	}
}
