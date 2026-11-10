# Production delivery

Automatic production delivery is optional and disabled by default. It applies to
PlanRun children with a merged pull request. Enable it only after the project's
existing GitHub deployment workflow works through the manual Production panel.

```yaml
deploy:
  workflow: deploy.yml
  environment: production
  autoDeploy: true
  shaInput: factory_sha
  smokeUrl: https://your-project.example/health
  timeoutMs: 900000
  smokeTimeoutMs: 10000
```

The workflow must require the configured input, identify runs with that input,
and pin every `actions/checkout` step to it. Warren reads the workflow from the
PR's base branch and validates this contract before dispatch:

```yaml
run-name: Factory deploy ${{ inputs.factory_sha }}
on:
  workflow_dispatch:
    inputs:
      factory_sha:
        required: true
        type: string
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          ref: ${{ inputs.factory_sha }}
      # The project's own deployment and status-reporting steps follow.
```

The workflow must publish GitHub Deployment statuses for the configured
environment and the **input SHA**, not `github.sha`. The token needs Actions
read/write, Contents read, and Deployments read. Production approvals and
rollback remain the project's responsibility. Warren validates the declared
checkout contract and observed deployment; arbitrary deployment scripts remain
project-owned code and must actually deploy that checkout.

After merge, Warren captures the resulting 40-character merge or squash SHA,
records durable dispatch intent, then passes that SHA through the required input
once. It waits for a new successful run whose display title identifies that
input, verifies a new active successful Deployment on exactly that SHA, and
sends a bounded HTTP GET to `smokeUrl`. A workflow run's `head_sha` identifies
its workflow definition and is deliberately not treated as the deployed SHA.

The smoke response must be 2xx. Redirects fail the check. This checks HTTP
readiness; it does not replace application-specific browser acceptance tests.

The next ticket waits until all these checks pass. A failed workflow, wrong
commit, failed smoke check or verification timeout records a durable production
incident and fails the plan. Other plans for the project also wait. The incident
and its observed reason remain in the run's event history and retrospective
evidence. The tracker interface does not support creating issues, so Warren does
not claim to have filed an external incident ticket.

Cancelling a plan cannot clear a production incident or cancel a GitHub workflow.
While delivery verification is pending, the cancel API refuses that operation.

Inspect GitHub and the deployed application, perform any repair or rollback in
the project, then explicitly resume the failed plan. Resuming retains the same
child and pull request and rechecks delivery; it does not rerun implementation or
silently dispatch the deployment again. If Warren stopped after recording intent
but before recording confirmation, inspect whether GitHub received the request.
Start the workflow manually if necessary, then resume. No automatic retry can
safely resolve that ambiguous external mutation.

Manual and automatic dispatch share one per-project admission lock. Requests
leave atomic receipts under the server data directory's `deployment-intents/`,
so GitHub's delayed workflow visibility cannot admit a second request after a
restart. A manual receipt clears when a newly observed workflow finishes; an
automatic receipt clears only after verified delivery. Errors never silently
clear an uncertain request. The manual button passes the currently resolved
branch SHA when `shaInput` is configured.

For an unconfirmed **manual** request with no workflow appearing, inspect GitHub
first. If the request never arrived, stop Warren and remove only that project's
receipt before explicitly retrying. Its filename is the SHA-256 of the project
ID followed by `.json`; the JSON names the workflow, branch, timestamp and
previous run IDs. Do not remove an automatic receipt to resolve an incident:
its durable run events still block the queue, and the plan's Resume action is
the recovery path. This exceptional administrative step does not claim that an
ambiguous network mutation can be retried safely without inspection.

GitHub loads workflow definitions from a branch, so external edits can race the
source validation. The exact checkout input avoids deploying the branch tip by
accident; keep production workflow changes protected and serialize delivery in
the project's workflow.

The Production panel searches beyond its five visible history rows. Inactive
historical deployments are distinct from active success. Reads are bounded to
200 deployments; incomplete or failed reads show an unknown current release,
not "never deployed". A failed active-workflow lookup blocks manual dispatch.

GitHub reference: [workflow dispatch and inputs](https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event). The dispatch ref names the workflow branch or tag. The explicit input names the application commit to check out.
