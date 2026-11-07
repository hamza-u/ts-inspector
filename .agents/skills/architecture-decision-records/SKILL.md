---
name: architecture-decision-records
description: Record a hard-to-reverse decision for TS Inspector as a numbered ADR in docs/adr/. Use for licence changes, new vendored programs, new dependencies, output formats, build or hosting changes, or when the user says "record this decision".
license: MIT
metadata:
  origin: adapted from ECC skills/architecture-decision-records
---

# Architecture decision records

## When

Write an ADR when a decision is expensive to undo or a future contributor will ask "why":

- The licence of our code or of the built page.
- A new program in `vendor/`, or a new npm or PyPI dependency.
- A change to the JSON report format or the command's exit codes.
- A change to how the page is built or hosted.
- A choice between two readings of a specification.

## How

1. Read `docs/adr/README.md` and find the next number.
2. Copy the template below to `docs/adr/NNNN-short-title.md`.
3. Fill it in. Keep it under one page. Name the alternatives you rejected and why.
4. Add a line to the index in `docs/adr/README.md`.
5. Status starts as `proposed`. The user changes it to `accepted`.
6. Never edit an accepted ADR's decision. Write a new ADR that supersedes it, and set the old one to `superseded by ADR-NNNN`.

## Template

```markdown
# ADR-NNNN: Title

- Date: YYYY-MM-DD
- Status: proposed | accepted | deprecated | superseded by ADR-NNNN

## Context

The problem and the constraints, in 2 to 5 sentences.

## Decision

What we do, in 1 to 3 sentences.

## Alternatives

### Name
- For:
- Against:
- Rejected because:

## Consequences

- Easier:
- Harder:
- Risks and how we watch them:
```

Do not name people, employers, or customers in an ADR. Name roles if needed ("the maintainer").
