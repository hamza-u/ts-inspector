---
name: conventional-commit-review
description: Draft or check a commit message for this repository. Format type(scope): description, 50/72 rule, types feat, fix, docs, style, refactor, test, chore. Use before every commit, or when asked to write, fix, or review a commit message.
license: MIT
metadata:
  origin: adapted from ECC skills/conventional-commit-review
---

# Conventional commit review

## Format

```
type(scope): description

Body wrapped at 72 columns. Say why the change was made and what a
reviewer cannot see in the diff.

Footer lines, if any.
```

## Rules

1. **Subject line: 50 characters or fewer**, including `type(scope): `.
2. **Blank line** after the subject.
3. **Body lines: 72 characters or fewer.** Wrap by hand.
4. **Type** is one of:

   | Type | Use for |
   |---|---|
   | `feat` | New behaviour a user can see: a check, a panel, a command option. |
   | `fix` | Wrong behaviour made right. |
   | `docs` | README, AGENTS.md, skills, ADRs, comments only. |
   | `style` | Formatting, whitespace, naming. No change in behaviour. |
   | `refactor` | Structure changes. No change in behaviour. |
   | `test` | Tests, fixtures, golden files. |
   | `chore` | Build, CI, scripts, vendored modules, licences, `.gitignore`. |

   No other types. A performance change is `refactor` if behaviour is the same, or `fix` if it was a defect.
5. **Scope** is the area changed. Use one word, lower case. Common scopes: `psi`, `scte35`, `tr290`, `h264`, `hrd`, `tstd`, `timing`, `ui`, `report`, `cli`, `build`, `wasm`, `ci`. Leave the scope out only when the change has no single area.
6. **Description**: imperative mood ("add", not "added"), lower case first word, no full stop.
7. **Breaking change**: `!` before the colon, and a `BREAKING CHANGE:` footer that says what to do.
8. **Golden files**: when a commit changes `test/golden/`, the body says why each expected value changed.
9. **No employer names, internal hosts, customer names, or private file names**, in the subject, body, or footers.

## Workflow

1. Run `git diff --staged` (or `git diff` if nothing is staged) and `git log --no-merges --format=%s -20`.
2. If the diff mixes concerns, propose a split into separate commits. Do not pick one type for all.
3. Draft the message. Check it:

   ```sh
   msg_file=.git/COMMIT_EDITMSG_DRAFT
   awk 'NR==1 && length > 50 { print "subject is " length " chars" }
        NR==2 && length > 0  { print "line 2 must be blank" }
        NR>2  && length > 72 { print "line " NR " is " length " chars" }' "$msg_file"
   head -1 "$msg_file" | grep -Eq '^(feat|fix|docs|style|refactor|test|chore)(\([a-z0-9-]+\))?!?: [a-z]' \
     || echo "subject does not match type(scope): description"
   ```

4. Show the message. Commit only when the user has asked for a commit.

## Examples

```
feat(tr290): add PCR accuracy check

PCR_AC is measured against a straight-line fit of PCR versus packet
index. A sample outside 500 ns is a priority 2 error.
```

```
fix(psi): stop SDT parse at section length

A section with padding after the CRC read past its end and reported a
second, empty service.
```

```
chore(ci): publish the MIT-only page to Pages
```
