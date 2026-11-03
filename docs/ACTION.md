# Pushy GitHub Action

`uses: forcepushcoin/pushy@v1` scores the files in a workflow checkout with the same engine as the website (`score/rules.js` and `scanLocal` in `score/pushy.js`). Ruleset `pushy-rules` 1.1.0. Same limits (400 scannable files, 15 MB total, 500 KB each), the same skip rules, the same caps, and the same four sub-scores.

The action is a Node.js 20 action with no Docker image and no npm dependencies. It is not listed on the GitHub Marketplace. Point `uses` at this repository and the `v1` tag.

## Workflow

```yaml
name: Pushy
on:
  pull_request:
  push:
    branches: [main]
permissions:
  contents: read
  pull-requests: write
jobs:
  pushy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: forcepushcoin/pushy@v1
        with:
          fail-under: '70'
```

`contents: read` is enough to scan. `pull-requests: write` is what lets the token post the comment. On a `push` the comment step is skipped because there is no pull request. `fail-under` still applies.

Check out the repo before the action. The scan reads that checkout. It does not clone the repo again.

## Inputs

| Input | Default | What it does |
| --- | --- | --- |
| `path` | `.` | Directory to scan, relative to `GITHUB_WORKSPACE`. |
| `fail-under` | empty | Fail the job when the score is **below** this number. `70` fails on 69 and passes on 70. An empty value never fails because of the score. |
| `comment` | `true` | On `pull_request`, post or update one comment. Any other event logs a skip. `false` posts nothing. |
| `github-token` | `${{ github.token }}` | Sent only to `api.github.com`, to post the comment and to read changed file names. |

## Outputs

| Output | What it is |
| --- | --- |
| `score` | Integer from 0 to 100. |
| `band` | `green`, `yellow`, `orange`, `red`, or `gray`. |
| `report-path` | Absolute path of `pushy-report.json` written at the workspace root. |

The job summary (`GITHUB_STEP_SUMMARY`) gets a short version of the same verdict.

## What the scan does

`scanLocal` walks the directory. It does not descend into `.git` or the vendored directories the ruleset already skips (`node_modules`, `dist`, and the rest of `FILES.skipDirs`). File kind, priority, the byte budget, path rules, line rules, repo rules, coverage caps, and the score all come from `score/pushy.js`.

Repo rules that need GitHub metadata (archived, fork, description, created date, license SPDX) use the workflow event payload already on disk. Commit dates come from `git log` when the scanned directory is the git root. A subfolder scan does not borrow the parent repository's commit list.

Nothing in the tree is uploaded. The only requests are GitHub API calls for the pull request comment and, when that comment is on, the list of changed file names. File bodies from that API response are discarded. The JSON report stays on the runner.

## Private repositories

The job runs on your runner with your token. Private source stays in the checkout. Pushy does not operate a scanner service, and paying for anything, including $FORCEPUSH, does not change the score.

## The comment

One comment per pull request. The body starts with `<!-- pushy-score -->`. The next run edits that comment instead of adding another. The body has the verdict, the score out of 100, the band, the four sub-scores, a findings table (severity, rule id, `file:line` linked at the pull request head SHA, and the fix hint), a 🆕 mark when the file is in the pull request diff, the ruleset's blind spots, and this line:

```
Automated scan, not an audit · Pushy needs no token
```

Findings are capped in the comment after 40 rows. The JSON report keeps the rest, up to the ruleset's stored-hit cap.

## Sample

This is the comment for [`fixtures/evil`](../fixtures/evil): an AWS-shaped key in `scripts/setup.sh`, `curl | bash` on the next line, `Ignore all previous instructions` in `SKILL.md`, and a zero-width character in that same file. The score is **35/100**, band **red**, capped (raw 71). The sample's repo metadata says the license is MIT, so the engine lists "Has a license" even though that fixture directory has no `LICENSE` file. Links use the fixture SHA from the unit test, `0123456789abcdef0123456789abcdef01234567`.

```markdown
<!-- pushy-score -->
## 🐹 35/100 · Do NOT force push this 🔴

Serious red flags. Do not install or run this without a careful manual review.

Ruleset `v1.1.0` · commit `0123456`

Read **3** of **3** scannable files (budget 400 files / 15 MB).

| Category | Score |
| --- | --- |
| Secrets | 55 / 100 |
| Code & network | 75 / 100 |
| Prompt hygiene | 69 / 100 |
| Docs & upkeep | 94 / 100 |

### Findings

| Severity | Rule | Where | Fix |
| --- | --- | --- | --- |
| critical 🆕 | `S001` | [`scripts/setup.sh:2`](https://github.com/fixture/skills/blob/0123456789abcdef0123456789abcdef01234567/scripts/setup.sh#L2) | Revoke the key in AWS IAM now, rotate it, and load it from an environment variable or secret store. |
| high 🆕 | `X001` | [`scripts/setup.sh:3`](https://github.com/fixture/skills/blob/0123456789abcdef0123456789abcdef01234567/scripts/setup.sh#L3) | Download, pin a checksum or version, read the script, then run it. Prefer a package manager with lockfiles. |
| high | `P001` | [`SKILL.md:6`](https://github.com/fixture/skills/blob/0123456789abcdef0123456789abcdef01234567/SKILL.md#L6) | Delete it. If this is a security example, move it into a clearly-marked test fixture. |
| medium | `P011` | [`SKILL.md:8`](https://github.com/fixture/skills/blob/0123456789abcdef0123456789abcdef01234567/SKILL.md#L8) | Strip the invisible characters (e.g. `grep -nP "[\x{200B}-\x{200F}\x{202A}-\x{202E}\x{2066}-\x{2069}]"`) and re-read the file. |
| low | `A007` | [`SKILL.md:1`](https://github.com/fixture/skills/blob/0123456789abcdef0123456789abcdef01234567/SKILL.md#L1) | Add `allowed-tools` to the SKILL.md frontmatter with narrow patterns. |
| low | `D002` | [`README.md`](https://github.com/fixture/skills/blob/0123456789abcdef0123456789abcdef01234567/README.md) | Explain purpose, install, usage and permissions in at least a few paragraphs. |
| low | `D004` | `repository` | Add a SECURITY.md (or .github/SECURITY.md) with a contact and disclosure policy. |
| info | `N005` | `repository` | Make sure each host is expected and documented in the README. |

🆕 is a finding in a file this pull request changes.

### What looked good

- Has a license

### Blind spots

Pattern matching on text. A high score means no rule fired.
- This is pattern matching on text. Paraphrased, translated, split-up or cleverly obfuscated attacks will pass. Commercial skill scanners have been bypassed in under an hour.
- No LLM or human reads the instructions, so pure social engineering ("please download and run this helper") is only caught when it matches a rule.
- Links and docs a skill points to are never fetched. A page that is clean today can serve different instructions after you trust it.
- Binaries, archives, .pyc bytecode, office documents and images are not opened. Text hidden inside them is invisible to this scan.
- Only the files listed as analyzed were read (budget: 400 files, 15 MB total, 500 KB per file). Anything over budget or that failed to download is listed as not analyzed and caps the score.
- Dependencies are not scanned for known vulnerabilities or malware, and nothing is executed or sandboxed.
- Only the latest commit on the default branch is read. Other branches, tags, history, and future pushes are not covered.
- A high score means "no rule fired", not "safe". Read the code before you install or run anything.

Score capped at 35 (raw 71).

Automated scan, not an audit · Pushy needs no token
```
