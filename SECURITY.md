# Security policy

## Reporting a vulnerability

Report a vulnerability in this repository through GitHub private vulnerability reporting:

https://github.com/forcepushcoin/pushy/security/advisories/new

If private reporting is not available on the repository, open a [GitHub issue](https://github.com/forcepushcoin/pushy/issues) and leave exploit details out of the public text. Say that you need a private follow-up, and include a way to reach you.

Please include the affected file and commit, what you expected, and what happened. If a secret was exposed, rotate it first and do not paste the live secret into the issue.

## What this covers

Pushy Score is a static page. It has no server, no account, and no stored scans. A vulnerability here is a problem in the published files: the scanner, the rules, or this repository's docs and templates.

A high score on a malicious repository is a detection gap, not by itself a vulnerability in Pushy. Open that as a [new rule](https://github.com/forcepushcoin/pushy/issues/new?template=new-rule.md) or a [false positive](https://github.com/forcepushcoin/pushy/issues/new?template=false-positive.md) issue. Use private reporting when the write-up would hand someone a working bypass against other people's skills.

## Scope notes

- Optional GitHub tokens are typed into the page and sent only to `api.github.com`. They are not written to `localStorage`. A bug that stored or forwarded a token belongs in a private report.
- The ruleset is pattern matching. It is not a boundary that other software should trust for access control.
