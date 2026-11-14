import type { RuntimeId } from "./wire-runtime.ts";

export interface ExecutionProfile {
	runtime: RuntimeId;
	model: string;
}

export interface ExecutionProfiles {
	implementation: ExecutionProfile;
	review: ExecutionProfile;
}

export interface ExecutionOption {
	runtime: RuntimeId;
	label: string;
	defaultModel: string;
}
