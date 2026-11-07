# Agent skills

Skills for coding agents that work in this repository. Each folder holds one
`SKILL.md` in the open Agent Skills format: YAML front matter with `name` and
`description`, then Markdown instructions. Codex, Cursor, pi, and other agents
that read `.agents/skills/` load them on demand.

[`AGENTS.md`](../../AGENTS.md) sets the rules. A skill says how to apply them
to one kind of task. If the two disagree, `AGENTS.md` wins.

| Skill | Use it when |
|---|---|
| [tdd-workflow](tdd-workflow/SKILL.md) | You add a check or parser, or fix a bug. |
| [verification-loop](verification-loop/SKILL.md) | You are about to say the work is done. |
| [security-review](security-review/SKILL.md) | You touch code that reads stream bytes or renders stream text. |
| [benchmark](benchmark/SKILL.md) | You change a per-packet path or the page weight. |
| [browser-qa](browser-qa/SKILL.md) | You change the page. |
| [accessibility](accessibility/SKILL.md) | You add or change a control, tab, table, or chart. |
| [architecture-decision-records](architecture-decision-records/SKILL.md) | You make a decision that is hard to reverse. |
| [conventional-commit-review](conventional-commit-review/SKILL.md) | You write a commit message. |
| [search-first](search-first/SKILL.md) | You need a new parser, decoder, or tool. |

## Origin

These skills are adapted from the skills of the same name in
[ECC](https://github.com/affaan-m/ECC) at commit
`d2ef2680594f9a17526a6e1a2e18b3d242c5d17b`. They are rewritten for this
project: Node's test runner, a single-file browser page, binary input, and
no npm dependencies. ECC is under the MIT License:

```
MIT License

Copyright (c) 2026 Affaan Mustafa

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
