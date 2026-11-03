/*!
 * Pushy Score — open, versioned ruleset.
 * Plain data + small functions. No network, no eval. Read it, fork it, argue with it.
 * Automated scan, not an audit or guarantee.
 *
 * Changing a rule, severity or weight => bump RULESET.version and add a line to CHANGELOG below.
 *
 * CHANGELOG
 *   1.0.0 (2026-11-03)  first public ruleset: secrets, code/network, prompt hygiene, docs & upkeep.
 */
(function (root) {
  'use strict';

  var RULESET = { id: 'pushy-rules', version: '1.0.0', date: '2026-11-03' };

  /* ---------- scoring knobs ---------- */
  var SCORING = {
    // points removed from a sub-score (0-100) by the FIRST hit of a rule at this severity
    penalty: { critical: 45, high: 22, medium: 9, low: 3, info: 0 },
    // 2nd hit of the same rule counts 50%, 3rd 25%, later 10% (a rule can't cost more than 1.75x its base penalty)
    repeat: [1, 0.5, 0.25, 0.1],
    maxRuleMultiplier: 1.75,
    // overall = weighted mean of the 4 sub-scores
    weights: { secrets: 0.25, code: 0.30, prompt: 0.30, docs: 0.15 },
    // hard caps on the overall score
    caps: {
      anyCritical: 35,
      threeOrMoreHigh: 60,
      anyHigh: 75,
      treeTruncated: 70,
      skippedOver50pct: 70,
      skippedOver20pct: 80,
      skippedSome: 90,
      binariesOrArchives: 85,
      nothingToScan: 60
    },
    bands: [ // lowest score that earns the band
      { min: 85, key: 'green',  label: 'Safe to push 🟢',                 line: 'Our rules found no red flags. That is not the same as "safe", so read the diff anyway.' },
      { min: 70, key: 'yellow', label: 'Push, but read the diff first 🟡', line: 'A few things are worth a look before this goes anywhere near main.' },
      { min: 45, key: 'orange', label: 'Hmm. Review before you push 🟠',   line: 'Real warning signs. Read the findings before you install or run anything.' },
      { min: 0,  key: 'red',    label: 'Do NOT force push this 🔴',        line: 'Serious red flags. Do not install or run this without a careful manual review.' }
    ]
  };

  var CATEGORIES = {
    secrets: { name: 'Secrets',             hint: 'keys, tokens, credential files' },
    code:    { name: 'Code & network',      hint: 'shell, eval, exfil, permissions, supply chain' },
    prompt:  { name: 'Prompt hygiene',      hint: 'injection strings, hidden text, remote instructions' },
    docs:    { name: 'Docs & upkeep',       hint: 'README, license, skill metadata, maintenance' }
  };

  /* ---------- scan limits ---------- */
  var LIMITS = {
    maxFiles: 40,
    maxFileBytes: 200 * 1024,
    maxFindingsPerRulePerFile: 12,
    fetchConcurrency: 6
  };

  /* ---------- file classification tables (used by the engine) ---------- */
  var FILES = {
    codeExt: 'py js mjs cjs jsx ts tsx sh bash zsh ps1 bat cmd rb go rs php lua pl java kt swift html htm'.split(' '),
    instrExt: 'md mdx mdc txt prompt rst'.split(' '),
    configExt: 'json jsonc json5 yml yaml toml ini cfg conf env pem key'.split(' '),
    binaryExt: 'exe dll so dylib bin class jar pyc pyo wasm o a node'.split(' '),
    archiveExt: 'zip tar gz tgz bz2 xz 7z rar whl egg docx xlsx pptx odt pdf epub'.split(' '),
    imageExt: 'png jpg jpeg gif webp ico bmp svg avif'.split(' '),
    skipDirs: /(^|\/)(node_modules|vendor|dist|build|out|\.git|__pycache__|\.venv|venv|site-packages|\.next|\.nuxt|coverage|third_party|\.tox|target)\//i,
    lockFiles: /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|poetry\.lock|uv\.lock|Cargo\.lock|Gemfile\.lock|composer\.lock|go\.sum|bun\.lockb?)$/i,
    licenseName: /^(licen[sc]e|copying|notice|unlicense|patents|authors|contributors|codeowners|.*-OFL|OFL)(\.[a-z]+)?$/i,
    exampleDirs: /(^|\/)(tests?|__tests__|spec|fixtures?|examples?|samples?|docs?|demo|demos|testdata)\//i
  };

  /* ---------- helpers shared by rules ---------- */
  var PLACEHOLDER = /(example|sample|your[_\- ]?|placeholder|changeme|change[_-]me|xxxx|<[^>]+>|\*{3,}|dummy|fake|redacted|todo|replace|\$\{|%\(|\{\{|process\.env|os\.environ|getenv|insert|\.\.\.)/i;
  function entropy(s) {
    var f = {}, i, n = s.length, e = 0;
    for (i = 0; i < n; i++) f[s[i]] = (f[s[i]] || 0) + 1;
    for (var k in f) { var p = f[k] / n; e -= p * Math.log2(p); }
    return e;
  }
  function lineOf(text, needle) {
    var i = text.indexOf(needle);
    if (i < 0) return 1;
    return text.slice(0, i).split('\n').length;
  }
  function stripJsonComments(t) {
    return t.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  }
  function parseJson(t) {
    try { return JSON.parse(t); } catch (e) {}
    try { return JSON.parse(stripJsonComments(t).replace(/,\s*([}\]])/g, '$1')); } catch (e2) {}
    return null;
  }
  function frontmatter(text) {
    var m = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/.exec(text);
    if (!m) return null;
    var out = {}, lines = m[1].split(/\r?\n/), cur = null;
    lines.forEach(function (l) {
      var kv = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(l);
      if (kv) { cur = kv[1]; out[cur] = kv[2].replace(/^["']|["']$/g, ''); }
      else if (cur && /^\s+\S/.test(l)) out[cur] += ' ' + l.trim().replace(/^-\s*/, '');
      else if (cur && /^-\s+/.test(l)) out[cur] += ' ' + l.replace(/^-\s*/, '');
    });
    return out;
  }
  var TEXT = ['instr', 'code', 'config'];

  /* =====================================================================
   * 1. LINE RULES — run on every analysed text file, line by line.
   *    re: tested per line · all/within: two patterns within N lines
   *    kinds: which file kinds · sev: severity before example-path downgrade
   * ===================================================================== */
  var lineRules = [

    /* ---------------- SECRETS ---------------- */
    { id: 'S001', cat: 'secrets', sev: 'critical', kinds: TEXT, redact: true,
      title: 'AWS access key',
      re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
      filter: function (m) { return !/EXAMPLE/.test(m[0]); },
      why: 'A real-looking AWS key is committed in public. Bots scrape these within minutes.',
      fix: 'Revoke the key in AWS IAM now, rotate it, and load it from an environment variable or secret store.' },
    { id: 'S002', cat: 'secrets', sev: 'critical', kinds: TEXT, redact: true,
      title: 'GitHub token',
      re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,})\b/,
      why: 'A GitHub token in a public repo can give strangers push access to your code.',
      fix: 'Revoke it at github.com/settings/tokens, create a fine-scoped replacement, and keep it out of git history.' },
    { id: 'S003', cat: 'secrets', sev: 'critical', kinds: TEXT, redact: true,
      title: 'LLM / API secret key (sk-…)',
      re: /\bsk-(?:proj-|ant-(?:api\d\d-)?|live-)?[A-Za-z0-9_\-]{32,}/,
      filter: function (m, line) { return !PLACEHOLDER.test(line); },
      why: 'OpenAI/Anthropic-style keys cost real money when leaked and can expose your prompts and data.',
      fix: 'Revoke and regenerate the key at the provider, then read it from an environment variable.' },
    { id: 'S004', cat: 'secrets', sev: 'critical', kinds: TEXT, redact: true,
      title: 'Slack / Stripe / provider token',
      re: /\b(?:xox[baprs]-[A-Za-z0-9-]{10,}|sk_live_[A-Za-z0-9]{20,}|rk_live_[A-Za-z0-9]{20,}|SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}|npm_[A-Za-z0-9]{36})\b/,
      why: 'Live provider tokens grant access to chat, payments, email or package publishing.',
      fix: 'Revoke at the provider, rotate, and move the secret to a secret manager.' },
    { id: 'S011', cat: 'secrets', sev: 'critical', kinds: TEXT, redact: true,
      title: 'Registry auth token in config',
      re: /_auth(?:Token)?\s*=\s*(?!\$\{)(?!['"]?\s*$)([A-Za-z0-9_\-.\/+=]{20,})/,
      why: 'A committed .npmrc / .pypirc token lets anyone publish as you.',
      fix: 'Revoke the token, rotate it, and read it from an environment variable (`${NPM_TOKEN}`) instead.' },
    { id: 'S005', cat: 'secrets', sev: 'critical', kinds: TEXT, redact: true,
      title: 'Private key block',
      re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/,
      why: 'A private key is in the repo. Whoever clones it can impersonate you.',
      fix: 'Treat the key as burned: generate a new pair, replace it everywhere, and purge the file from history.' },
    { id: 'S006', cat: 'secrets', sev: 'high', kinds: TEXT, redact: true,
      title: 'Google API key / Telegram bot token / webhook secret',
      re: /\b(?:AIza[0-9A-Za-z_\-]{35}|\d{8,10}:[A-Za-z0-9_-]{35}|hooks\.slack\.com\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/[A-Za-z0-9]+)\b/,
      why: 'These keys let others spend your quota, post as your bot, or write to your channels.',
      fix: 'Rotate the key or webhook and restrict it (referrer / IP / scope) where the provider supports it.' },
    { id: 'S007', cat: 'secrets', sev: 'high', kinds: TEXT, redact: true,
      title: 'Hardcoded secret assignment',
      re: /\b(?:api[_-]?key|apikey|secret(?:[_-]?key)?|access[_-]?token|auth[_-]?token|client[_-]?secret|passwd|password|private[_-]?key)\b["']?\s*[:=]\s*["']([A-Za-z0-9_\-\/+=.]{20,})["']/i,
      filter: function (m, line) {
        var v = m[1];
        if (PLACEHOLDER.test(line) || PLACEHOLDER.test(v)) return false;
        if (!/[A-Za-z]/.test(v) || !/[0-9]/.test(v)) return false;
        return entropy(v) >= 3.4;
      },
      why: 'A high-entropy value is assigned to a secret-looking name. It is probably a real credential.',
      fix: 'Move it to an environment variable or secret manager, rotate it, and commit a .env.example with fake values instead.' },
    { id: 'S008', cat: 'secrets', sev: 'high', kinds: TEXT, redact: true,
      title: 'Wallet seed phrase / keypair path referenced',
      re: /(?:\bid\.json\b[^\n]{0,40}(?:solana|keypair)|\.config\/solana\/id\.json|\b(?:seed phrase|mnemonic|recovery phrase)\b[^\n]{0,30}[:=]\s*["'][a-z]+(?: [a-z]+){10,}["'])/i,
      why: 'Wallet key material (or a path to it) in an agent repo is a drain waiting to happen.',
      fix: 'Never commit keypairs or seed phrases. Use a hardware wallet or a scoped signer, and keep keys outside the repo.' },

    /* ---------------- CODE: dangerous execution ---------------- */
    { id: 'X001', cat: 'code', sev: 'high', kinds: TEXT,
      title: 'Pipes a download straight into a shell',
      re: /(?:\b(?:curl|wget)\b[^\n|]*\|\s*(?:sudo\s+)?(?:ba|z|da|k)?sh\b|\b(?:iwr|irm|Invoke-WebRequest|Invoke-RestMethod)\b[^\n|]*\|\s*(?:iex|Invoke-Expression)\b|\biex\s*\(\s*(?:New-Object|iwr|irm))/i,
      why: 'curl | sh runs whatever the server sends at that moment, with your permissions, with no review.',
      fix: 'Download, pin a checksum or version, read the script, then run it. Prefer a package manager with lockfiles.' },
    { id: 'X002', cat: 'code', sev: 'medium', kinds: ['code'], exts: ['py'],
      title: 'Dynamic code execution (eval / exec / compile)',
      re: /(?:^|[^\w.])(?:eval|exec)\s*\((?!\s*["'][^"']*["']\s*\))|\bcompile\s*\([^)]*['"]exec['"]|\bmarshal\.loads\s*\(|\bpickle\.loads?\s*\(/,
      why: 'Running strings as code lets any untrusted text (a prompt, a web page, a tool result) become a command.',
      fix: 'Replace with explicit parsing or a lookup table. If you truly need it, sandbox it and never feed it model or network output.' },
    { id: 'X003', cat: 'code', sev: 'medium', kinds: ['code'], exts: ['js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx'],
      title: 'Dynamic code execution (eval / new Function)',
      re: /(?:^|[^\w.$])eval\s*\(|\bnew\s+Function\s*\(|\bvm\.(?:runIn\w+|Script)\b|\bsetTimeout\s*\(\s*["'`]/,
      why: 'Running strings as code lets untrusted text become a command.',
      fix: 'Use JSON.parse or an explicit dispatch table. Never pass model or network output to eval.' },
    { id: 'X004', cat: 'code', sev: 'medium', kinds: ['code'],
      title: 'Spawns a shell / subprocess',
      re: /\bsubprocess\.(?:run|call|Popen|check_output|check_call)\b[^\n]*shell\s*=\s*True|\bos\.(?:system|popen)\s*\(|\bchild_process\b|\b(?:execSync|execFileSync|spawnSync)\s*\(|(?:^|[^\w.])exec\s*\(\s*[`"'][^`"']*\$\{|\bRuntime\.getRuntime\(\)\.exec\b|\bsystem\s*\(\s*\$/,
      why: 'Shell access is the most powerful thing a tool can have. If arguments come from a model, an attacker can steer it.',
      fix: 'Avoid the shell, pass argument arrays (no shell=True), validate inputs against an allow-list, and document why the tool needs it.' },
    { id: 'X005', cat: 'code', sev: 'high', kinds: TEXT,
      title: 'Destructive or system-level command',
      re: /\brm\s+-[a-zA-Z]*[rR][a-zA-Z]*f?[a-zA-Z]*\s+(?:\/(?!\w)|~\/?(?:\s|$)|\$HOME\b|\*\s*$|\/\*)|\bchmod\s+(?:-R\s+)?[0-7]?777\b|\bmkfs(?:\.\w+)?\s|\bdd\s+if=[^\n]*\bof=\/dev\/|:\(\)\s*\{\s*:\|:&\s*\};:|\bformat\s+[a-z]:\s*\/|\bRemove-Item\b[^\n]*-Recurse[^\n]*-Force[^\n]*[A-Z]:\\/i,
      why: 'Commands like these wipe disks or open permissions wide. In an agent skill, a bad argument is all it takes.',
      fix: 'Remove it, or scope it to a temp directory you created, and require an explicit human confirmation.' },
    { id: 'X006', cat: 'code', sev: 'high', kinds: TEXT,
      title: 'Obfuscated payload executed (base64 / hex → shell/exec)',
      re: /(?:base64\s+(?:-d|--decode|-D)\b[^\n]*\|\s*(?:ba|z|da)?sh\b|\batob\s*\([^)]*\)[^\n]{0,60}\beval\b|\beval\s*\([^\n]{0,60}\batob\s*\(|\bexec\s*\([^\n]{0,60}b64decode|\bb64decode\s*\([^\n]{0,80}\)[^\n]{0,40}\bexec\b|\bFromBase64String\b[^\n]*\b(?:iex|Invoke-Expression)\b|\bBuffer\.from\([^)]*['"]base64['"]\)[^\n]{0,80}\beval\b)/i,
      why: 'Hiding a command in base64 and running it is a classic malware move. Honest code has no reason to.',
      fix: 'Replace the encoded blob with readable code. If it is legitimate, say what it does in a comment.' },
    { id: 'X007', cat: 'code', sev: 'high', kinds: TEXT,
      title: 'Persistence (shell rc, cron, launch agents, services)',
      re: /(?:>>?\s*~?\/?(?:\$HOME\/)?\.?(?:bashrc|zshrc|bash_profile|zprofile|profile)\b|\bcrontab\s+(?:-|\S)|\bLaunchAgents\b|\bLaunchDaemons\b|\bsystemctl\s+(?:--user\s+)?enable\b|\bschtasks\s+\/create\b|CurrentVersion\\Run\b|\bauthorized_keys\b)/i,
      why: 'Writing to shell startup files, cron or services makes code survive reboots, which is what malware does.',
      fix: 'Do not modify startup files or schedule jobs from a skill. If a daemon is required, make it opt-in and documented.' },
    { id: 'X008', cat: 'code', sev: 'high', kinds: TEXT,
      title: 'Reads credential stores / sensitive paths',
      re: /(?:~\/\.ssh\b|\$HOME\/\.ssh\b|\.aws\/credentials|\.config\/gcloud|\.kube\/config|\.docker\/config\.json|\.npmrc\b|\.pypirc\b|\.netrc\b|\bid_(?:rsa|ed25519|ecdsa)\b|\/etc\/(?:passwd|shadow)\b|Library\/Keychains|Login Data\b|Local State\b[^\n]*Chrome|\.mozilla\/firefox|wallet\.dat\b|\.gnupg\b|\bkeychain\b\s+(?:find|dump)|security\s+find-generic-password)/i,
      filter: function (m, line, ctx) {
        // gitignore-style lists and docs that merely mention the path are fine
        if (ctx.path && /(\.gitignore|\.dockerignore|\.npmignore)$/i.test(ctx.path)) return false;
        return true;
      },
      why: 'Touching SSH keys, cloud credentials or browser profiles is the first step of credential theft.',
      fix: 'A skill almost never needs these. Remove the access, or scope it to a single named file and ask the user first.' },
    { id: 'X009', cat: 'code', sev: 'critical', kinds: TEXT,
      title: 'Reverse shell pattern',
      re: /(?:\/dev\/(?:tcp|udp)\/[\w.$-]+\/\d+|\bbash\s+-i\s*>&|\bnc(?:at)?\s+(?:-[a-z]*e\b|[^\n]*\s-e\s)|\bsocat\b[^\n]*\bexec:|\bmkfifo\b[^\n]*\bnc\b|python[23]?\s+-c\s+['"][^'"]*socket[^'"]*connect)/i,
      why: 'This hands a remote machine an interactive shell on yours.',
      fix: 'Remove it. There is no legitimate reason for this in a skill, MCP server or prompt library.' },
    { id: 'X010', cat: 'code', sev: 'low', kinds: ['code', 'instr'],
      title: 'git push --force in scripts',
      re: /\bgit\s+push\b[^\n]*\s(?:-f\b|--force(?!-with-lease))/,
      why: 'Force-pushing from automation can erase teammates\' commits. (Yes, we are aware of the irony.)',
      fix: 'Use --force-with-lease, or avoid rewriting shared history from scripts.' },
    { id: 'X011', cat: 'code', sev: 'medium', kinds: TEXT,
      title: 'Obfuscated string construction',
      re: /String\.fromCharCode\s*\(\s*(?:\d+\s*,\s*){19,}|(?:\\x[0-9a-fA-F]{2}){24,}|(?:chr\(\d+\)\s*\+\s*){12,}/,
      why: 'Building strings from character codes or escapes is a way to dodge text scanners and human readers.',
      fix: 'Write the string plainly. If it is binary data, load it from a file and document it.' },

    /* ---------------- CODE: network / exfil ---------------- */
    { id: 'N001', cat: 'code', sev: 'high', kinds: TEXT,
      title: 'Known exfiltration / paste / tunnel endpoint',
      re: /\b(?:discord(?:app)?\.com\/api\/webhooks|api\.telegram\.org\/bot|pastebin\.com\/(?:api|raw)|transfer\.sh|webhook\.site|requestbin\.\w+|[a-z0-9-]+\.pipedream\.net|[a-z0-9-]+\.ngrok(?:-free)?\.(?:io|app|dev)|[a-z0-9-]+\.trycloudflare\.com|interact\.sh|oast\.(?:fun|live|me|online|pro|site)|burpcollaborator\.net|ghostbin\.\w+|file\.io|0x0\.st|ix\.io|hastebin\.com|anonfiles\.\w+)\b/i,
      why: 'These services are where stolen data tends to go: anonymous, instant, throw-away.',
      fix: 'Remove the endpoint, or document exactly what is sent and why, and let the user turn it off.' },
    { id: 'N002', cat: 'code', sev: 'high', kinds: TEXT,
      all: [/\b(?:fetch|axios|requests?\.(?:post|put|get)|http\.client|urllib|curl|wget|XMLHttpRequest|got\(|httpx|aiohttp|WebClient|Invoke-(?:WebRequest|RestMethod)|iwr|irm)\b/i,
            /(?:process\.env\b(?!\.(?:NODE_ENV|PORT|HOST|DEBUG|LOG_LEVEL)\b)|os\.environ(?!\.get\(\s*["'](?:PORT|HOST|DEBUG|LOG_LEVEL|HOME|PATH)["'])|\bgetenv\s*\(|\$\{?[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)[A-Z0-9_]*\}?|\.ssh\b|\.aws\b|\bid_rsa\b|\bDump-Env\b)/],
      within: 3,
      title: 'Network call near environment variables or secrets',
      why: 'A request that sits next to env vars or key files may be shipping secrets out. Legit API clients do this too, so check.',
      fix: 'Send only what the API needs, never the whole environment, and name the destination in the docs.' },
    { id: 'N003', cat: 'code', sev: 'medium', kinds: TEXT, exts: null,
      title: 'Raw IP address in a URL',
      re: /\bhttps?:\/\/(?!127\.|0\.0\.0\.0|10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|169\.254\.|255\.|1\.1\.1\.1|8\.8\.[48]\.[48])(?:\d{1,3}\.){3}\d{1,3}\b/,
      why: 'Real services have names. A bare IP is common for throw-away command-and-control servers.',
      fix: 'Use a named, documented host over HTTPS, or explain why a raw IP is needed.' },
    { id: 'N004', cat: 'code', sev: 'low', kinds: ['code', 'config'],
      title: 'Plain http:// endpoint',
      re: /\bhttp:\/\/(?!localhost\b|127\.|0\.0\.0\.0|\[::1\]|192\.168\.|10\.|www\.w3\.org|schemas\.|json-schema\.org|xmlns|example\.(?:com|org)|host\.docker\.internal|[\w-]+:\d)[a-z0-9.-]+\.[a-z]{2,}/i,
      why: 'Unencrypted traffic can be read or changed in transit.',
      fix: 'Switch to https:// or document why plain HTTP is required.' },

    /* ---------------- PROMPT HYGIENE ---------------- */
    { id: 'P001', cat: 'prompt', sev: 'high', kinds: TEXT,
      title: 'Instruction-override phrase',
      re: /\b(?:ignore|disregard|forget|override)\s+(?:all\s+|any\s+|the\s+|your\s+|of\s+)*(?:previous|prior|above|earlier|preceding|system|safety|original)\s+(?:instructions?|prompts?|rules|guidelines|directions|messages?|constraints)\b|\byou\s+are\s+now\s+(?:in\s+)?(?:DAN|developer\s+mode|jailbroken|unrestricted)\b|\bnew\s+(?:system\s+)?instructions?\s*:\s*(?:ignore|you\s+must)/i,
      why: 'Text that tells the model to drop its earlier rules is the textbook prompt-injection payload.',
      fix: 'Delete it. If this is a security example, move it into a clearly-marked test fixture.' },
    { id: 'P002', cat: 'prompt', sev: 'high', kinds: TEXT,
      title: 'Tells the model to hide things from the user',
      re: /\b(?:do\s+not|don'?t|never)\s+(?:tell|inform|mention|reveal|show|notify|alert|warn)\s+(?:this\s+to\s+)?(?:the\s+)?user\b|\bwithout\s+(?:telling|informing|notifying|alerting)\s+the\s+user\b|\bwithout\s+(?:the\s+)?user'?s?\s+(?:knowledge|consent|approval|confirmation|awareness)\b|\bhide\s+this\s+(?:from|action)\b|\bsilently\s+(?:send|upload|post|run|execute|forward|exfiltrate|delete)\b|\bkeep\s+this\s+(?:a\s+)?secret\s+from\b/i,
      why: 'Legit tools tell the user what they do. Hidden actions are how "tool poisoning" attacks work.',
      fix: 'Remove the concealment. Surface every side effect to the user and ask before sensitive actions.' },
    { id: 'P003', cat: 'prompt', sev: 'high', kinds: TEXT,
      title: 'Hidden-instruction block (<IMPORTANT>, <system>, [SYSTEM])',
      re: /<\s*(?:important|system|instructions?|admin|override|secret|hidden)\s*>|\[\s*(?:SYSTEM|ADMIN|OVERRIDE)\s*\]\s*:|^#{1,4}\s*SYSTEM\s*(?:PROMPT|OVERRIDE|MESSAGE)\b/i,
      why: 'Special tags inside tool or skill text are used to smuggle extra instructions past the user.',
      fix: 'Keep tool descriptions to what the tool does. Put policy in your own system prompt, not in third-party text.' },
    { id: 'P004', cat: 'prompt', sev: 'medium', kinds: ['instr', 'config'],
      re: /<!--(?=[^\n]{0,300}?(?:ignore\s+(?:all|any|previous|prior|the)|disregard|instructions?\b|assistant\b|\bAI\b|\bLLM\b|you\s+must\b|system\s+prompt|override|execute\b|exfiltrate|do\s+not\s+(?:tell|mention|reveal)))/i,
      title: 'HTML comment containing instructions',
      why: 'Humans don\'t see HTML comments when reading rendered markdown, but the model does.',
      fix: 'Move meaningful text into visible content, or delete the comment.' },
    { id: 'P005', cat: 'prompt', sev: 'high', kinds: ['instr', 'config', 'code'],
      title: 'Tells the model to read or send secrets / sensitive files',
      re: /\b(?:read|cat|print|dump)\b[^\n]{0,60}(?:~\/\.ssh|\bid_rsa\b|\.aws\/credentials|~\/\.aws\b|private\s+key|seed\s+phrase|\.npmrc\b|keychain|wallet\.dat)|\b(?:send|upload|post|forward|exfiltrate|transmit)\b[^\n]{0,70}(?:~\/\.ssh|\bid_rsa\b|\.env\b|\.aws\b|private\s+key|seed\s+phrase|system\s+prompt|conversation\s+history|chat\s+history|environment\s+variables)/i,
      filter: function (m, line) { return !/\b(?:never|do not|don't|must not|avoid|should not|shouldn't|not to)\b[^\n]{0,50}\b(?:read|send|upload|post|commit|include|expose|share|print|show|dump)\b/i.test(line); },
      why: 'Instructions that move keys, env vars or chat history somewhere are a data-theft recipe.',
      fix: 'Remove the instruction. If a file must be read, name it explicitly, keep it local, and tell the user.' },
    { id: 'P006', cat: 'prompt', sev: 'high', kinds: ['instr', 'config'],
      re: /\b(?:fetch|download|curl|wget|read|load|retrieve|visit|open|get|pull)\b[^\n]{0,100}https?:\/\/[^\s)>\]"']+[^\n]{0,120}\b(?:and|then|,)\s+(?:follow|obey|execute|run|apply|use\s+as\s+(?:your\s+)?instructions|treat\s+(?:it|them|that)\s+as)\b|\b(?:follow|obey|execute|run|apply)\s+(?:the\s+)?(?:instructions?|commands?|steps|script|prompt|rules)\s+(?:found\s+|given\s+|listed\s+|hosted\s+)?(?:at|from|in|on)\s+(?:https?:\/\/|the\s+(?:url|link|page|website))|\bbefore\s+(?:doing\s+)?anything(?:\s+else)?\s*,?\s*(?:fetch|download|run|visit|curl|wget)\b/i,
      title: 'Fetches remote text and follows it as instructions',
      why: 'If the instructions live on a server, the author can change them after you trust the skill. A clean scan today means nothing tomorrow.',
      fix: 'Vendor the instructions into the repo (pinned to a commit), or fetch only data, never directives.' },
    { id: 'P007', cat: 'prompt', sev: 'high', kinds: ['instr', 'config'],
      title: 'Tells the model to send data to an external party',
      re: /\b(?:send|post|upload|forward|transmit|report)\b[^\n]{0,60}\b(?:conversation|chat|transcript|prompts?|files?|secrets?|tokens?|credentials|keys?|data|output)\b[^\n]{0,40}\b(?:to|at|via)\s+(?:https?:\/\/|[\w.-]+@[\w.-]+\.[a-z]{2,}|(?:my|our|this|the)\s+(?:server|endpoint|webhook|url|api))/i,
      filter: function (m, line) { return !/\b(?:never|do not|don't|must not|avoid)\b/i.test(line); },
      why: 'This tells an agent to ship user data to an outside address.',
      fix: 'Remove it, or make it explicit, opt-in and documented, with the destination named.' },
    { id: 'P008', cat: 'prompt', sev: 'medium', kinds: ['instr', 'config', 'code'],
      title: 'Tool shadowing / "always call this first" language',
      re: /\b(?:before|instead\s+of)\s+(?:using|calling|running|invoking)\s+(?:any|every|all|the\s+\w+|other)\s+(?:other\s+)?(?:tools?|functions?|commands?)\b|\balways\s+(?:call|use|invoke|run)\s+this\s+(?:tool|function)\s+(?:first|before|for\s+every)\b|\bthis\s+tool\s+(?:must|should)\s+be\s+(?:called|used|invoked)\s+(?:first|before|for\s+every|on\s+every)/i,
      why: 'A tool that tells the model to prefer it over others can hijack traffic meant for other tools.',
      fix: 'Describe what the tool does, not when it outranks other tools.' },
    { id: 'P009', cat: 'prompt', sev: 'medium', kinds: ['instr', 'config'],
      re: /\b(?:system|admin(?:istrator)?|developer|anthropic|openai|platform)\s+(?:override|message|instruction|command|directive|notice)\s*[:\-—]/i,
      title: 'Claims authority ("system override:", "admin instruction:")',
      why: 'Pretending to be the platform or the developer is social engineering aimed at the model.',
      fix: 'Remove authority claims. Third-party text has no special authority.' },
    { id: 'P010', cat: 'prompt', sev: 'medium', kinds: ['instr', 'config', 'code'],
      re: /(?:--dangerously-skip-permissions|--yolo\b|\bbypassPermissions\b|\bdangerously[A-Z][A-Za-z]*\b|\bauto[- ]?approve\b|\bdo\s+not\s+ask\s+(?:for\s+)?(?:permission|confirmation|approval)\b|\bskip\s+(?:all\s+)?(?:confirmation|approval|permission)s?\b)/i,
      filter: function (m, line) { return !/\b(?:never|don't|do not|must not|avoid|disable)\b[^\n]{0,30}(?:skip|bypass|dangerously)/i.test(line); },
      title: 'Asks to skip permission prompts',
      why: 'Skipping the human-in-the-loop turns every other bug into a full compromise.',
      fix: 'Keep confirmations on for anything that writes, deletes, spends or sends.' }
  ];

  /* =====================================================================
   * 2. SPECIAL LINE RULES — need custom scanning (whole text, decode, etc.)
   *    run(file) -> [{line, snippet, sev?, extra?}]   (file = {path,text,kind})
   * ===================================================================== */
  var BIDI = /[\u202A-\u202E\u2066-\u2069]/;
  var ZW = /[\u200B\u200C\u2060-\u2064\u180E\u200E\u200F\u00AD\uFEFF]/;
  var TAGS = /[\u{E0000}-\u{E007F}]/u;
  function cps(str) {
    var map = {}, out = [];
    for (var ch of str) { var c = ch.codePointAt(0); map[c] = (map[c] || 0) + 1; }
    for (var k in map) out.push('U+' + Number(k).toString(16).toUpperCase().padStart(4, '0') + (map[k] > 1 ? '×' + map[k] : ''));
    return out.join(' ');
  }
  function decodeTags(str) {
    var s = '';
    for (var ch of str) { var c = ch.codePointAt(0); if (c >= 0xE0020 && c <= 0xE007E) s += String.fromCharCode(c - 0xE0000); }
    return s;
  }
  function b64text(s) {
    try {
      var bin = (typeof atob === 'function') ? atob(s) : Buffer.from(s, 'base64').toString('binary');
      var printable = 0, i;
      for (i = 0; i < bin.length; i++) { var c = bin.charCodeAt(i); if (c === 9 || c === 10 || c === 13 || (c >= 32 && c < 127)) printable++; }
      if (bin.length && printable / bin.length > 0.9) return bin;
    } catch (e) {}
    return null;
  }

  var specialRules = [
    { id: 'P011', cat: 'prompt', sev: 'high', kinds: TEXT,
      title: 'Hidden Unicode (zero-width, bidi, tag characters)',
      why: 'Invisible characters can hide instructions from humans while the model still reads them, or make code read differently than it runs.',
      fix: 'Strip the invisible characters (e.g. `grep -nP "[\\x{200B}-\\x{200F}\\x{202A}-\\x{202E}\\x{2066}-\\x{2069}]"`) and re-read the file.',
      run: function (f) {
        var out = [], lines = f.text.split(/\r\n|\n|\r/), total = 0;
        lines.forEach(function (l, i) {
          var s = (i === 0) ? l.replace(/^\uFEFF/, '') : l;
          var tag = TAGS.test(s), bidi = BIDI.test(s), zw = ZW.test(s);
          if (!tag && !bidi && !zw) return;
          var found = (s.match(/[\u202A-\u202E\u2066-\u2069\u200B\u200C\u2060-\u2064\u180E\u200E\u200F\u00AD\uFEFF]|[\u{E0000}-\u{E007F}]/gu) || []).join('');
          total += found.length;
          var sev = tag ? 'critical' : bidi ? 'high' : 'medium';
          var note = tag ? 'Unicode tag characters (invisible ASCII smuggling)' : bidi ? 'bidirectional override characters' : 'zero-width / invisible characters';
          var hidden = tag ? decodeTags(found) : '';
          out.push({ line: i + 1, sev: sev, snippet: note + ': ' + cps(found) + (hidden ? '  → hidden text: "' + hidden.slice(0, 120) + '"' : ''), noEscapeCtx: true });
        });
        return out;
      } },
    { id: 'P012', cat: 'prompt', sev: 'medium', kinds: TEXT,
      title: 'Long base64 / encoded blob',
      why: 'Big opaque blobs in text files can hide instructions or payloads where reviewers skim past them.',
      fix: 'Replace with readable text, or move genuine binary data to a documented file with a checksum.',
      run: function (f) {
        var out = [], lines = f.text.split(/\r\n|\n|\r/);
        lines.forEach(function (l, i) {
          if (l.length < 100) return;
          if (/data:[a-z]+\/[a-z0-9.+-]+;base64|sha(?:256|384|512)-|integrity|-----BEGIN|\.(?:png|jpg|gif|svg)\b/i.test(l)) return;
          var re = /[A-Za-z0-9+\/]{100,}={0,2}/g, m;
          while ((m = re.exec(l))) {
            var b = m[0];
            if (!/[a-z]/.test(b) || !/[A-Z]/.test(b) || !/[0-9]/.test(b)) continue;
            if (/^[A-Za-z0-9+\/]*[\/][A-Za-z]+\/[A-Za-z]+/.test(b) && /\.[a-z]{2,4}/.test(l.slice(Math.max(0, m.index - 20), m.index))) continue;
            var dec = b64text(b.replace(/=+$/, ''));
            if (dec && /(curl|wget|https?:|\/bin\/|bash|\bsh\s+-c|eval|exec|ignore|instruction|token|password|secret|import\s+os|subprocess|powershell|socket)/i.test(dec)) {
              out.push({ line: i + 1, sev: 'high', snippet: 'base64 blob decodes to: "' + dec.replace(/\s+/g, ' ').slice(0, 140) + '"' });
            } else if (f.kind === 'instr') {
              out.push({ line: i + 1, sev: 'medium', snippet: 'base64-looking blob (' + b.length + ' chars): ' + b.slice(0, 40) + '…' });
            } else if (!dec) {
              out.push({ line: i + 1, sev: 'low', snippet: 'opaque encoded blob (' + b.length + ' chars): ' + b.slice(0, 40) + '…' });
            }
            break;
          }
        });
        return out;
      } },
    { id: 'P013', cat: 'prompt', sev: 'medium', kinds: TEXT,
      title: 'Padding / hidden-by-whitespace',
      why: 'Huge runs of blank lines or spaces push content past the part reviewers (and scanners) look at. This exact trick has beaten commercial skill scanners.',
      fix: 'Remove the padding and read what comes after it.',
      run: function (f) {
        var out = [], t = f.text, m;
        var re = /(?:\r?\n){200,}/g;
        while ((m = re.exec(t))) { out.push({ line: t.slice(0, m.index).split('\n').length, sev: 'medium', snippet: 'run of ' + (m[0].match(/\n/g) || []).length + ' blank lines' }); break; }
        var re2 = /[ \t]{1000,}/g;
        if ((m = re2.exec(t))) out.push({ line: t.slice(0, m.index).split('\n').length, sev: 'medium', snippet: 'run of ' + m[0].length + ' spaces/tabs' });
        var lines = t.split(/\r\n|\n|\r/);
        for (var i = 0; i < lines.length; i++) {
          if (lines[i].length > 10000) { out.push({ line: i + 1, sev: f.kind === 'instr' ? 'medium' : 'low', snippet: 'a single line is ' + lines[i].length.toLocaleString('en-US') + ' characters long (minified or hiding something)' }); break; }
        }
        return out;
      } }
  ];

  /* =====================================================================
   * 3. PATH RULES — decided from the file tree alone
   *    test(entry) where entry = {path, name, ext, kind, size}
   * ===================================================================== */
  var pathRules = [
    { id: 'S009', cat: 'secrets', sev: 'high', title: 'Environment file committed',
      test: function (e) { return /^\.env(\.[\w.-]+)?$/i.test(e.name) && !/\.(example|sample|template|dist|defaults?)$/i.test(e.name); },
      why: '.env files usually hold real credentials.', fix: 'Remove it from git history, rotate what was inside, add `.env` to .gitignore and commit `.env.example` instead.' },
    { id: 'S010', cat: 'secrets', sev: 'high', title: 'Credential / key file committed',
      test: function (e) { return /^(id_(rsa|dsa|ecdsa|ed25519)|\.netrc|credentials\.json|service[-_]?account[^/]*\.json|client_secret[^/]*\.json|wallet\.json|keypair\.json|id\.json)$/i.test(e.name) || /\.(p12|pfx|keystore|jks|kdbx|ppk)$/i.test(e.name); },
      why: 'Key and credential files give direct access to accounts or servers.', fix: 'Delete it from history, rotate the credential, and add it to .gitignore.' },
    { id: 'H001', cat: 'code', sev: 'medium', title: 'Compiled / executable file committed',
      test: function (e) { return e.kind === 'binary'; },
      why: 'Binaries and bytecode cannot be read in review and are skipped by most scanners, which makes them a good place to hide things.', fix: 'Ship source, build in CI, and publish checksums for any binary you must include.' },
    { id: 'H002', cat: 'code', sev: 'low', title: 'Archive or office document committed (not unpacked)',
      test: function (e) { return e.kind === 'archive'; },
      why: 'Zip files, .docx, .pdf and similar are containers. Scanners (including this one) do not open them, so content inside is unchecked.', fix: 'Commit the plain files instead, or document what each archive contains.' }
  ];

  /* =====================================================================
   * 4. FILE RULES — structural checks on one file (JSON/YAML/frontmatter)
   *    match(path) -> bool; run(file, ctx) -> [{line, snippet, id?, sev?, ...}]
   * ===================================================================== */
  var INSTALL_HOOKS = ['preinstall', 'install', 'postinstall', 'prepare', 'prepublish', 'prepack'];
  var fileRules = [
    { id: 'D005', cat: 'docs', sev: 'medium', title: 'SKILL.md metadata missing or malformed',
      why: 'Agents decide when to load a skill from its name and description. Missing metadata means unpredictable behaviour.',
      fix: 'Start SKILL.md with YAML frontmatter containing `name` (lowercase-hyphen, ≤64 chars) and `description` (≤1024 chars).',
      match: function (p) { return /(^|\/)SKILL\.md$/i.test(p); },
      run: function (f) {
        var fm = frontmatter(f.text), out = [];
        if (!fm) return [{ line: 1, snippet: 'no YAML frontmatter at the top of the file' }];
        if (!fm.name) out.push({ line: 1, snippet: 'frontmatter has no `name`' });
        else if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(fm.name)) out.push({ line: 1, sev: 'low', snippet: '`name` should be lowercase letters, digits and hyphens (≤64): "' + fm.name.slice(0, 60) + '"' });
        if (!fm.description) out.push({ line: 1, snippet: 'frontmatter has no `description`' });
        else if (fm.description.length > 1024) out.push({ line: 1, sev: 'low', snippet: '`description` is ' + fm.description.length + ' chars (limit 1024)' });
        return out;
      } },
    { id: 'A001', cat: 'code', sev: 'medium', title: 'Skill grants unrestricted tools',
      why: 'allowed-tools decides what the skill may do without asking. Wildcards and bare Bash mean "anything".',
      fix: 'List the narrowest tools and command patterns, e.g. `Bash(git status:*)` instead of `Bash`.',
      match: function (p) { return /(^|\/)SKILL\.md$/i.test(p); },
      run: function (f) {
        var fm = frontmatter(f.text);
        if (!fm || !fm['allowed-tools']) return [];
        var v = fm['allowed-tools'];
        if (/(^|[\s,\[])\*($|[\s,\]])|Bash\(\s*\*?:?\*?\s*\)|(^|[\s,\[])Bash($|[\s,\]])/.test(v))
          return [{ line: 1, snippet: 'allowed-tools: ' + v.slice(0, 140) }];
        return [];
      } },
    { id: 'A002', cat: 'code', sev: 'high', title: 'Agent settings that skip protections or auto-run commands',
      why: 'Repo-level agent settings run for anyone who opens the project. Bypass modes and hooks turn "open folder" into "run code".',
      fix: 'Remove bypassPermissions / blanket allow rules, and review every hook command.',
      match: function (p) { return /(^|\/)\.claude\/settings(\.local)?\.json$/i.test(p) || /(^|\/)\.vscode\/(tasks|settings)\.json$/i.test(p) || /(^|\/)\.cursor\/(mcp|hooks)\.json$/i.test(p); },
      run: function (f) {
        var j = parseJson(f.text), out = [];
        if (/"runOn"\s*:\s*"folderOpen"/.test(f.text)) out.push({ line: lineOf(f.text, 'folderOpen'), snippet: 'VS Code task runs automatically when the folder is opened' });
        if (!j) return out;
        var pm = j.permissions || {};
        if (pm.defaultMode === 'bypassPermissions') out.push({ line: lineOf(f.text, 'bypassPermissions'), snippet: 'defaultMode: bypassPermissions' });
        (pm.allow || []).forEach(function (a) { if (/^(?:\*|Bash|Bash\(\*\)|Bash\(:\*\)|Write|Edit)$/.test(String(a).trim())) out.push({ line: lineOf(f.text, String(a)), sev: 'medium', snippet: 'allow rule: ' + a }); });
        if (j.enableAllProjectMcpServers === true) out.push({ line: lineOf(f.text, 'enableAllProjectMcpServers'), sev: 'medium', snippet: 'enableAllProjectMcpServers: true (auto-trusts every MCP server in the repo)' });
        if (j.hooks && typeof j.hooks === 'object') {
          var s = JSON.stringify(j.hooks);
          var cmds = (s.match(/"command"\s*:\s*"[^"]{0,120}/g) || []).slice(0, 3).join(' | ');
          out.push({ line: lineOf(f.text, '"hooks"'), sev: 'medium', snippet: 'hooks run shell commands automatically: ' + cmds.replace(/"command"\s*:\s*"/g, '') });
        }
        return out;
      } },
    { id: 'A003', cat: 'code', sev: 'medium', title: 'Risky MCP server launch configuration',
      why: 'How an MCP server is started decides what it can touch: shells, unpinned packages, privileged containers and plain-http endpoints all widen the blast radius.',
      fix: 'Pin versions (`pkg@1.2.3`, `pkg==1.2.3`), avoid `sh -c`, drop --privileged / host mounts, and use https.',
      match: function (p, text) { return /(^|\/)(\.?mcp[^/]*|server|manifest|claude_desktop_config|smithery)\.(json|jsonc)$/i.test(p) || /(^|\/)\.claude-plugin\/[^/]+\.json$/i.test(p) || (/\.json$/i.test(p) && /"mcpServers"|"mcp_servers"/.test(text || '')); },
      run: function (f) {
        var j = parseJson(f.text), out = [];
        if (!j) return out;
        var servers = j.mcpServers || j.mcp_servers || (j.mcp && j.mcp.servers) || null;
        if (!servers && j.command) servers = { server: j };
        if (!servers || typeof servers !== 'object') return out;
        Object.keys(servers).forEach(function (name) {
          var s = servers[name] || {}, cmd = String(s.command || ''), args = (s.args || []).map(String), ln = lineOf(f.text, '"' + name + '"'), a = args.join(' ');
          var base = cmd.replace(/^.*[\\/]/, '').toLowerCase();
          if (/^(sh|bash|zsh|cmd|cmd\.exe|powershell|pwsh)$/.test(base) && /(^|\s)(-c|-Command|\/c)(\s|$)/i.test(a)) out.push({ line: ln, sev: 'high', snippet: name + ': launched through a shell: ' + base + ' ' + a.slice(0, 100) });
          if (base === 'npx' || base === 'bunx') {
            var pkg = args.filter(function (x) { return !/^-/.test(x); })[0] || '';
            if (pkg && !/^(@[^/]+\/)?[^@]+@[^@]+$/.test(pkg)) out.push({ line: ln, sev: 'low', snippet: name + ': unpinned package `' + pkg + '` (latest wins at every launch)' });
          }
          if (/^(uvx|pipx)$/.test(base)) {
            var p2 = args.filter(function (x) { return !/^-/.test(x) && x !== 'run'; })[0] || '';
            if (p2 && !/(==|@)/.test(p2)) out.push({ line: ln, sev: 'low', snippet: name + ': unpinned package `' + p2 + '`' });
          }
          if (base === 'docker' && /--privileged|(^|\s)-v\s+\/:|--pid=host|--network[= ]host|\/var\/run\/docker\.sock/.test(a)) out.push({ line: ln, sev: 'high', snippet: name + ': container with host-level access: ' + a.slice(0, 110) });
          if (typeof s.url === 'string' && /^http:\/\//i.test(s.url) && !/^http:\/\/(localhost|127\.|\[::1\])/i.test(s.url)) out.push({ line: ln, sev: 'medium', snippet: name + ': remote server over plain http: ' + s.url.slice(0, 80) });
        });
        return out;
      } },
    { id: 'A004', cat: 'code', sev: 'medium', title: 'package.json: install-time scripts or risky dependency sources',
      why: 'Install scripts run on `npm install` before anyone has read the code. Git/URL dependencies and wildcards bypass version review.',
      fix: 'Drop install hooks (use an explicit setup command), pin dependencies to versions, and avoid URL dependencies.',
      match: function (p) { return /(^|\/)package\.json$/i.test(p); },
      run: function (f) {
        var j = parseJson(f.text), out = [];
        if (!j) return [{ line: 1, sev: 'low', snippet: 'package.json is not valid JSON' }];
        var sc = j.scripts || {};
        INSTALL_HOOKS.forEach(function (k) {
          if (typeof sc[k] !== 'string') return;
          var bad = /(curl|wget|node\s+-e|powershell|base64|eval|\bsh\s+-c|http[s]?:\/\/)/i.test(sc[k]);
          var benign = /^(?:prepare|prepublish|prepack)$/.test(k) && /^(?:npm run (?:build|compile)\b[\w :-]*|tsc\b[\w .-]*|husky(?: install)?|pnpm (?:run )?build|yarn build|npm run build:?\w*)$/i.test(sc[k].trim());
          if (benign) return;
          out.push({ line: lineOf(f.text, '"' + k + '"'), sev: bad ? 'high' : (/^(?:prepare|prepublish|prepack)$/.test(k) ? 'low' : 'medium'), snippet: k + ': ' + sc[k].slice(0, 120) });
        });
        ['dependencies', 'devDependencies', 'optionalDependencies'].forEach(function (g) {
          var d = j[g] || {};
          Object.keys(d).forEach(function (k) {
            var v = String(d[k]);
            if (/^(git\+|git:|github:|https?:|file:|ssh:)/i.test(v) || /^[\w.-]+\/[\w.-]+(#.*)?$/.test(v)) out.push({ line: lineOf(f.text, '"' + k + '"'), sev: 'medium', snippet: g + ': ' + k + ' → ' + v.slice(0, 80) + ' (not a registry version)' });
            else if (v === '*' || v === 'latest' || v === '') out.push({ line: lineOf(f.text, '"' + k + '"'), sev: 'low', snippet: g + ': ' + k + ' → "' + v + '" (unpinned)' });
          });
        });
        return out;
      } },
    { id: 'A005', cat: 'code', sev: 'medium', title: 'requirements: extra package index or unpinned VCS install',
      why: 'An extra index URL enables dependency-confusion attacks; unpinned git installs change under you.',
      fix: 'Use the default index (or pin hashes) and pin VCS installs to a commit.',
      match: function (p) { return /(^|\/)requirements[^/]*\.txt$/i.test(p); },
      run: function (f) {
        var out = [];
        f.text.split(/\r?\n/).forEach(function (l, i) {
          if (/^\s*--(?:extra-)?index-url\b/i.test(l) || /^\s*--trusted-host\b/i.test(l)) out.push({ line: i + 1, snippet: l.trim().slice(0, 120) });
          else if (/^\s*(?:-e\s+)?git\+/.test(l) && !/@[\w.-]{7,}/.test(l)) out.push({ line: i + 1, sev: 'low', snippet: l.trim().slice(0, 120) + ' (no commit pin)' });
        });
        return out;
      } },
    { id: 'A006', cat: 'code', sev: 'high', title: 'GitHub Actions workflow: injection or dangerous trigger',
      why: 'Workflows that run untrusted PR text or check out PR code with write tokens let outsiders run code in your repo\'s CI.',
      fix: 'Pass event data through env vars, avoid pull_request_target + checkout of the PR head, and set `permissions: contents: read`.',
      match: function (p) { return /(^|\/)\.github\/workflows\/[^/]+\.ya?ml$/i.test(p); },
      run: function (f) {
        var out = [], t = f.text, lines = t.split(/\r?\n/);
        lines.forEach(function (l, i) {
          if (/\$\{\{\s*github\.event\.(?:issue|pull_request|comment|review|head_commit|discussion)[^}]*\.(?:title|body|message|label|name|head\.ref)[^}]*\}\}/.test(l) && /\brun:|\|\s*$/.test(lines.slice(Math.max(0, i - 6), i + 1).join('\n')))
            out.push({ line: i + 1, snippet: l.trim().slice(0, 140) + '  (script injection)' });
          if (/permissions\s*:\s*write-all/.test(l)) out.push({ line: i + 1, sev: 'medium', snippet: 'permissions: write-all' });
        });
        if (/pull_request_target/.test(t) && /actions\/checkout[\s\S]{0,200}?ref:\s*\$\{\{\s*github\.event\.pull_request\.head\.(?:sha|ref)/.test(t))
          out.push({ line: lineOf(t, 'pull_request_target'), snippet: 'pull_request_target + checkout of the PR head (runs fork code with repo secrets)' });
        return out;
      } }
  ];

  /* =====================================================================
   * 5. REPO RULES — metadata, tree and whole-scan checks
   *    run(ctx) -> findings ; ctx = {repo, commits, tree, files, readme, entries, now, hosts, ...}
   * ===================================================================== */
  var DAY = 86400000;
  function daysSince(iso, now) { return (now - Date.parse(iso)) / DAY; }
  var repoRules = [
    { id: 'D001', cat: 'docs', sev: 'medium', title: 'No README', why: 'Without a README nobody can tell what this does or what permissions it needs.', fix: 'Add a README with what it does, how to install it, and what it touches.',
      run: function (c) { return c.scopeRoot && !c.entries.some(function (e) { return /^readme(\.[a-z]+)?$/i.test(e.name) && e.depth === 0; }) ? [{}] : []; } },
    { id: 'D002', cat: 'docs', sev: 'low', title: 'README is tiny', why: 'A near-empty README means users have no way to review what they are installing.', fix: 'Explain purpose, install, usage and permissions in at least a few paragraphs.',
      run: function (c) { var r = c.entries.filter(function (e) { return /^readme(\.[a-z]+)?$/i.test(e.name) && e.depth === 0; })[0]; return r && r.size < 300 ? [{ path: r.path, snippet: r.size + ' bytes' }] : []; } },
    { id: 'D003', cat: 'docs', sev: 'medium', title: 'No license', why: 'Without a license you have no legal right to use or modify the code, and it hints at a drive-by project.', fix: 'Add a LICENSE file (MIT / Apache-2.0 are common).',
      run: function (c) { var has = (c.repo.license && c.repo.license.spdx_id && c.repo.license.spdx_id !== 'NOASSERTION') || c.entries.some(function (e) { return /^(licen[sc]e|copying|unlicense)(\.[a-z]+)?$/i.test(e.name) && e.depth <= 3; }); return c.scopeRoot && !has ? [{}] : []; } },
    { id: 'D004', cat: 'docs', sev: 'low', title: 'No SECURITY.md', why: 'People who find a vulnerability need to know where to report it.', fix: 'Add a SECURITY.md (or .github/SECURITY.md) with a contact and disclosure policy.',
      run: function (c) { return c.scopeRoot && !c.entries.some(function (e) { return /^security\.md$/i.test(e.name) && e.depth <= 1; }) ? [{}] : []; } },
    { id: 'D006', cat: 'docs', sev: 'low', title: 'README does not explain install or usage', why: 'If the README skips install/usage, users will copy commands from elsewhere.', fix: 'Add "Install" and "Usage" sections, including what permissions the tool needs.',
      run: function (c) { return c.readme && c.readme.length >= 300 && !/^#{1,4}\s*(?:install|installation|usage|getting started|quick ?start|setup|how to use)/im.test(c.readme) && !/\b(?:npx|pip install|uvx|npm i(?:nstall)?|docker run|git clone|claude mcp add)\b/i.test(c.readme) ? [{ path: c.readmePath }] : []; } },
    { id: 'D007', cat: 'docs', sev: 'low', title: 'Repository has no description', why: 'No one-line description makes the repo harder to vet.', fix: 'Add a short description in the repository settings.',
      run: function (c) { return c.scopeRoot && !c.repo.description ? [{}] : []; } },
    { id: 'M001', cat: 'docs', sev: 'high', title: 'Repository is archived', why: 'Archived means read-only and unmaintained: no security fixes are coming.', fix: 'Look for an actively maintained fork or successor.',
      run: function (c) { return c.repo.archived ? [{}] : []; } },
    { id: 'M002', cat: 'docs', sev: 'medium', title: 'No recent pushes', why: 'Dependencies and APIs rot. Long-idle repos accumulate known vulnerabilities.', fix: 'Check whether it is still maintained before relying on it.',
      run: function (c) {
        var last = c.commits.length ? c.commits[0].date : c.repo.pushed_at, d = daysSince(last, c.now);
        if (c.repo.archived) return [];
        if (d > 365) return [{ sev: 'medium', snippet: 'last commit ' + Math.floor(d) + ' days ago' }];
        if (d > 180) return [{ sev: 'low', snippet: 'last commit ' + Math.floor(d) + ' days ago' }];
        return [];
      } },
    { id: 'M003', cat: 'docs', sev: 'low', title: 'Single contributor in recent history', why: 'One person is one point of failure (and one compromised account).', fix: 'Not a flaw by itself, but weigh it. Look for a second maintainer if you depend on it.',
      run: function (c) { return c.commits.length >= 5 && c.authors.length === 1 ? [{ snippet: 'all ' + c.commits.length + ' recent commits by ' + c.authors[0] }] : []; } },
    { id: 'M004', cat: 'docs', sev: 'low', title: 'Brand-new repository', why: 'Very new repos have no track record. Many malicious skills are created and abandoned within days.', fix: 'Check the author, read the source, and wait for some history if the stakes are high.',
      run: function (c) { var d = daysSince(c.repo.created_at, c.now); return d < 14 ? [{ snippet: 'created ' + Math.max(0, Math.floor(d)) + ' day(s) ago' }] : []; } },
    { id: 'M005', cat: 'docs', sev: 'low', title: 'Repository is a fork', why: 'Forks can carry changes the original author never reviewed.', fix: 'Compare with upstream and make sure the delta is what you expect.',
      run: function (c) { return c.repo.fork ? [{ snippet: 'fork of ' + (c.repo.parent ? c.repo.parent.full_name : 'another repository') }] : []; } },
    { id: 'N005', cat: 'code', sev: 'info', title: 'External hosts mentioned in code / config',
      why: 'The network surface a reviewer should know about. Informational only: it does not change the score.', fix: 'Make sure each host is expected and documented in the README.',
      run: function (c) {
        var hs = c.hosts;
        if (!hs.length) return [];
        return [{ snippet: hs.length + ' host(s): ' + hs.slice(0, 14).join(', ') + (hs.length > 14 ? ', …' : '') }];
      } },
    { id: 'N006', cat: 'code', sev: 'low', title: 'Many distinct external hosts in code',
      why: 'A long list of outbound destinations is hard to review and easier to abuse.', fix: 'Trim the list or document each destination.',
      run: function (c) { return c.codeHosts.length > 8 ? [{ snippet: c.codeHosts.length + ' distinct hosts in code files' }] : []; } },
    { id: 'A007', cat: 'code', sev: 'low', title: 'Skill ships executable scripts but declares no allowed-tools',
      why: 'A skill that bundles scripts should say which tools it needs so the agent can ask first.', fix: 'Add `allowed-tools` to the SKILL.md frontmatter with narrow patterns.',
      run: function (c) {
        var out = [];
        c.skillDirs.forEach(function (sd) {
          var has = c.entries.some(function (e) { return e.path.indexOf(sd.dir) === 0 && /^(sh|bash|ps1|py|js|ts|bat)$/.test(e.ext) && e.path !== sd.skillPath; });
          var fm = c.skillFm[sd.skillPath];
          if (has && fm && !fm['allowed-tools']) out.push({ path: sd.skillPath, line: 1, snippet: 'scripts present, no allowed-tools' });
        });
        return out.slice(0, 5);
      } }
  ];

  var BLIND_SPOTS = [
    'This is pattern matching on text. Paraphrased, translated, split-up or cleverly obfuscated attacks will pass. Commercial skill scanners have been bypassed in under an hour.',
    'No LLM or human reads the instructions, so pure social engineering ("please download and run this helper") is only caught when it matches a rule.',
    'Links and docs a skill points to are never fetched. A page that is clean today can serve different instructions after you trust it.',
    'Binaries, archives, .pyc bytecode, office documents and images are not opened. Text hidden inside them is invisible to this scan.',
    'Only the files listed as analyzed were read (max 40, max 200 KB each). Everything else is unchecked.',
    'Dependencies are not scanned for known vulnerabilities or malware, and nothing is executed or sandboxed.',
    'Only the latest commit on the default branch is read. Other branches, tags, history, and future pushes are not covered.',
    'A high score means "no rule fired", not "safe". Read the code before you install or run anything.'
  ];

  var api = {
    RULESET: RULESET, SCORING: SCORING, CATEGORIES: CATEGORIES, LIMITS: LIMITS, FILES: FILES,
    lineRules: lineRules, specialRules: specialRules, pathRules: pathRules, fileRules: fileRules, repoRules: repoRules,
    BLIND_SPOTS: BLIND_SPOTS,
    helpers: { entropy: entropy, lineOf: lineOf, parseJson: parseJson, frontmatter: frontmatter, PLACEHOLDER: PLACEHOLDER }
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.PUSHY_RULES = api;
})(typeof window !== 'undefined' ? window : globalThis);
