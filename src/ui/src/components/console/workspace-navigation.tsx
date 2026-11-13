import {
	createContext,
	type ReactNode,
	type RefObject,
	useContext,
	useLayoutEffect,
	useRef,
} from "react";
import { useLocation, useNavigationType } from "react-router-dom";

const ReturnLocations = createContext<ReadonlyMap<string, string>>(new Map());

function remember<T>(map: Map<string, T>, key: string, value: T) {
	map.delete(key);
	map.set(key, value);
	const oldest = map.keys().next().value;
	if (map.size > 100 && oldest !== undefined) map.delete(oldest);
}

/** Memory belongs to the authenticated shell, not to an account-independent global store. */
export function WorkspaceNavigation({
	children,
	scrollRef,
}: {
	children: ReactNode;
	scrollRef: RefObject<HTMLElement>;
}) {
	const location = useLocation();
	const navigation = useNavigationType();
	const positions = useRef(new Map<string, number>());
	const returns = useRef(new Map<string, string>());
	const route = location.pathname + location.search;
	const state: unknown = location.state;
	const restore =
		navigation === "POP" ||
		(typeof state === "object" &&
			state !== null &&
			"restoreScroll" in state &&
			state.restoreScroll === true);
	useLayoutEffect(() => {
		const main = scrollRef.current;
		if (!main) return;
		// A task shares its pathname with its parent plan; it must not replace that return target.
		if (!new URLSearchParams(location.search).has("task")) {
			remember(returns.current, location.pathname, route);
		}
		const target = restore
			? (positions.current.get(route) ?? 0)
			: navigation === "REPLACE"
				? main.scrollTop
				: 0;
		let restoring = true;
		const observer = new MutationObserver(() => attemptRestore());
		const record = () => {
			if (!restoring) remember(positions.current, route, main.scrollTop);
		};
		function attemptRestore() {
			if (!main || !restoring) return;
			main.scrollTop = target;
			if (Math.abs(main.scrollTop - target) < 2) {
				restoring = false;
				observer.disconnect();
			}
		}
		const stopRestoring = () => {
			restoring = false;
			observer.disconnect();
		};
		// Cached pages restore immediately; a cold query restores when its content arrives.
		observer.observe(main, { childList: true, subtree: true });
		attemptRestore();
		main.addEventListener("scroll", record, { passive: true });
		main.addEventListener("click", record, true);
		for (const event of ["wheel", "touchstart", "pointerdown", "keydown"]) {
			main.addEventListener(event, stopRestoring, { passive: true });
		}
		return () => {
			observer.disconnect();
			main.removeEventListener("scroll", record);
			main.removeEventListener("click", record, true);
			for (const event of ["wheel", "touchstart", "pointerdown", "keydown"]) {
				main.removeEventListener(event, stopRestoring);
			}
		};
	}, [route, restore, scrollRef, location.pathname, location.search, navigation]);
	return <ReturnLocations.Provider value={returns.current}>{children}</ReturnLocations.Provider>;
}

/** Explicit return links restore the last list filters and position, just like browser Back. */
export function useWorkspaceReturn(pathname: string) {
	const locations = useContext(ReturnLocations);
	return { to: locations.get(pathname) ?? pathname, state: { restoreScroll: true } };
}
