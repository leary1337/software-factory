import type { CreatePlanRunInput } from "@/api/types.ts";

/**
 * Walk-definition draft state for the Direction C Dispatch plan page
 * (warren-02bb / pl-7e38 step 7), replacing the legacy new-plan-run form.
 *
 * The draft is one flat object so the left form and the right
 * resolved-manifest rail derive from the same values — they can never
 * disagree about what will be dispatched.
 */

/** Route state accepted via `navigate("/dispatch/plan", { state })`. */
export interface WalkRouteState {
	project?: string;
	planId?: string;
	agent?: string;
}

export function readWalkRouteState(state: unknown): WalkRouteState {
	if (typeof state !== "object" || state === null) return {};
	const s = state as Record<string, unknown>;
	const out: WalkRouteState = {};
	if (typeof s.project === "string") out.project = s.project;
	if (typeof s.planId === "string") out.planId = s.planId;
	if (typeof s.agent === "string") out.agent = s.agent;
	return out;
}

export const DEFAULT_PROMPT_TEMPLATE = "work on sd {seed_id}";

/** Where the walk's child set comes from. */
export type WalkSourceMode = "plan" | "issues";

/** The operator-editable walk definition. */
export interface WalkDraft {
	readonly project: string;
	readonly agent: string;
	readonly sourceMode: WalkSourceMode;
	/** Seeds plan id (plan mode) — picked or typed manually. */
	readonly planId: string;
	/** True once the operator chose manual plan-id entry. */
	readonly planIdManual: boolean;
	/** Ordered issue ids as free text (issues mode, warren-de42). */
	readonly issuesText: string;
	readonly promptTemplate: string;
	/** Git ref; empty = project default branch. */
	readonly ref: string;
	readonly providerOverride: string;
	readonly modelOverride: string;
}

/** Touched flags stop the per-project default auto-fill per field. */
export interface WalkTouched {
	readonly agent: boolean;
	readonly prompt: boolean;
	readonly provider: boolean;
	readonly model: boolean;
}

export interface WalkDraftPatch {
	readonly draft: WalkDraft;
	readonly touched: WalkTouched;
}

export function initialWalkDraft(state: WalkRouteState): WalkDraft {
	return {
		project: state.project ?? "",
		agent: state.agent ?? "",
		sourceMode: "plan",
		planId: state.planId ?? "",
		planIdManual: false,
		issuesText: "",
		promptTemplate: DEFAULT_PROMPT_TEMPLATE,
		ref: "",
		providerOverride: "",
		modelOverride: "",
	};
}

export function initialWalkTouched(state: WalkRouteState): WalkTouched {
	return {
		agent: state.agent !== undefined && state.agent.length > 0,
		prompt: false,
		provider: false,
		model: false,
	};
}

/**
 * Parse `issuesText` into the ordered, deduped issue-id list the
 * `POST /plan-runs` `issues` field expects. Split on commas and
 * whitespace; first occurrence wins (a duplicate id would otherwise
 * dispatch the same seed twice).
 */
export function parseIssueIds(text: string): string[] {
	const out: string[] = [];
	for (const token of text.split(/[\s,]+/)) {
		if (token.length === 0) continue;
		if (!out.includes(token)) out.push(token);
	}
	return out;
}

export function buildCreatePlanRunInput(args: { readonly draft: WalkDraft }): CreatePlanRunInput {
	const { draft } = args;
	const trimmedRef = draft.ref.trim();
	const trimmedProvider = draft.providerOverride.trim();
	const trimmedModel = draft.modelOverride.trim();
	const base = {
		project: draft.project,
		agent: draft.agent,
		promptTemplate: draft.promptTemplate.trim(),
		...(trimmedRef.length > 0 ? { ref: trimmedRef } : {}),
		...(trimmedProvider.length > 0 ? { providerOverride: trimmedProvider } : {}),
		...(trimmedModel.length > 0 ? { modelOverride: trimmedModel } : {}),
	};
	if (draft.sourceMode === "issues") {
		return { ...base, issues: parseIssueIds(draft.issuesText) };
	}
	return { ...base, planId: draft.planId.trim() };
}
