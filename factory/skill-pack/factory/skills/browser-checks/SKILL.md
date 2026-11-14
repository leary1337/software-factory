---
name: browser-checks
description: Verify a browser interface or reproduce a UI defect using the shared local Playwright tools and the project's saved tests.
---

Read the project's browser test command and acceptance scenario before changing UI code.
Run the saved Playwright tests against the required application version. For a defect,
first preserve a failing assertion that demonstrates it, then verify the same assertion
after the change. Check the project's supported phone/desktop sizes and themes.

Use the shared `factory_playwright` MCP for interactive inspection. It starts a fresh
local browser profile. For CLI fallback, read [PINNED-CLI.md](PINNED-CLI.md)
beside this installed skill and use its exact command and version. The installer
generates that reference from the selected toolkit. Keep the project's own
Playwright test version and lockfile. If the reference is missing, report incomplete
toolkit delivery before using CLI fallback.

Finish with reproducible test output and the exact version tested. An interactive
browser session supplements this evidence. It does not replace the saved tests.
Close the browser session when finished. If the browser cannot start, report the
failure and the missing evidence. Paid browser services require a separate decision.
