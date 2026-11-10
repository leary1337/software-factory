import { expect, test } from "bun:test";
import { validateDeploymentWorkflow } from "./deployment-workflow.ts";

const WORKFLOW = `run-name: Factory deploy \${{ inputs.factory_sha }}
on:
  workflow_dispatch:
    inputs:
      factory_sha:
        required: true
jobs:
  deploy:
    steps:
      - uses: actions/checkout@v4
        with:
          ref: \${{ inputs.factory_sha }}
`;

test("deployment workflow requires an input and every checkout pinned to it", () => {
	expect(validateDeploymentWorkflow(WORKFLOW, "factory_sha")).toBe(true);
	expect(
		validateDeploymentWorkflow(
			WORKFLOW.replace("required: true", "required: false"),
			"factory_sha",
		),
	).toBe(false);
	expect(
		validateDeploymentWorkflow(WORKFLOW.replace("inputs.factory_sha", "github.ref"), "factory_sha"),
	).toBe(false);
	expect(validateDeploymentWorkflow(WORKFLOW, "other_input")).toBe(false);
	expect(validateDeploymentWorkflow("invalid: [", "factory_sha")).toBe(false);
});
