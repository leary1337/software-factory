import { useSearchParams } from "react-router-dom";

/** Replace typing/filter changes in-place so Back returns to the prior screen, not each keystroke. */
export function useListParams() {
	const [params, setParams] = useSearchParams();
	const update = (values: Record<string, string | null>) =>
		setParams(
			(current) => {
				const next = new URLSearchParams(current);
				for (const [key, value] of Object.entries(values)) {
					if (value === null || value === "") next.delete(key);
					else next.set(key, value);
				}
				return next;
			},
			{ replace: true },
		);
	return { params, update };
}
