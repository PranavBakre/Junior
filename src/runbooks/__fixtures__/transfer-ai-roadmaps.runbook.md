---
schemaVersion: 1
name: transfer-ai-roadmaps
description: Transfer every AI roadmap owned by one user to another user.
ownerAgent: db-executioner
intent:
  examples:
    - move all AI roadmaps from one account to another
    - transfer AI roadmaps from user A to user B
  excludes:
    - transfer arbitrary user-owned data
    - move one Notion roadmap
inputs:
  - name: sourceEmail
    type: email
    required: true
    description: Email of the current roadmap owner
  - name: targetEmail
    type: email
    required: true
    description: Email of the new roadmap owner
risk: production-write
approval:
  required: true
  afterSteps:
    - resolve-users
    - count-roadmaps
capabilities:
  - mongo.read
  - migration.execute
verification:
  required: true
  assertions:
    - source roadmap count is zero
    - target roadmap count increased by the matched count
tags:
  - database
  - ai-roadmaps
---

Resolve the source and target users by exact normalized email. Require exactly
one user for each input. Count the matching `airoadmaps` documents, then present
the exact source ID, target ID, filter, matched count, mutation path, and
rollback story for approval. Execute only after approval and verify both source
and target counts. S3 object keys are not rewritten because access is by key,
not by roadmap owner linkage.
