/** Patrol roles may be decoded from history, but may not create new work. */
export const RETIRED_PATROL_REASON =
	"Automatic patrols are retired; run an explicitly approved task instead";

export function isRetiredPatrol(name: unknown): boolean {
	return name === "nightwatch" || name === "bugwatch";
}
