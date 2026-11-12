import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";
import { planRunsApi, runsApi } from "@/api/client.ts";
import { isTerminalRunState, type RunRow } from "@/api/types.ts";
import { Alert } from "@/components/ui/alert.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Textarea } from "@/components/ui/textarea.tsx";
import { formatError } from "@/lib/format-error.ts";
import type { DispatchRouteState } from "../dispatch/dispatch-draft.ts";

export function RunActions({ run, planId }: { run: RunRow; planId?: string }) {
	const qc = useQueryClient();
	const [body, setBody] = useState("");
	const [notice, setNotice] = useState("");
	const terminal = isTerminalRunState(run.state);
	const action = useMutation({
		mutationFn: async (kind: "steer" | "cancel" | "preview") => {
			if (kind === "steer") {
				await runsApi.steer(run.id, { body: body.trim() });
				return "Сообщение передано. Агент получит его на следующем шаге.";
			}
			if (kind === "preview") {
				const data = await runsApi.previewLogin(run.id);
				window.location.assign(data.url);
				return "";
			}
			if (planId) await planRunsApi.cancel(planId);
			else await runsApi.cancel(run.id);
			return "Запрос на остановку отправлен.";
		},
		onSuccess: (message, kind) => {
			setNotice(message);
			if (kind === "steer") setBody("");
			void qc.invalidateQueries({ queryKey: ["runs"] });
			void qc.invalidateQueries({ queryKey: ["plan-runs"] });
		},
	});
	const base: DispatchRouteState = {
		project: run.projectId ?? undefined,
		agent: run.agentName,
		prompt: run.prompt,
		seedId: run.seedId ?? undefined,
	};
	return (
		<div className="space-y-3">
			<div className="flex flex-wrap gap-2">
				{run.previewState === "live" ? (
					<Button
						variant="outline"
						disabled={action.isPending}
						onClick={() => action.mutate("preview")}
					>
						Preview ↗
					</Button>
				) : null}
				{terminal ? (
					<>
						<Button variant="outline" asChild>
							<Link to="/dispatch" state={{ ...base, cloneFromRunId: run.id }}>
								Запустить заново
							</Link>
						</Button>
						<Button variant="outline" asChild>
							<Link to="/dispatch" state={{ ...base, continueFromRunId: run.id }}>
								Продолжить с уточнением
							</Link>
						</Button>
					</>
				) : !planId ? (
					<Button
						variant="outline"
						disabled={action.isPending}
						onClick={() => action.mutate("cancel")}
					>
						Остановить задачу
					</Button>
				) : null}
			</div>
			{!terminal ? (
				<form
					className="space-y-2"
					onSubmit={(e) => {
						e.preventDefault();
						if (body.trim() && !action.isPending) action.mutate("steer");
					}}
				>
					<label htmlFor="task-steering" className="block text-sm">
						Уточнение агенту
						<Textarea
							id="task-steering"
							className="mt-2"
							value={body}
							onChange={(e) => setBody(e.target.value)}
							placeholder="Что изменить или учесть на следующем шаге"
						/>
					</label>
					<Button type="submit" disabled={action.isPending || !body.trim()}>
						Отправить
					</Button>
				</form>
			) : null}
			{notice ? (
				<p role="status" className="text-(--color-text-2) text-sm">
					{notice}
				</p>
			) : null}
			{action.error ? <Alert variant="danger">{formatError(action.error)}</Alert> : null}
		</div>
	);
}
