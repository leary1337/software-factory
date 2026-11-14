/** Local sidecars bind host loopback directly; there is no network namespace relay. */
export interface ForwardSpec {
	hostPort: number;
	sandboxPort: number;
	sandboxPid: number;
}
export interface ForwardHandle {
	readonly hostPort: number;
	readonly sandboxPort: number;
	readonly hostPortBound: boolean;
	stop(): Promise<void>;
}
export interface StartForwardOptions {
	plat?: NodeJS.Platform;
}
export async function startInboundForward(
	spec: ForwardSpec,
	_options: StartForwardOptions = {},
): Promise<ForwardHandle> {
	return {
		hostPort: spec.hostPort,
		sandboxPort: spec.sandboxPort,
		hostPortBound: false,
		stop: async () => {},
	};
}
