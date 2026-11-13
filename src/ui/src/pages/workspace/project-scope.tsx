import { createContext, type ReactNode, useContext, useLayoutEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";

const Scope = createContext({ project: "", setProject: (_value: string) => {} });
export function ProjectScope({ children }: { children: ReactNode }) {
	const [project, setProject] = useState("");
	return <Scope.Provider value={{ project, setProject }}>{children}</Scope.Provider>;
}

/** The URL is shareable; the authenticated shell retains scope between the three views. */
export function useProjectScope() {
	const scope = useContext(Scope);
	const [params, setParams] = useSearchParams();
	const fromUrl = params.get("project");
	const project = fromUrl ?? scope.project;
	const setProject = (value: string) => {
		scope.setProject(value);
		setParams(
			(prev) => {
				const next = new URLSearchParams(prev);
				next.set("project", value);
				next.delete("task");
				return next;
			},
			{ replace: true },
		);
	};
	useLayoutEffect(() => {
		if (fromUrl !== null) scope.setProject(fromUrl);
		else if (scope.project)
			setParams(
				(prev) => {
					const next = new URLSearchParams(prev);
					next.set("project", scope.project);
					return next;
				},
				{ replace: true },
			);
	}, [fromUrl, scope.setProject, scope.project, setParams]);
	return { project, setProject };
}

export function useWorkspaceLink() {
	const { project } = useContext(Scope);
	const [params] = useSearchParams();
	const selected = params.get("project") ?? project;
	return (path: string) =>
		["/overview", "/kanban", "/production"].includes(path)
			? `${path}?project=${encodeURIComponent(selected)}`
			: path;
}
