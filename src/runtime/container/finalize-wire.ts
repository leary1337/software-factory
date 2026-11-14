/** Compatibility exports; the callback contract is owned by the shared runtime boundary. */
export {
	FINALIZE_CALLBACK_WIRE_VERSION as IN_POD_FINALIZE_WIRE_VERSION,
	type FinalizeCallbackIntent as InPodFinalizeIntent,
	type FinalizeResultEnvelope,
	parseFinalizeResultEnvelope,
	parseSalvageEnvelope,
	type SalvageEnvelope,
	validateFinalizeResult,
} from "../finalization/wire.ts";
