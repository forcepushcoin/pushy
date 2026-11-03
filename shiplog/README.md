# Pushy Ship Log (v1.0.0)

Free, client-side tool: paste a public GitHub repo, pick 7 / 30 / 90 days, and get a changelog of what it shipped: releases, merged PRs, commit count, top contributors, grouped into feat / fix / docs / chore / other. Export as Markdown, a 1200×630 PNG card, or a Post-on-X link. No backend, no LLM, no account. Automated summary, not an audit.

## Files
- `index.html`, `shiplog.css`: page (same GitHub-dark / Inter + JetBrains Mono style as `../roast/`)
- `shiplog.js`: input parsing, GitHub fetch, `classify`, `summarize`, `toMarkdown`. Works in the browser (`window.PushyShiplog`) and in node (`require`) for tests
- `card.js`: canvas renderer for the card (3 themes: Terminal green, GitHub dark, Hazard; ASCII Pushy drawn as text; same look as `../roast/card.js`)
- `app.js`: UI glue (form, `?repo=&days=&theme=` autorun, cache, buttons, changelog list)
- `test.js`: offline tests with a mock GitHub API (`node test.js`)

## API usage (unauthenticated, 4 to 7 calls, cached 15 min in localStorage per repo+window)
1. `GET /repos/o/r`
2. `GET /repos/o/r/releases?per_page=30` (draft releases skipped; filtered to the window)
3. `GET /search/issues?q=repo:o/r is:pr is:merged merged:>=YYYY-MM-DD` (up to 2 pages = 200 PRs; the search API has its own 10 req/min limit and returns the exact `total_count`). This beats paging `pulls?state=closed`, which cannot filter by merged date and needs many pages on busy repos.
4. `GET /repos/o/r/commits?since=...&per_page=100` (latest 100 commits in the window)
5. `GET /repos/o/r/commits?since=...&per_page=1`: only when 100 commits came back, to read the exact total from the `Link: rel="last"` header
6. `GET /repos/o/r/tags?per_page=8`: only when the repo has no releases at all (tags are listed undated: GitHub does not date them in the list call)

An optional token lives in memory only and is sent only to `api.github.com`.

## How things are grouped
Title prefix first (`feat:`, `fix(scope):`, `docs:`, `chore/ci/build/test/refactor/perf/style/deps:` → chore), then PR labels (bug, documentation, enhancement, dependencies…), then plain keywords ("Fix…", "Add…", "Bump…", bot "Update…"), otherwise "other". The changelog uses merged PRs when there are any, otherwise commit subjects (merge commits skipped).

## Honest limits
- PR list is capped at the latest 200 and commits at the latest 100 in the window; counts (`total_count`, commit total) stay exact and the UI says "latest N of M".
- Contributors: merged-PR authors when PRs exist (merge-commit repos credit the merger on commits), else non-merge commit authors. Capped samples show "N+".
- Releases fetched: latest 30; "30+" is shown when all 30 fall in the window.
- Window starts at 00:00 UTC, N days ago.
- The search index can lag a few minutes behind GitHub.
- All repo text is HTML-escaped on the page and drawn with `fillText` on the card; in Markdown, `[ ] < >` are escaped and only `https://github.com/` links are kept. Contributor names are links without `@`, so pasting the changelog into an issue pings nobody.

## Dev / deploy
`python3 -m http.server` in the parent folder and open `/shiplog/?repo=owner/repo&days=30`. Set `SITE_URL` at the top of `app.js` (currently `https://forcepushcoin.github.io/shiplog/`). No build step. Nothing here needs the token: basic tools stay free.
