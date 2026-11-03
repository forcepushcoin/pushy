# Pushy Rescue (v1.0.0)

Free, client-side tool: paste a public GitHub repo, get the Pushy Score findings with a concrete fix each, a `.patch` for the mechanical edits, a Markdown Rescue plan and a *projected* score. No backend, no LLM, no account. Suggestions are rule-based, not guaranteed safe. Details: [`../docs/RESCUE.md`](../docs/RESCUE.md).

## Files
- `index.html`, `rescue.css`: page (same style as `../score/`)
- `rescue.js`: fix generators, diff writer, plan renderer. Browser (`window.PushyRescue`) and node (`require`)
- `app.js`: UI glue (form, `?repo=` autorun, patch download, copy buttons)
- Uses `../score/rules.js` and `../score/pushy.js` (needs `keepContext` and `rescore`, added in the engine for Rescue)

## API usage
Same as Pushy Score: about 3 to 4 GitHub API calls per scan (anonymous limit 60 per hour per IP). Nothing is cached, because the fetched file texts are needed in memory. Optional token lives in memory only.

## Dev / deploy
`python3 -m http.server` in the parent folder and open `/rescue/?repo=owner/repo`. No build step. Tests: `node --test` from the repo root.
