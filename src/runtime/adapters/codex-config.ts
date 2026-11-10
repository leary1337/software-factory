import type { AgentFrontmatter } from "./types.ts";

export const CODEX_DEFAULT_MODEL = process.env.WARREN_CODEX_MODEL?.trim() || "gpt-6.1-sol";

export interface CodexPricing {
	input: number;
	cached: number;
	output: number;
}

// Standard short-context API rates, USD / million tokens, checked 2026-11-10:
// https://developers.openai.com/api/docs/models/gpt-6.1-sol
// This is an estimate of equivalent API usage, never a subscription bill.
const PRICES: Readonly<Record<string, CodexPricing>> = {
	"gpt-6.1-sol": { input: 2, cached: 0.1, output: 10 },
};

export function codexPricing(frontmatter?: AgentFrontmatter): CodexPricing {
	if (frontmatter?.provider && frontmatter.provider !== "openai") {
		throw new Error("Codex ChatGPT runs require the openai provider");
	}
	const model = frontmatter?.model ?? CODEX_DEFAULT_MODEL;
	const price = frontmatter?.codex?.pricing ?? PRICES[model];
	if (
		!price ||
		![price.input, price.cached, price.output].every((n) => Number.isFinite(n) && n >= 0)
	) {
		throw new Error(
			`No Codex cost estimate configured for ${model}; set frontmatter.codex.pricing (input, cached, output USD per million tokens)`,
		);
	}
	return price;
}

export function estimateCodexCost(
	usage: Record<string, unknown>,
	price: CodexPricing,
): number | undefined {
	const { input_tokens: input, cached_input_tokens: cached = 0, output_tokens: output } = usage;
	if (typeof input !== "number" || typeof cached !== "number" || typeof output !== "number")
		return undefined;
	if (![input, cached, output].every((n) => Number.isFinite(n) && n >= 0) || cached > input)
		return undefined;
	return (
		((input - cached) * price.input + cached * price.cached + output * price.output) / 1_000_000
	);
}
