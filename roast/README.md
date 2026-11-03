# Pushy Roast — Commit Roast Card (v1.0.0)

Free, client-side tool: paste a public GitHub repo, get stats from its latest ~300 commits, a hand-written Pushy-voiced roast and a shareable 1200×630 card. No backend, no LLM, no account. Just for fun. Not a code review.

## Files
- `index.html`, `roast.css`: page (same GitHub-dark / Inter + JetBrains Mono style as `../score/`)
- `roast.js`: input parsing, GitHub fetch, stats (`analyze`), archetypes + roast templates (`roast`). Works in the browser (`window.PushyRoast`) and in node (`require`) for tests
- `card.js`: canvas renderer for the card (3 free themes: Terminal green, GitHub dark, Hazard; ASCII Pushy drawn as text)
- `app.js`: UI glue (form, `?repo=` autorun, cache, buttons, receipts panel)

## API usage
`GET /repos/o/r` + `commits?per_page=100&page=1..3` + `contributors?per_page=100` = 3 to 5 calls (the contributors call is skipped when the commits `Link` header shows a 10,000+ commit history, where GitHub refuses it). Results are cached in `localStorage` for 15 minutes (`pushy-roast:1:owner/repo`), so repeats cost 0. Optional token lives in memory only.

## Share links
`?repo=owner/repo&theme=terminal|github|hazard&tz=<utc offset>&r=<reroll number>`. The roast is deterministic: same stats + same `r` = same roast. "Post on X" opens `x.com/intent/post` with text + link (X cannot attach images from a URL, so users download the PNG and attach it).

## Honest limits
- GitHub's API returns commit times in **UTC**; the author's local offset is not exposed. "Night" = 00:00-04:59 in the selected clock (default UTC; the user can shift it).
- Stats are for the latest sampled commits, not the whole history. Merge commits are excluded from message stats. Hour/weekday use the author date; streaks, gaps and spans use the committer date.
- Commit text is HTML-escaped for the page, drawn with `fillText` on the card, and profanity-masked in displayed examples. The roast only talks about repo habits, never about individuals.

## Dev / deploy
`python3 -m http.server` in the parent folder and open `/roast/?repo=owner/repo`. Set `SITE_URL` at the top of `app.js` (currently `https://forcepushcoin.github.io/roast/`). No build step.
Premium themes are only a "planned" note in the UI: there is no payment or token gate.
