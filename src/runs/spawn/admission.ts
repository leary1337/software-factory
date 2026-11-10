import { StateTransitionError } from "../../core/errors.ts";
import type { Repos } from "../../db/repos/index.ts";
import { resolveAutomaticRunPolicy } from "../../triggers/automatic-capacity.ts";
import type { SpawnRunInput, SpawnRunResult } from "./types.ts";

export class RunCapacityError extends StateTransitionError {
	constructor() {
		super("Run capacity is full. Wait for the active run to finish and retry.");
	}
}

interface AdmissionState {
	pending: number;
	tail: Promise<unknown>;
}
const states = new WeakMap<Repos["runs"], AdmissionState>();

/** Reserve before clone/runtime work; replace the reservation with the durable row. */
export async function withRunAdmission(
	input: SpawnRunInput,
	work: (input: SpawnRunInput) => Promise<SpawnRunResult>,
): Promise<SpawnRunResult> {
	let state = states.get(input.repos.runs);
	if (!state) {
		state = { pending: 0, tail: Promise.resolve() };
		states.set(input.repos.runs, state);
	}
	const slot = state;
	const admitted = slot.tail
		.catch(() => {})
		.then(async () => {
			const count = await input.repos.runs.countNonTerminal();
			const cap = resolveAutomaticRunPolicy(input.serverEnv ?? process.env).maxConcurrentRuns;
			if (count + slot.pending >= cap) throw new RunCapacityError();
			slot.pending++;
		});
	slot.tail = admitted;
	await admitted;
	let reserved = true;
	const release = async () => {
		const releasing = slot.tail
			.catch(() => {})
			.then(() => {
				if (reserved) {
					slot.pending--;
					reserved = false;
				}
			});
		slot.tail = releasing;
		await releasing;
	};

	try {
		return await work({
			...input,
			onRunRowCreated: async (runId) => {
				await release();
				await input.onRunRowCreated?.(runId);
			},
		});
	} finally {
		await release();
	}
}
