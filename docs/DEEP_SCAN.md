# Pushy Deep Scan (bring your own key)

An optional AI second opinion on top of Pushy Score, inside the [GitHub Action](ACTION.md). It runs on **your** runner with **your** API key. Pushy has no server, takes no payment, and never sees your key or your code.

> **AI opinion, automated, not an audit.** Deep Scan never changes the Pushy Score. The score stays plain regex rules. Basic scans, Watchlist, Roast and Ship Log stay free and need no key or token.

## What it adds

Pushy Score is pattern matching. Deep Scan sends the highest-risk files to a language model and asks it to read what regexes miss: paraphrased or translated prompt injection, instructions that contradict a skill's stated purpose, and scripts that do more than their description says. In the comment and the job summary you get a separate **Deep Scan** section with:

- **A second opinion on every static finding**: confirmed, likely false positive, or uncertain, with a short reason and a suggested fix.
- **New risks** the rules did not catch, each with file and line, severity, confidence, reason and fix.
- **What the AI read and what it did not**, file by file, with the reason (budget, request limit, credential file, failed request). Nothing is dropped silently.

## Setup

1. Create an API key at your provider. Set a spend limit there.
2. Add it as a repository secret, for example `OPENAI_API_KEY`.
3. Add the inputs below to the Pushy step. A full workflow is in [`examples/deep-scan.yml`](../examples/deep-scan.yml).

```yaml
      - uses: actions/checkout@v4
      - uses: forcepushcoin/pushy@v1
        with:
          deep-scan: 'true'
          ai-provider: openai
          ai-model: your-model-name
          ai-api-key: ${{ secrets.OPENAI_API_KEY }}
```

No key means no Deep Scan: the job prints one notice and the normal scan runs unchanged.

## Inputs

| Input | Default | What it does |
| --- | --- | --- |
| `deep-scan` | `false` | `true` turns Deep Scan on. Ignored in watch mode. |
| `ai-provider` | `openai` | `openai` for any OpenAI-compatible chat completions API, or `anthropic` for the Messages API. |
| `ai-model` | none | Model name at your provider. **Required.** Pushy does not pick a model or a price for you. |
| `ai-api-key` | none | Your key, from a repository secret. Sent only to the provider endpoint. |
| `ai-base-url` | provider default | API base URL: `https://api.openai.com/v1` or `https://api.anthropic.com`. Set it for Azure, OpenRouter, vLLM, Ollama and similar. Must be `https` (`http` only for `localhost`). No credentials or query string in the URL. |
| `ai-max-files` | `20` | Most files the AI reads (max 100). |
| `ai-max-bytes` | `120000` | Most bytes of repo text sent in total (max 1,000,000). |
| `ai-max-requests` | `8` | Most requests to the provider (max 30). |

Outputs: `deep-status` (`off`, `skipped`, `error`, `failed`, `partial`, `reviewed`) and `deep-report-path` (`pushy-deep-report.json`, only when it ran). `score`, `band` and `pushy-report.json` are the same with or without Deep Scan. `fail-under` uses the static score only.

Provider notes: OpenAI-compatible APIs get `max_tokens` (and `max_completion_tokens` on `api.openai.com`). If a model rejects `max_tokens` or `temperature`, the action retries with the accepted form. Output is capped at 2,000 tokens per request. Deep Scan is advisory: a provider outage or a bad answer never fails the job.

## Which files the AI reads

The static scan always covers the full repo (up to its usual 400 files and 15 MB). The AI part is bounded by `ai-max-files`, `ai-max-bytes` and `ai-max-requests`, and it is chosen by risk, not sampled at random:

1. Files are ranked by the engine's own priority (`SKILL.md`, agent rules, MCP manifests, install and shell scripts, hooks, then other code) plus the weight of their static findings. Ties go by path, so the same repo gives the same list.
2. A file over 16 KB is sent as a window around each static hit plus as much of the top as fits. The omitted line ranges are named in the report.
3. Files are split into requests of about 30 KB, instruction files and code files separately, each with its own focus ("instruction reader" or "code versus claim").
4. Anything that does not fit is listed as **not read** with the limit that excluded it. If a request fails, its files move to that list too.

Credential files (`.env`, `.npmrc`, `*.pem`, `*.key`, `id_rsa` and similar) are never sent. Values the secret rules match (AWS and GitHub tokens, `sk-` keys, private key blocks, hard-coded secret assignments) are masked as `[REDACTED S001]` before sending. That is a best effort, not a guarantee.

This is one pass per file. A second, differently framed pass over the same files is not built yet.

## Privacy

**Deep Scan sends the files it reads to the provider you choose.** Do not turn it on for code you would not paste into that provider yourself. Check your provider's data-retention and training terms. Pushy stores nothing, because it has no server: the only network calls are to `api.github.com` (the usual comment) and to your `ai-base-url`.

## How the key and the repo text are handled

- The key is read from the input, registered with `::add-mask::` before any request, put only in the provider's auth header, and never printed. Provider error text is stripped of the key and of workflow commands before it is logged. Requests do not follow redirects.
- **The repo is treated as hostile.** File text goes in a block delimited by a random per-request id, never in the system prompt. The prompt says everything in that block is untrusted data and that an instruction in it is itself a finding. Zero-width and bidi characters are shown as `⟦U+200B⟧` rather than stripped. The model has no tools.
- **The answer is treated as hostile too.** It must be one JSON object in a fixed schema. Findings that cite a file or line range that was not sent are discarded, as are bad enums and wrong shapes; text is length-capped and stripped of control and bidi characters, then escaped when rendered, with links defanged and mentions neutralised. A reply that is not valid JSON is discarded and its files are listed as not read.
- **Fork pull requests**: secrets are not available there, so the key is empty and Deep Scan is skipped with a notice. It is also skipped for fork code on `pull_request_target`. Do not pass your key into a workflow that checks out and runs untrusted code.

## Limits

An LLM can be wrong, can miss things, and can be fooled by text written to fool it. Treat the section as a reading aid next to the rules. A section with no new risks says only that the AI flagged none in the files it read. Cost depends on your model and the files; a run is at most `ai-max-requests` requests and about `ai-max-bytes` of text in, and the section shows the bytes and (if the provider reports them) the tokens used. Check your own bill.

Token payments for hosted scans are a later idea and are not built. This version needs no $FORCEPUSH token.
