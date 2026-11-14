/** Read-only compatibility for persisted Pi logs and workspace state. */
import { parsePiEvents } from "./parsers/pi.ts";
import type { AgentRuntimeAdapter } from "./types.ts";

export const piAdapter: AgentRuntimeAdapter = {
	runtimeId: "pi",
	harnessStatePrefixes: [".pi/sessions/"],
	commitExcludes: [".pi/sessions/"],
	terminalErrorEnvelopeTypes: ["turn_end", "agent_end"],
	parseEvents: parsePiEvents,
};
