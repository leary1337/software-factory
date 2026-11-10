import { expect, test } from "bun:test";
import { withRunAdmission } from "./admission.ts";
import type { SpawnRunInput, SpawnRunResult } from "./types.ts";

function signal() {
	let resolve = () => {};
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

test("keeps the reservation until any concurrent capacity read completes", async () => {
	const firstAdmitted = signal();
	const secondReading = signal();
	const rowPersisted = signal();
	const finishRead = signal();
	let count = 0;
	let reads = 0;
	const input = {
		serverEnv: {},
		repos: {
			runs: {
				countNonTerminal: async () => {
					const snapshot = count;
					if (++reads === 2) {
						secondReading.resolve();
						await finishRead.promise;
					}
					return snapshot;
				},
			},
		},
	} as unknown as SpawnRunInput;
	const result = {} as SpawnRunResult;
	const first = withRunAdmission(input, async (admitted) => {
		firstAdmitted.resolve();
		await secondReading.promise;
		count++;
		rowPersisted.resolve();
		await admitted.onRunRowCreated?.("first");
		return result;
	});
	await firstAdmitted.promise;
	const second = withRunAdmission(input, async () => {
		count++;
		return result;
	});
	await rowPersisted.promise;
	// Let the first dispatch's row-created callback run before the stale read returns.
	await new Promise((resolve) => setTimeout(resolve, 0));
	finishRead.resolve();
	const settled = await Promise.allSettled([first, second]);
	expect(settled.map((item) => item.status)).toEqual(["fulfilled", "rejected"]);
	expect(count).toBe(1);
});
