import type { ProjectSettings } from "./project-settings.ts";
export interface NewProjectRequest {
	owner: string;
	name: string;
	template: "go-react";
	settings?: ProjectSettings;
}
export interface NewProjectPreview {
	request: NewProjectRequest;
	repository: string;
	stack: string[];
	settings: ProjectSettings;
	confirmation: string;
	deliveryConfigured: boolean;
}
