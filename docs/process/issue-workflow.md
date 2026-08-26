# Issue workflow

Issues are owner-controlled, not required PR paperwork.

- Agents create or reopen an issue only after explicit owner approval.
- A PR does not need a corresponding issue. Its body is the searchable record.
- If an approved/existing issue is resolved, use `Fixes #N` or `Closes #N`.
- Fold a defect found during planned work into the same PR when coherent. If it
  is separate or too large, report it to the owner instead of filing it.
- Never close an existing issue because it merely appears stale; require a
  merged fix or explicit owner direction.
- Automated health-alert issues are exempt because their workflows own their
  lifecycle.

After approval, record reproducible evidence and the commit SHA in the issue.
Do not create an issue solely to satisfy a template, checklist, or perceived
one-to-one issue/PR convention.
