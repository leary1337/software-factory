/** Historical key retained to reject retired remote tracker settings explicitly. */
import { z } from "zod";

export const TrackerConfigSchema = z.unknown().refine((value) => value === undefined, {
	message:
		"External trackers are retired. Remove the tracker block; the factory uses internal Seeds.",
});
export type TrackerConfig = z.infer<typeof TrackerConfigSchema>;
