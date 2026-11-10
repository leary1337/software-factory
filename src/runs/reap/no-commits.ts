/**
 * Agents that leave the run branch untouched by design.
 *
 * A ref-dispatch that pushes zero commits reaps as `failed`/`no_changes`
 * (warren-ba08), so a shepherd cannot read "the agent did nothing" as a fix.
 * A reviewer reads a pull request and reports a verdict, so zero commits is
 * its success shape, not a no-op. The agent says so in its frontmatter:
 * `noCommits: true`. Reap used to match the agent name `reviewer` instead,
 * which broke for any other read-only agent and for a renamed reviewer.
 *
 * The flag is read from the run's frozen `renderedAgentJson`, the envelope
 * the run was dispatched with, so a later edit to the agent cannot change
 * how an earlier run reaps.
 */

/** True when the run's agent declares `frontmatter.noCommits: true`. */
export function declaresNoCommits(run: { renderedAgentJson: unknown }): boolean {
	const json = run.renderedAgentJson;
	if (json === null || typeof json !== "object" || Array.isArray(json)) return false;
	const fm = (json as Record<string, unknown>).frontmatter;
	if (fm === null || typeof fm !== "object" || Array.isArray(fm)) return false;
	const value = (fm as Record<string, unknown>).noCommits;
	// `cn --fm key:value` stringifies every value (warren-5f07).
	return value === true || value === "true";
}
