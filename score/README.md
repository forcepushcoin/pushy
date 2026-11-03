# Pushy Score v1.1

Static, client-side risk scan for public GitHub repos of AI agent skills / MCP servers.
Automated scan, not an audit or guarantee.

## Files
- `index.html`, `score.css`, `app.js`: UI (progress bar, results, blind spots, compact disclaimer with a collapsed "details" list)
- `pushy.js`: scan engine (GitHub API, SHA-pinned jsDelivr/raw fetches, scoring, badge)
- `rules.js`: the open, versioned ruleset (`pushy-rules` **1.1.0**) and the scan LIMITS. Change a rule -> bump version + CHANGELOG
- `example-badge.svg`: sample badge

## How a scan works
1. About **3-4 GitHub API calls** per scan (repo, latest commit, recursive tree; one more for a truncated tree or sub-folder). The anonymous limit is 60/hour per IP.
2. File bodies come from jsDelivr (`cdn.jsdelivr.net/gh/o/r@SHA/path`), falling back to `raw.githubusercontent.com`. Neither counts against the API limit.
3. Fetches run in a pool of 10 with 3 attempts per source, exponential backoff + jitter and a 25 s timeout. 403/404/413/451 fall through to the next source. A file that fails on both is listed as **not analyzed** with the reason, and caps the score.
4. Each file is analyzed as it arrives; the loop yields to the browser regularly so the progress bar ("Scanning N/M files...") stays live.

## Budget (rules.js `LIMITS`)
400 scannable files, 15 MB total, 500 KB per file. Files are picked by priority (core instruction files, skill scripts, configs first). A repo over budget lists the rest as not analyzed, caps the score and suggests scanning a sub-folder (`github.com/o/r/tree/main/<folder>`). Coverage caps apply only when coverage is really incomplete (skipped files, truncated tree, binaries/archives that cannot be opened, nothing to scan).

## Noise control (1.1.0)
- Docs/test/example paths downgrade prompt and code findings by one level (tests a second level for shell-exec rules).
- Prose files (`.md/.mdx/.rst/.txt`): shell-exec rules drop one level.
- Sentence-scoped "defensive context" (quoted, negated or discussed attack text) lowers prompt rules, only in instruction/prose files, never in code or config. Core instruction files drop one level at most.
- Comment-only lines are skipped for code/network/prompt rules; calls to well-known API hosts are not flagged as exfiltration; repeated hits in one file are collapsed ("+N more in this file").

## Dev / deploy
- Set `SITE_URL` at the top of `app.js` (currently `https://forcepushcoin.github.io/score/`) so badge markdown links back to the tool.
- Deploy: serve the folder (GitHub Pages works). No build step, no backend.
- Dev: `python3 -m http.server` in the parent folder, open `/score/?repo=owner/repo`.

## Limits
Pattern matching on text only. Binaries, archives, images and office files are not opened. Linked pages are not fetched. Only the latest commit of the default branch (or the given ref) is read. Dependencies are not scanned for CVEs and nothing is executed. Paraphrased or obfuscated attacks will pass.
