import { createHash } from "node:crypto";
export type ReserveEnvironmentRepair = (
	runId: string,
	stage: string,
	attempt: number,
	reason: string,
) => Promise<void>;
/** Only transport failures admit retry; locks, versions, permissions and source errors never do. */
export function isTransientPreparationFailure(message: string): boolean {
	return /(?:ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|connection (?:reset|timed out)|temporary failure|HTTP(?: status)?[ :]*(?:429|5\d\d)|status(?: code)?[ :]*(?:429|5\d\d)|too many requests|network (?:error|unreachable))/i.test(
		message,
	);
}
export function preparationFailureSignature(message: string): string {
	return createHash("sha256").update(message.replace(/\d+/g, "#")).digest("hex");
}
