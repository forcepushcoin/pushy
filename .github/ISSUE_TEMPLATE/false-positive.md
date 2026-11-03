---
name: False positive
about: A rule fired on something harmless
title: "false positive: "
---

## Rule

- Rule id (for example `P001`):
- Severity shown:
- Ruleset version shown on the result (for example `1.0.0`):

## Where it fired

Public repository URL, or a minimal snippet if the repo is private. Include the file path and line. Do not paste live secrets, tokens, or private keys. Redact them the way the scanner does.

## Why this is harmless

What is the file actually doing, and why should this pattern be allowed?

## Suggestion

- [ ] Tighten the `filter` (placeholder, negation, comment, or allow-listed path).
- [ ] Lower severity.
- [ ] Drop the hit on this path kind.
- [ ] Something else:

## Check

- [ ] I can name a malicious example that should still match after the change.
