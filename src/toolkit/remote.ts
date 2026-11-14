import type { FreeRemoteName, ToolAvailability, ToolProbe } from "../core/wire.ts";
import { TOOLKIT } from "./catalog.ts";

export type { FreeRemoteName, ToolAvailability, ToolProbe } from "../core/wire.ts";

function decodeReply(text: string): Record<string, unknown> {
	const body = text.trim().startsWith("{")
		? text
		: text
				.split("\n")
				.filter((line) => line.startsWith("data: "))
				.map((line) => line.slice(6))
				.join("\n");
	const value: unknown = JSON.parse(body);
	if (value === null || typeof value !== "object") throw new Error("Invalid MCP reply");
	return value as Record<string, unknown>;
}

export class RemoteToolError extends Error {
	constructor(readonly availability: Exclude<ToolAvailability, "available">) {
		super(availability === "quota" ? "Free tool quota exhausted" : "Free tool unavailable");
	}
}

export function missingEvidenceDecision(
	status: ToolAvailability,
	hasAlternativeEvidence: boolean,
): "continue" | "blocked" {
	return status === "available" || hasAlternativeEvidence ? "continue" : "blocked";
}

export async function callFreeRemote(
	service: FreeRemoteName,
	method: "tools/list" | "tools/call",
	params: Record<string, unknown> = {},
	fetcher: (url: string, options: RequestInit) => Promise<Response> = fetch,
): Promise<Record<string, unknown>> {
	const config = TOOLKIT[service];
	if (method === "tools/call" && !config.tools.includes(String(params.name)))
		throw new Error("Tool is outside the free catalog");
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		Accept: "application/json, text/event-stream",
	};
	const request = async (id: number, operation: string, args: Record<string, unknown>) => {
		const response = await fetcher(config.url, {
			method: "POST",
			headers,
			body: JSON.stringify({ jsonrpc: "2.0", id, method: operation, params: args }),
			signal: AbortSignal.timeout(30_000),
		});
		if (!response.ok) throw new RemoteToolError(response.status === 429 ? "quota" : "unavailable");
		const session = response.headers.get("mcp-session-id");
		if (session) headers["mcp-session-id"] = session;
		const value = decodeReply(await response.text());
		const result = value.result as { isError?: boolean } | undefined;
		const failure = value.error ?? (result?.isError ? result : undefined);
		if (failure)
			throw new RemoteToolError(
				/quota|rate.limit|429/i.test(JSON.stringify(failure)) ? "quota" : "unavailable",
			);
		return value;
	};
	try {
		await request(1, "initialize", {
			protocolVersion: "2025-03-26",
			capabilities: {},
			clientInfo: { name: "factory-free-tools", version: "1" },
		});
		return await request(2, method, params);
	} catch (error) {
		if (error instanceof RemoteToolError) throw error;
		throw new RemoteToolError("unavailable");
	}
}

export async function probeFreeRemote(service: FreeRemoteName): Promise<ToolProbe> {
	try {
		const reply = await callFreeRemote(service, "tools/list");
		const result = reply.result as { tools?: { name: string }[] } | undefined;
		const names = result?.tools?.map((tool) => tool.name) ?? [];
		return {
			service,
			status: TOOLKIT[service].tools.every((tool) => names.includes(tool))
				? "available"
				: "unavailable",
			tools: names.filter((tool) => TOOLKIT[service].tools.includes(tool)),
		};
	} catch (error) {
		return {
			service,
			status: error instanceof RemoteToolError ? error.availability : "unavailable",
			tools: [],
		};
	}
}
