# Pushy Rescue

Rescue takes a [Pushy Score](../score/) scan and turns each finding into a fix. It is free, runs in your browser, has no backend and no model. Live at <https://forcepushcoin.github.io/rescue/>.

**Suggestions, not guarantees.** Edits are made by rules, not reviewed by a person. Read every hunk and run your tests. Rescue never runs your code and never changes your real Pushy Score.

## What you get

1. **A `.patch` file** (unified diff) with the edits a rule can make mechanically. Apply it with `git apply --check pushy-rescue.patch && git apply pushy-rescue.patch`.
2. **A Rescue plan** (Markdown, with a copy button) listing: secrets to rotate first, the patched edits with their re-scan result, a checklist for everything a patch cannot change, and signals that are not defects.
3. **A projected score.** Rescue re-runs the exact same engine and ruleset on the patched file contents. The number is a what-if, labelled *projected*. It counts every edit as done (including edits marked "You still need to"), assumes leaked secrets are rotated, and is shown only when the unpatched re-run reproduces the real score.

## Mechanical edits

Only plain line edits, only in files Rescue fully fetched, never in a file with mixed line endings, never a file deletion.

| Rule | Edit |
| --- | --- |
| `S001` `S002` `S003` `S004` `S006` `S007` `S011` | Replace a committed secret with an env-var reference for the file type (shell `${NAME:?set NAME in your environment}`, `process.env.NAME`, `os.environ["NAME"]` when `os` is imported, `${{ secrets.NAME }}` in workflows, `${NAME}` in config, `<YOUR_NAME>` in docs). Single-quoted shell and `.env` files are left to you. |
| `S005` | Delete a private-key block from a text file. Key files (`.pem`, `id_rsa`, …) are a manual `git rm`. |
| `X001` | In a shell script, replace `curl … \| bash` with: download to a temp file, `sha256sum -c` against a placeholder `REPLACE_WITH_SHA256`, then run. It fails until you read the script and paste the real checksum. |
| `X010` | `git push --force` / `-f` becomes `--force-with-lease`. |
| `N004` | `http://` URL becomes `https://` (check the host supports it). |
| `P011` | Remove hidden characters (zero-width, bidi, tag). A leading BOM stays. |
| `P001` `P002` `P009` | Delete the flagged instruction line in a markdown or text file. |
| `P004` | Remove the HTML comment that carries instructions. |
| `P013` | Collapse the padding that hides text. |
| `A004` | Remove install-time `scripts` hooks from `package.json` (JSON is re-parsed). |
| `A005` | Remove `--extra-index-url` / `--trusted-host` lines from requirements files. |
| `A006` | Replace `permissions: write-all` with `contents: read`. |
| `D004` | Add a `SECURITY.md` pointing at the repo's private advisory form (turn on private vulnerability reporting). |

Everything else (dependency pinning, license, README, MCP and agent permissions, `allowed-tools`, `eval`, network calls, …) becomes a concrete checklist step in the plan, because it needs a decision, a network lookup, or knowledge of your code.

## Safety rules

- **Re-scan every fix.** Each edit shows "cleared" or "N still flagged". New findings introduced by the patch are listed.
- **Fail closed.** Placeholders break loudly instead of silently working.
- **Secrets are masked** on screen and in the plan (first 4 characters plus `••••`). The `.patch` file itself must contain the old line to remove it. **Do not post it publicly**, and rotate the credential: deleting it from the files does not remove it from git history or from anyone who cloned the repo.
- Repo-controlled text (paths, snippets) is escaped for Markdown and HTML.
- The scan limits of Pushy Score apply (400 files, 500 KB each, 15 MB total). Files that were not fully fetched get no patch.

## Code

`rescue/rescue.js` (UMD, no DOM, no network) exports `build(report)`, `unifiedDiff`, `renderPlan`, `redact`, and the generator table `GEN`. `build` needs a report made with `Pushy.scan(repo, { keepContext: true })` or `Pushy.scanLocal(dir, { keepContext: true })`. `keepContext` keeps the fetched file texts so `Pushy.rescore(context, overrides)` can re-run the engine on edited contents. Tests: `test/rescue.test.js` (`node --test`), including `git apply --check` on the generated patch and a check that the projected score equals a real re-scan of the patched fixture.
