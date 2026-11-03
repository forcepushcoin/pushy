# Bounty board

Page that lists issues labelled `bounty` in `forcepushcoin/pushy` (open, and closed within 90 days) with status and reward. Client-side, one GitHub API call per load, cached 10 minutes in `localStorage` (`pushy-bounties:1:forcepushcoin/pushy`). Rules: [`../BOUNTIES.md`](../BOUNTIES.md). **Payouts are planned at launch; nothing is payable today.**

## Files
- `index.html`, `bounties.css`: page
- `bounties.js`: reward parser, status, normaliser, fetch (`window.PushyBounties` / `require`)
- `app.js`: UI glue. `CONFIG.BOUNTY_WALLET` is empty: the page shows "Pool wallet: announced at launch". Set it to the public Solana address once published and the page shows it with a Solscan link (a value that is not a valid base58 address is ignored).

## Status and reward
- `bounty` only: **proposed**. `bounty-accepted`: **open**. `bounty-claimed`: **claimed**. `bounty-paid`: **paid**. Closed without `bounty-paid`: **closed**.
- Reward: a `reward: 500 USDC` label is **confirmed** (only maintainers can label). A `Reward: 500 USDC` line in the body or title is shown as "as written by author". Text that is not an amount plus a unit (or `TBD`) is ignored, so prose can never show up as a reward. The board shows only what the issue says, never a computed or invented number.
- Issue text is escaped, links are forced to `github.com/forcepushcoin/pushy/issues/<n>`.

Tests: `test/bounties.test.js` (mock fetch).
