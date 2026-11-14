import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { metaApi } from "@/api/client.ts";
import { Alert } from "@/components/ui/alert.tsx";
import { Button } from "@/components/ui/button.tsx";

export function LocalConnectionStatus() {
	const cache = useQueryClient();
	const [online, setOnline] = useState(navigator.onLine);
	const health = useQuery({
		queryKey: ["meta", "healthz"],
		queryFn: () => metaApi.healthz(),
		refetchInterval: 30_000,
		retry: 1,
	});
	useEffect(() => {
		const lost = () => setOnline(false);
		const restored = () => {
			setOnline(true);
			void cache.invalidateQueries();
		};
		window.addEventListener("offline", lost);
		window.addEventListener("online", restored);
		window.addEventListener("pageshow", restored);
		return () => {
			window.removeEventListener("offline", lost);
			window.removeEventListener("online", restored);
			window.removeEventListener("pageshow", restored);
		};
	}, [cache]);
	if (online && !health.isError && health.data?.ok !== false) return null;
	return (
		<div className="px-3.5 py-2 md:px-6">
			<Alert variant="warning" title="Connection interrupted">
				<p>
					Task state may be out of date. Closing this page does not cancel work; the Mac must stay
					awake. Reconnecting will reload the same queue.
				</p>
				<Button size="sm" variant="outline" onClick={() => void cache.invalidateQueries()}>
					Reconnect
				</Button>
			</Alert>
		</div>
	);
}
