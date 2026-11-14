import { describe, expect, test } from "bun:test";
import {
	FinalizeCoordinator as SharedCoordinator,
	sharedFinalizeCoordinator as sharedCoordinator,
} from "../finalization/coordinator.ts";
import * as wire from "../finalization/wire.ts";
import { UID_DROP_PREFLIGHT_ERROR_PREFIX as persistedPrefix } from "../launch-errors.ts";
import { UID_DROP_PREFLIGHT_ERROR_PREFIX } from "./agent-uid-drop.ts";
import { FinalizeCoordinator, sharedFinalizeCoordinator } from "./finalize-coordinator.ts";
import * as legacyWire from "./finalize-wire.ts";

describe("legacy finalization exports", () => {
	test("shares the coordinator with callbacks imported through the neutral boundary", () => {
		expect(FinalizeCoordinator).toBe(SharedCoordinator);
		expect(sharedFinalizeCoordinator).toBe(sharedCoordinator);
	});

	test("preserves callback validation and persisted launch failure markers", () => {
		expect(legacyWire.IN_POD_FINALIZE_WIRE_VERSION).toBe(wire.FINALIZE_CALLBACK_WIRE_VERSION);
		expect(legacyWire.parseFinalizeResultEnvelope).toBe(wire.parseFinalizeResultEnvelope);
		expect(legacyWire.parseSalvageEnvelope).toBe(wire.parseSalvageEnvelope);
		expect(legacyWire.validateFinalizeResult).toBe(wire.validateFinalizeResult);
		expect(UID_DROP_PREFLIGHT_ERROR_PREFIX).toBe(persistedPrefix);
	});
});
