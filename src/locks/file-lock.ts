import { dlopen, FFIType } from "bun:ffi";
import { closeSync, constants, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";

export class FileLockBusyError extends Error {}
/** Lock a stable inode. Closing the descriptor (including process death) releases ownership. */
export function acquireFileLock(path: string): () => void {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const library = dlopen(
		process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6",
		{
			flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
		},
	);
	let fd: number | undefined;
	try {
		fd = openSync(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
		if (library.symbols.flock(fd, 2 | 4) !== 0)
			throw new FileLockBusyError("Another toolkit update is in progress");
	} catch (error) {
		if (fd !== undefined) closeSync(fd);
		library.close();
		throw error;
	}
	let released = false;
	return () => {
		if (released) return;
		released = true;
		if (fd !== undefined) closeSync(fd);
		library.close();
	};
}

/** Wait asynchronously so a contending request cannot block the owner in this process. */
export async function withFileLock<T>(
	path: string,
	action: () => Promise<T>,
	timeoutMs = 30_000,
): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	let release: (() => void) | undefined;
	while (!release) {
		try {
			release = acquireFileLock(path);
		} catch (error) {
			if (!(error instanceof FileLockBusyError) || Date.now() >= deadline) throw error;
			await Bun.sleep(25);
		}
	}
	try {
		return await action();
	} finally {
		release();
	}
}
