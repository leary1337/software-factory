import type { ProjectRow } from "@/api/types.ts";
import { Alert } from "@/components/ui/alert.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog.tsx";
import { SelectInput } from "@/components/ui/select-input.tsx";
import { Textarea } from "@/components/ui/textarea.tsx";
import { formatError } from "@/lib/format-error.ts";
import { projectName } from "./task-model.ts";
import { useNewTask } from "./use-new-task.ts";

export function NewTask({
	projects,
	projectId,
	onClose,
}: {
	projects: ProjectRow[];
	projectId: string;
	onClose: () => void;
}) {
	const {
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
	} = useNewTask(projects, projectId, onClose);
	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open && !submit.isPending) onClose();
			}}
		>
			<DialogContent className="max-h-dvh overflow-y-auto">
				<DialogTitle>Новая задача</DialogTitle>
				<DialogDescription>
					{step === 1
						? "Выбери проект и опиши ожидаемый результат."
						: "Выбери способ выполнения и агента."}
				</DialogDescription>
				{step === 1 ? (
					<>
						<label htmlFor="new-task-project" className="space-y-2 text-sm">
							Проект
							<SelectInput
								id="new-task-project"
								aria-label="Проект"
								className="mt-2 w-full"
								value={project}
								onChange={(e) => {
									setProject(e.target.value);
									setAgent("");
									setPlanId("");
								}}
							>
								<option value="">Выбери проект</option>
								{projects.map((p) => (
									<option key={p.id} value={p.id}>
										{projectName(p)}
									</option>
								))}
							</SelectInput>
						</label>
						<label htmlFor="new-task-prompt" className="space-y-2 text-sm">
							Ожидаемый результат
							<Textarea
								id="new-task-prompt"
								aria-label="Ожидаемый результат"
								className="mt-2"
								value={prompt}
								onChange={(e) => setPrompt(e.target.value)}
							/>
						</label>
						<Button disabled={!project || !prompt.trim()} onClick={() => setStep(2)}>
							Далее
						</Button>
					</>
				) : (
					<>
						<label htmlFor="new-task-mode" className="space-y-2 text-sm">
							Способ выполнения
							<SelectInput
								id="new-task-mode"
								aria-label="Способ выполнения"
								className="mt-2 w-full"
								value={mode}
								onChange={(e) => setMode(e.target.value)}
							>
								<option value="task">Отдельная задача</option>
								<option value="plan">Существующий план</option>
							</SelectInput>
						</label>
						{mode === "plan" ? (
							<label htmlFor="new-task-plan" className="space-y-2 text-sm">
								План
								<SelectInput
									id="new-task-plan"
									aria-label="План"
									className="mt-2 w-full"
									value={planId}
									onChange={(e) => setPlanId(e.target.value)}
								>
									<option value="">{plans.isLoading ? "Загрузка…" : "Выбери план"}</option>
									{plans.data?.plans.map((p) => (
										<option key={p.id} value={p.id}>
											{p.name ?? p.id}
										</option>
									))}
								</SelectInput>
								<span className="block text-(--color-text-2)">
									Задачи плана выполняются по очереди. Описание уточняет результат для каждой
									задачи.
								</span>
							</label>
						) : null}
						<label htmlFor="new-task-agent" className="space-y-2 text-sm">
							Агент
							<SelectInput
								id="new-task-agent"
								aria-label="Агент"
								className="mt-2 w-full"
								value={agent}
								onChange={(e) => setAgent(e.target.value)}
							>
								<option value="">{agents.isLoading ? "Загрузка…" : "Выбери агента"}</option>
								{agents.data?.agents.map((a) => (
									<option key={a.name} value={a.name}>
										{a.name}
									</option>
								))}
							</SelectInput>
						</label>
						<p className="break-words text-(--color-text-2) text-sm">{prompt}</p>
						<div className="flex flex-wrap justify-between gap-3">
							<Button variant="outline" disabled={submit.isPending} onClick={() => setStep(1)}>
								Назад
							</Button>
							<Button disabled={disabled} onClick={() => submit.mutate()}>
								{submit.isPending ? "Запускается…" : "Запустить"}
							</Button>
						</div>
					</>
				)}
				{error ? (
					<Alert variant="danger">
						{formatError(error)}
						<Button variant="outline" onClick={() => void retry()}>
							Повторить
						</Button>
					</Alert>
				) : null}
			</DialogContent>
		</Dialog>
	);
}
