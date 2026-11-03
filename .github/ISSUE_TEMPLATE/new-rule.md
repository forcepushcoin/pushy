---
name: New rule
about: Propose a detection rule for Pushy Score
title: "rule: "
---

## Rule

- Suggested id (unused; prefixes already in `rules.js` are `S`, `X`, `N`, `P`, `H`, `A`, `D`, `M`):
- Category: `secrets` / `code` / `prompt` / `docs`
- Declared severity: `critical` / `high` / `medium` / `low` / `info`
- Runner: line / special / path / file / repo

## What it should match

Paste a minimal snippet or name a public file. Describe the line, path, or repo fact that should fire.

## What it must not match

Paste at least one benign snippet that looks similar and must stay quiet. See `CONTRIBUTING.md` for placeholder, negation, comment, and docs-path cases.

## Why it matters

What can go wrong if this ships inside a skill, MCP server, or prompt library?

## Suggested fix text

One sentence a maintainer can show next to the finding.

## Scanner change

- [ ] I can add this in `score/rules.js` (bump `RULESET.version` and the changelog comment).
- [ ] I will regenerate `docs/RULES.md` with `node scripts/generate-rules-md.js`.
- [ ] I ran the node check from `CONTRIBUTING.md` for a hit and a non-hit.
