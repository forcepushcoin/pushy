# Pushy Watchlist

Watch other people's repos (the skills and MCP servers you depend on) with the same ruleset as Pushy Score, on **your own** GitHub Actions schedule. When a score drops or a new critical finding appears, the action adds a comment to one tracking issue in your repo. GitHub then emails you, as it does for any issue activity.

It is a mode of the existing [Pushy GitHub Action](ACTION.md). Set `repos:` and the action stops scanning the checkout and scans those repos instead. Without `repos:` nothing changes.

Pushy runs no server for this. The scan runs on your runner, with your token, and the state lives in your issue. Using it needs no $FORCEPUSH token, and paying for anything never changes a score.

## Quick start

1. In a repo you own, add [`examples/watchlist.yml`](../examples/watchlist.yml) as `.github/workflows/pushy-watch.yml`.
2. Edit the `repos:` list. One `owner/repo` per line, or `owner/repo@branch-or-tag`. A full `https://github.com/owner/repo` URL works too. `#` starts a comment. Up to 25 repos.
3. Run it once from the Actions tab (**Run workflow**). The first run creates an issue titled **Pushy watchlist** with the label `pushy-watch` and records a baseline. It never alerts on the first run.
4. Watch the issue (**Subscribe**) to get emailed. Alerts are comments on that issue.

## Inputs (watch mode)

| Input | Default | What it does |
| --- | --- | --- |
| `repos` | empty | The watchlist. Setting it turns watch mode on. |
| `drop-threshold` | `5` | Alert when a score falls by at least this many points since the last run. |
| `alert-severity` | `critical` | Alert on a new finding at this severity or worse (`critical`, `high`, `medium`). |
| `alert-below` | empty | Also alert once when a score crosses under this number. No repeat while it stays under. |
| `issue-label` | `pushy-watch` | Label that identifies the tracking issue. Use another label for a second watchlist in the same repo. |
| `issue-title` | `Pushy watchlist` | Title used when the issue is created. |
| `dry-run` | `false` | Scan and print only. No issue, comment, or label is written. Good for a first try. |
| `fail-on-alert` | `false` | Fail the job when there is an alert. |
| `github-token` | `${{ github.token }}` | Writes the tracking issue in **this** repo. |
| `read-token` | empty | Optional. Clones watched **private** repos. Public repos need none. |

Outputs: `alerts` (count), `report-path` (`pushy-watch-report.json`), `issue-url`. `path`, `comment` and `fail-under` are ignored in watch mode.

## What counts as an alert

Compared with the last stored run for the same repo:

- **Score drop**: the score fell by `drop-threshold` or more.
- **New finding**: a finding at `alert-severity` or worse that was not there before. A finding is identified by rule id and file path, not by line number, so moving code inside a file does not re-alert (and a second hit of the same rule in the same file does not either).
- **Crossed `alert-below`**: the score went from at or above the line to under it.
- **Repo became unreadable**: it was scanned before and now cannot be cloned (deleted, renamed, made private). Once, not every day.

Score rises, repeated known findings and a repo that was already failing do not alert. A repo seen for the first time is a baseline only.

If Pushy ships a new ruleset version, the run is a **re-baseline**: scores may move because the rules changed, not the repo, so that run does not alert. The issue says so.

## How it works

1. For each repo it runs `git clone --depth 30` over HTTPS into a temp directory, with hooks, submodules, LFS and symlink checkout turned off. Nothing from the repo is ever executed or installed.
2. It runs `scanLocal` from `score/pushy.js` on that directory, the same function the action uses on a checkout. Same 400-file, 15 MB, 500 KB limits and caps as Pushy Score.
3. It reads the previous baseline from the tracking issue, compares, and rewrites the issue body: a table with score, change, critical and high counts, and the commit that was scanned.
4. If there are alerts, it adds **one** comment, `<!-- pushy-watch-alert -->`, listing them. A closed issue is reopened.

The baseline is a small base64 comment hidden in the issue body (`<!-- pushy-watch-state:... -->`). Please do not edit it. If you delete the issue, the next run creates a new one and starts a new baseline.

## Permissions and tokens

- Public repos: `issues: write` is all the workflow needs. The default `github.token` is sent to `api.github.com` only: to read and write your tracking issue and to read each watched repo's public metadata (archived, license, and so on). It is not given to `git`, and public clones are anonymous.
- Private watched repos: pass a fine-grained token with **Contents: read** on exactly those repos as `read-token`. It reaches `git` through `GIT_CONFIG_*` environment variables, never in a command line or URL, and is scrubbed from any error text. Remember anyone who can edit the workflow in your repo can use that secret.
- Forks and `pull_request` triggers: use `schedule` and `workflow_dispatch` only. Do not run this on events that untrusted people can start.

## What the issue and comments never contain

Watched repos are untrusted input. Alerts show the rule id, severity, rule title, file path and line, each inside a code span, and a link to the commit. They never quote text from the repo (no snippets), so a malicious repo cannot inject Markdown, `@mentions`, or links into your issue. Review a finding by opening the file at the linked commit.

## Limits

- Pushy Score is pattern matching on text. It is an automated scan, not an audit, and a high score does not mean a repo is safe.
- Max 25 repos per watchlist. Each clone is a shallow one, so the "quiet commit history" and "single recent author" rules see only the last 30 commits. The repo-metadata rules (archived, fork, description, license) use one repository API call per repo and are skipped if it fails.
- Do not watch `forcepushcoin/pushy`. `fixtures/evil` is a planted bad sample for tests. The test workflow scans `fixtures/clean` and `fixtures/evil` only as isolated `path` inputs, with `repos` unset, so those files cannot raise a watch alert.
- A daily cron is not real time. A repo can change between two runs. GitHub may delay scheduled runs and disables them after 60 days of repo inactivity.
- GitHub rate limits apply to the metadata call (one per repo). Clones are not API calls.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `Could not read the tracking issue` | Add `permissions: issues: write`. |
| `could not clone (not found, private, or no access)` | Check the spelling and ref. For a private repo set `read-token`. |
| Nothing alerts on the first run | By design. The first run is the baseline. |
| An alert you do not care about keeps coming | It will not repeat for the same finding. Raise `alert-severity` or `drop-threshold` to quiet it. |
