# Pushy Score v1

Static, client-side risk scan for public GitHub repos of AI agent skills / MCP servers.
Automated scan, not an audit or guarantee.

- `index.html`, `score.css`, `app.js`: UI
- `pushy.js`: scan engine (GitHub API + SHA-pinned jsDelivr/raw fetches, scoring, badge)
- `rules.js`: the open, versioned ruleset (`pushy-rules` 1.0.0). Change a rule -> bump version + CHANGELOG
- Set `SITE_URL` at the top of `app.js` after deploying so badge markdown links back to the tool.
- Deploy: just serve the folder (GitHub Pages works). No build step, no backend.
- Dev: `python3 -m http.server` in the parent folder, open `/score/?repo=owner/repo`.
