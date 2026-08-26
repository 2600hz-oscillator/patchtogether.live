---
name: deploy
description: Inspect or operate application releases, GitHub Actions deploy workflows, dev/autotest/prod environments, post-deploy verification, incidents, and secrets.
---

# Deploy

Deployment changes external state. Inspect freely, but deploy, roll back, rerun,
or change shared configuration only when the user explicitly asks.

## Establish current truth

1. Read `.github/workflows/deploy.yml`,
   `.github/workflows/daily-prod-deploy.yml`, and the relevant runbook before
   acting. Workflow code wins over prose.
2. Resolve the full commit SHA and verify its CI conclusion.
3. Confirm the requested tier and whether web, relay, or both are in scope.

Current topology: pushes to `main` deploy autotest and dev; production is
shipped nightly from the latest green `main`. Manual and version-bump paths
also exist, so re-check triggers rather than assuming this summary is complete.

## Operate safely

- Use the checked-in workflow/Taskfile entry point and follow
  `runbooks/deployment.md`.
- Never deploy an unverified/red commit. Do not infer permission for production
  from permission for dev.
- Never print secret values, credential-file locations, account identifiers, or
  endpoint topology. `runbooks/secrets-and-accounts.md` is the only repository
  home for that inventory.
- After deployment, verify the live tier reports the intended full SHA and run
  its smoke/health path. Report a partial deploy plainly; do not hide it behind a
  green build step.
- Prefer fix-forward. Rollback is a shared-system action and needs explicit
  owner direction.

Do not create an issue unless the owner explicitly approves it. A PR does not
need an issue; automated alert issues keep their workflow-owned lifecycle.
