import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { agentsApi, planRunsApi, projectsApi, runsApi } from "@/api/client.ts";
import type { ProjectRow } from "@/api/types.ts";

export function useNewTask(projects: ProjectRow[], projectId: string, onClose: () => void) {
	const qc = useQueryClient();
	const [project, setProject] = useState(
		projectId || (projects.length === 1 ? (projects[0]?.id ?? "") : ""),
	);
	const [prompt, setPrompt] = useState("");
	const [step, setStep] = useState(1);
	const [mode, setMode] = useState("task");
	const [chosenAgent, setAgent] = useState("");
	const [planId, setPlanId] = useState("");
	const config = useQuery({
		queryKey: ["projects", project, "warren-config"],
		queryFn: ({ signal }) => projectsApi.warrenConfig(project, signal),
		enabled: !!project,
	});
	const agents = useQuery({
		queryKey: ["agents", { projectId: project }],
		queryFn: ({ signal }) => agentsApi.list({ projectId: project }, signal),
		enabled: !!project,
	});
	const plans = useQuery({
		queryKey: ["projects", project, "seed-plans"],
		queryFn: ({ signal }) => projectsApi.seedPlans(project, signal),
		enabled: !!project && mode === "plan",
	});
	const agent = chosenAgent || config.data?.defaults?.defaultRole || "";
	const submit = useMutation({
		mutationFn: async () => {
			if (mode === "plan")
				return planRunsApi.create({
					project,
					agent,
					planId,
					promptTemplate: `${prompt.trim()}\n\nЗадача: {seed_id}`,
				});
			return runsApi.create({ project, agent, prompt: prompt.trim() });
		},
		onSuccess: () => {
			void qc.invalidateQueries({ queryKey: ["runs"] });
			void qc.invalidateQueries({ queryKey: ["plan-runs"] });
			onClose();
		},
	});
	const loadError = config.error ?? agents.error ?? (mode === "plan" ? plans.error : null);
	const error = loadError ?? submit.error;
	const retry = () =>
		Promise.all([
			config.refetch(),
			agents.refetch(),
			...(mode === "plan" ? [plans.refetch()] : []),
		]);
	const validAgent = agents.data?.agents.some((a) => a.name === agent) ?? false;
	const disabled =
		submit.isPending ||
		config.isLoading ||
		!!loadError ||
		!validAgent ||
		(mode === "plan" && !planId);
	return {
		project,
		setProject,
		prompt,
		setPrompt,
		step,
		setStep,
		mode,
		setMode,
		setAgent,
		planId,
		setPlanId,
		agent,
		agents,
		plans,
		submit,
		error,
		disabled,
		retry,
	};
}
