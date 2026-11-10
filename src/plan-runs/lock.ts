/** Serialize coordinator transitions and cancellation within the owning server. */
const tails = new Map<string, Promise<unknown>>();
export async function withPlanRunLock<T>(id: string, work: () => Promise<T>): Promise<T> {
	const next = (tails.get(id) ?? Promise.resolve()).catch(() => {}).then(work);
	tails.set(id, next);
	try {
		return await next;
	} finally {
		if (tails.get(id) === next) tails.delete(id);
	}
}
