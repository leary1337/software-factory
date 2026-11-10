import { type CodexPricing, codexPricing, estimateCodexCost } from "../codex-config.ts";
import type { AdapterRuntimeEvent, AgentFrontmatter } from "../types.ts";

type RecordValue = Record<string, unknown>;

function record(value: unknown): RecordValue | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as RecordValue)
		: undefined;
}

function event(kind: AdapterRuntimeEvent["kind"], payload: unknown): AdapterRuntimeEvent {
	return {
		kind,
		stream: kind === "state_change" || kind === "telemetry" ? "system" : "stdout",
		payload,
	};
}

function normalizedUsage(raw: unknown, pricing: CodexPricing): RecordValue {
	const usage = record(raw);
	if (!usage) return {};
	const cost = estimateCodexCost(usage, pricing);
	if (cost === undefined) return {};
	const cached = (usage.cached_input_tokens ?? 0) as number;
	return {
		total_cost_usd: cost,
		cost_basis: "subscription_estimate",
		usage: {
			// Warren keeps uncached and cached input in separate buckets.
			input_tokens: (usage.input_tokens as number) - cached,
			output_tokens: usage.output_tokens,
			cache_read_input_tokens: cached,
		},
	};
}

function itemEvents(type: unknown, item: RecordValue): AdapterRuntimeEvent[] {
	const completed = type === "item.completed";
	if (item.type === "agent_message" && completed)
		return [event("text", { type: "text", text: item.text })];
	if (item.type === "reasoning" && completed)
		return [event("thinking", { type: "thinking", thinking: item.text })];
	if (item.type === "command_execution") {
		return [
			completed
				? event("tool_result", {
						type: "tool_result",
						tool_use_id: item.id,
						content: item.aggregated_output,
						is_error: item.exit_code !== 0,
					})
				: event("tool_use", {
						type: "tool_use",
						id: item.id,
						name: "Bash",
						input: { command: item.command },
					}),
		];
	}
	if (item.type === "file_change" && completed && Array.isArray(item.changes)) {
		return item.changes.flatMap((change, index) => {
			const path = record(change)?.path;
			return typeof path === "string"
				? [
						event("tool_use", {
							type: "tool_use",
							id: `${item.id}-${index}`,
							name: "Edit",
							input: { file_path: path },
						}),
					]
				: [];
		});
	}
	return [event("telemetry", { type, item })];
}

/** One parser per process: final text must never leak between concurrent runs. */
export function createCodexParser(
	frontmatter?: AgentFrontmatter,
): (line: string) => AdapterRuntimeEvent[] {
	const pricing = codexPricing(frontmatter);
	let result = "";
	let sessionId: unknown;
	return (line) => {
		const envelope = parseEnvelope(line);
		if (!envelope) return [];
		const { type } = envelope;
		if (type === "thread.started") sessionId = envelope.thread_id;
		const item = record(envelope.item);
		if (item) {
			result = completedText(type, item) ?? result;
			return itemEvents(type, item);
		}
		if (type === "turn.completed" || type === "turn.failed") {
			// Normalize into Warren's shared batch result contract.
			return [
				event("state_change", {
					type: "result",
					runtime: "codex",
					source_type: type,
					result,
					session_id: sessionId,
					is_error: type === "turn.failed",
					error: envelope.error,
					...normalizedUsage(envelope.usage, pricing),
				}),
			];
		}
		return [event("telemetry", envelope)];
	};
}

function parseEnvelope(line: string): RecordValue | undefined {
	try {
		return record(JSON.parse(line));
	} catch {
		return undefined;
	}
}

function completedText(type: unknown, item: RecordValue): string | undefined {
	return type === "item.completed" && item.type === "agent_message" && typeof item.text === "string"
		? item.text
		: undefined;
}
