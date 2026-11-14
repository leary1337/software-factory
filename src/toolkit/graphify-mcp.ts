import { createInterface } from "node:readline";
import { queryGraph } from "./graphify.ts";

const tools = [
	{
		name: "graphify_index",
		description:
			"Index current workspace code locally without a model. Refreshes after code changes.",
		inputSchema: { type: "object", properties: {}, additionalProperties: false },
	},
	{
		name: "graphify_query",
		description: "Query the current code graph. Confirm findings in source files.",
		inputSchema: {
			type: "object",
			properties: { query: { type: "string", minLength: 1, maxLength: 4000 } },
			required: ["query"],
			additionalProperties: false,
		},
	},
];

async function handle(message: Record<string, unknown>): Promise<unknown> {
	if (message.method === "initialize")
		return {
			protocolVersion: "2025-03-26",
			capabilities: { tools: {} },
			serverInfo: { name: "factory-graphify", version: "1" },
		};
	if (message.method === "ping") return {};
	if (message.method === "tools/list") return { tools };
	if (message.method !== "tools/call") throw new Error("Unknown method");
	const params = message.params as { name?: string; arguments?: { query?: unknown } } | undefined;
	if (!tools.some((tool) => tool.name === params?.name)) throw new Error("Unknown tool");
	const query = params?.arguments?.query;
	if (
		params?.name === "graphify_query" &&
		(typeof query !== "string" || !query.trim() || query.length > 4000)
	)
		throw new Error("A query of 1–4000 characters is required");
	try {
		const result = await queryGraph(
			process.argv[2] ?? process.cwd(),
			params?.name === "graphify_query" ? String(query) : undefined,
		);
		return { content: [{ type: "text", text: JSON.stringify(result) }] };
	} catch (error) {
		return {
			isError: true,
			content: [
				{ type: "text", text: error instanceof Error ? error.message : "Local graph unavailable" },
			],
		};
	}
}

/** Serial calls prevent concurrent extraction from presenting a half-written graph. */
for await (const line of createInterface({ input: process.stdin })) {
	let message: Record<string, unknown>;
	try {
		message = JSON.parse(line);
	} catch {
		continue;
	}
	if (message.id === undefined) continue;
	try {
		console.log(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: await handle(message) }));
	} catch {
		console.log(
			JSON.stringify({
				jsonrpc: "2.0",
				id: message.id,
				error: { code: -32602, message: "Invalid local graph request" },
			}),
		);
	}
}
