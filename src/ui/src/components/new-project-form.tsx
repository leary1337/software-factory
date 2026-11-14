import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { useNavigate } from "react-router-dom";
import { newProjectsApi } from "@/api/client.ts";
import { OperatorOnly } from "@/components/operator-only.tsx";
import { Alert } from "@/components/ui/alert.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { SelectInput } from "@/components/ui/select-input.tsx";
import { formatError } from "@/lib/format-error.ts";

export function NewProjectForm(props: { onCreated: () => void }) {
	return (
		<OperatorOnly capability="admin">
			<NewProjectFields {...props} />
		</OperatorOnly>
	);
}

function NewProjectFields({ onCreated }: { onCreated: () => void }) {
	const id = useId();
	const cache = useQueryClient();
	const navigate = useNavigate();
	const [owner, setOwner] = useState("");
	const [name, setName] = useState("");
	const [template, setTemplate] = useState(false);
	const preview = useMutation({
		mutationFn: () => newProjectsApi.preview({ owner, name, template: "go-react" }),
	});
	const create = useMutation({
		mutationFn: () => {
			if (!preview.data) throw new Error("Review the project preview first.");
			return newProjectsApi.create({
				request: preview.data.request,
				confirmation: preview.data.confirmation,
			});
		},
		onSuccess: (data) => {
			void cache.invalidateQueries({ queryKey: ["projects"] });
			onCreated();
			navigate(`/projects/${encodeURIComponent(data.project.id)}`);
		},
	});
	return (
		<details className="space-y-3 rounded-md border border-(--color-border) p-3">
			<summary className="cursor-pointer font-medium text-sm">Create a new project</summary>
			<form
				className="space-y-3"
				onSubmit={(event) => {
					event.preventDefault();
					preview.mutate();
				}}
				onChange={() => preview.reset()}
			>
				<label htmlFor={`${id}-owner`} className="block space-y-1 text-sm">
					<span>GitHub owner or organization</span>
					<Input
						id={`${id}-owner`}
						required
						value={owner}
						disabled={create.isPending}
						onChange={(event) => setOwner(event.target.value)}
					/>
				</label>
				<label htmlFor={`${id}-name`} className="block space-y-1 text-sm">
					<span>New repository name</span>
					<Input
						id={`${id}-name`}
						required
						value={name}
						disabled={create.isPending}
						onChange={(event) => setName(event.target.value)}
					/>
				</label>
				<label htmlFor={`${id}-template`} className="block space-y-1 text-sm">
					<span>Project template</span>
					<SelectInput
						id={`${id}-template`}
						required
						value={template ? "go-react" : ""}
						onChange={(event) => setTemplate(event.target.value === "go-react")}
					>
						<option value="">Choose a template</option>
						<option value="go-react">Go service with React application</option>
					</SelectInput>
				</label>
				<p className="text-(--color-text-2) text-sm">
					This creates a new repository. Existing repositories keep their own stack.
				</p>
				<Button
					variant="outline"
					type="submit"
					disabled={!template || preview.isPending || create.isPending}
				>
					{preview.isPending ? "Preparing preview…" : "Preview new project"}
				</Button>
			</form>
			{preview.data ? (
				<div className="space-y-3">
					<p className="break-all font-medium text-sm">{preview.data.repository}</p>
					<p className="text-sm">{preview.data.stack.join(" · ")}</p>
					<p className="text-(--color-text-2) text-sm">
						{preview.data.deliveryConfigured
							? "Release settings included; readiness must still pass."
							: "Release is not configured. Choose deployment settings before readiness checks."}
					</p>
					<Button disabled={create.isPending} onClick={() => create.mutate()}>
						{create.isPending ? "Creating repository…" : "Create this project"}
					</Button>
				</div>
			) : null}
			{preview.isError || create.isError ? (
				<Alert variant="danger" title="Project creation did not complete">
					{formatError(preview.error ?? create.error)}
				</Alert>
			) : null}
		</details>
	);
}
