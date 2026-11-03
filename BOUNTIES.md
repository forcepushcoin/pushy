# Pushy Bounties

A community bounty board for Pushy. **Status: planned at launch.** The bounty wallet does not exist yet, so nothing is payable today. You can already open bounty issues and contribute; payouts only start once the wallet is published.

## What qualifies

- **New Pushy rules** with a hit case and a benign non-hit case (see `CONTRIBUTING.md`).
- **False-positive fixes** with a minimal repro.
- **Verified real-world risky repo reports**, responsibly disclosed: tell the repo owner privately first (use their security contact or a private advisory) and give them reasonable time to fix before anything is public. Never post live secrets or working exploits.
- **Tool features** for Pushy Score, the Pushy Action, or the Roast Card.

## How to submit

Open a GitHub issue with the **Bounty** template (`.github/ISSUE_TEMPLATE/bounty.yml`). Link a PR when you have one. One issue per submission. Security problems in Pushy itself go through the private advisory link in `SECURITY.md`, not a public issue.

## Review and payout

1. A maintainer reviews the submission and labels it `bounty-accepted` or explains why not.
2. The amount is posted on the issue, per bounty, before or at acceptance. For the [bounty board](https://forcepushcoin.github.io/bounties/) a maintainer adds a label `reward: <amount> <unit>` (for example `reward: 500 USDC`). Only maintainers can set labels, so the board shows a labelled amount as **confirmed**. A line `Reward: <amount> <unit>` in the issue body or title is shown as **as written by the author** and is not an offer.
3. Payout is in **$FORCEPUSH**, sent from a **public, labeled bounty wallet**. The address will be published here and on the official X account at launch (**TBD**).
4. You provide a Solana address on the issue. Never share a seed phrase or private key with anyone.

## Labels on the board

| Label | Meaning on the board |
| --- | --- |
| `bounty` | Added by the template. Shown as **proposed** until a maintainer reviews it. |
| `bounty-accepted` | Shown as **open**. |
| `bounty-claimed` | Shown as **claimed**. |
| `bounty-paid` | Shown as **paid**. Only used once payouts exist. |
| `reward: 500 USDC` | Confirmed amount. Without it the board shows "TBD" or the author's own `Reward:` line. |

The board reads only the issue list (one GitHub API call): titles, bodies and labels, not comments.

## Rules

- No guarantees. Amounts depend on what the pool holds and on the maintainer's judgment.
- Maintainer decision is final.
- No payout for spam, duplicates, AI-generated noise, or low-effort reports. The first valid submission wins.
- **Never for scores.** Paying or holding $FORCEPUSH never changes a Pushy score, and bounties cannot be used to raise or lower anyone's score. Basic scans stay free.
- The pool is funded by a dev buy at launch. $FORCEPUSH is a meme coin: its value can go to zero, and nothing here promises any return.
- Pushy is an automated scan, not an audit.
