/* Pushy Rescue: turn Pushy Score findings into concrete fixes.
   Pure functions, no network, no DOM. Works in the browser (window.PushyRescue) and in node (module.exports) for tests.
   Needs the Pushy Score engine (../score/pushy.js + rules.js) and a report made with scan(..., { keepContext: true }).
   Mechanical edits are plain line edits. Nothing is guaranteed safe: every edit is re-scanned, never run, and meant to be read as a diff.
   The "projected score" is the same engine run on the patched file texts. It is a what-if, never a score. */
(function (root) {
  'use strict';
  var VERSION = '1.0.0';
  var R = root.PUSHY_RULES || (typeof require === 'function' ? require('../score/rules.js') : null);
  function engine() { return root.Pushy || (typeof require === 'function' ? require('../score/pushy.js') : null); }
  var SEV = { critical: 4, high: 3, medium: 2, low: 1, info: 0 };
  var NONL = '\u0000\u0001NONL';
  var ROTATE = { S001: 1, S002: 1, S003: 1, S004: 1, S005: 1, S006: 1, S007: 1, S008: 1, S009: 1, S010: 1, S011: 1 };
  var SIGNAL = { M001: 1, M002: 1, M003: 1, M004: 1, M005: 1, N005: 1, N006: 1 };

  /* ------------------------------------------------------------ small helpers */
  function ruleById(id) {
    var all = [].concat(R.lineRules, R.specialRules, R.fileRules, R.pathRules, R.repoRules);
    for (var i = 0; i < all.length; i++) if (all[i].id === id) return all[i];
    return null;
  }
  function extOf(p) { var n = p.split('/').pop(), d = n.lastIndexOf('.'); return d > 0 ? n.slice(d + 1).toLowerCase() : (d === 0 ? n.slice(1).toLowerCase() : ''); }
  function clean(s, max) { // safe for Markdown / HTML: no control or bidi characters, no backticks, one line
    s = String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g, ' ').replace(/`/g, "'").replace(/\s+/g, ' ').trim();
    return max && s.length > max ? s.slice(0, max - 1) + '…' : s;
  }
  function flat(s, max) { // for our own static text (keeps backticks); strips control and bidi characters, one line
    s = String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g, ' ').replace(/\s+/g, ' ').trim();
    return max && s.length > max ? s.slice(0, max - 1) + '…' : s;
  }
  function keepLine(s, max) { // for a preview line: strip control and bidi characters but keep spacing
    s = String(s == null ? '' : s).replace(/[\u0000-\u0008\u000a-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g, '\u00b7').replace(/\t/g, '  ');
    return max && s.length > max ? s.slice(0, max - 1) + '…' : s;
  }
  function envName(s) {
    s = String(s || '').replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').toUpperCase();
    if (!s) s = 'SECRET'; if (/^\d/.test(s)) s = 'SECRET_' + s;
    return s.slice(0, 48);
  }
  function swap(cur, start, end, rep) { return cur.slice(0, start) + rep + cur.slice(end); }
  function fenceFor(s) { var n = 3; while (s.indexOf(new Array(n + 1).join('`')) >= 0) n++; return new Array(n + 1).join('`'); }

  /* ------------------------------------------------------------ one editable file */
  function FileEdit(path, text) {
    this.path = path; this.orig = text;
    this.mixed = /\r(?!\n)/.test(text) || (/\r\n/.test(text) && /(^|[^\r])\n/.test(text));
    this.crlf = !this.mixed && /\r\n/.test(text);
    var raw = text.split('\n');
    this.endNL = raw.length > 1 && raw[raw.length - 1] === '';
    if (this.endNL) raw.pop();
    var crlf = this.crlf;
    this.lines = raw.map(function (l) { return crlf ? l.replace(/\r$/, '') : l; });
    this.cur = this.lines.map(function (l) { return [l]; });
    this.maps = [];
  }
  FileEdit.prototype.get = function (i) { var c = this.cur[i]; return c && c.length === 1 ? c[0] : null; };
  FileEdit.prototype.set = function (i, arr) { this.cur[i] = arr; };
  FileEdit.prototype.del = function (i) { this.cur[i] = []; };
  FileEdit.prototype.text = function () {
    var eol = this.crlf ? '\r\n' : '\n', out = [];
    this.cur.forEach(function (c) { for (var k = 0; k < c.length; k++) out.push(c[k]); });
    var t = out.join(eol) + (this.endNL && out.length ? eol : '');
    for (var j = 0; j < this.maps.length; j++) t = this.maps[j](t);
    return t;
  };

  /* ------------------------------------------------------------ unified diff */
  function splitForDiff(t) {
    if (t === '') return [];
    var a = t.split('\n'), nl = false;
    if (a[a.length - 1] === '') { a.pop(); nl = true; }
    if (a.length && !nl) a[a.length - 1] += NONL;
    return a;
  }
  function lcsOps(a, b) { // ops over the middle section: {t:' ' | '-' | '+', s}
    var n = a.length, m = b.length, ops = [], i, j;
    if (!n || !m || n * m > 2500000) { a.forEach(function (s) { ops.push({ t: '-', s: s }); }); b.forEach(function (s) { ops.push({ t: '+', s: s }); }); return ops; }
    var dp = new Array(n + 1); for (i = 0; i <= n; i++) dp[i] = new Uint32Array(m + 1);
    for (i = n - 1; i >= 0; i--) for (j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    i = 0; j = 0;
    while (i < n && j < m) {
      if (a[i] === b[j]) { ops.push({ t: ' ', s: a[i] }); i++; j++; }
      else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push({ t: '-', s: a[i] }); i++; }
      else { ops.push({ t: '+', s: b[j] }); j++; }
    }
    while (i < n) ops.push({ t: '-', s: a[i++] });
    while (j < m) ops.push({ t: '+', s: b[j++] });
    return ops;
  }
  function unifiedDiff(path, oldText, newText) {
    if (oldText === newText) return '';
    var isNew = oldText === null, a = splitForDiff(isNew ? '' : oldText), b = splitForDiff(newText);
    var p = 0; while (p < a.length && p < b.length && a[p] === b[p]) p++;
    var q = 0; while (q < a.length - p && q < b.length - p && a[a.length - 1 - q] === b[b.length - 1 - q]) q++;
    var ops = [], k;
    for (k = 0; k < p; k++) ops.push({ t: ' ', s: a[k] });
    lcsOps(a.slice(p, a.length - q), b.slice(p, b.length - q)).forEach(function (o) { ops.push(o); });
    for (k = a.length - q; k < a.length; k++) ops.push({ t: ' ', s: a[k] });
    var changes = []; ops.forEach(function (o, i) { if (o.t !== ' ') changes.push(i); });
    if (!changes.length) return '';
    var ranges = [], CTX = 3;
    changes.forEach(function (ci) {
      var s = Math.max(0, ci - CTX), e = Math.min(ops.length - 1, ci + CTX), last = ranges[ranges.length - 1];
      if (last && s <= last[1] + 1) last[1] = e; else ranges.push([s, e]);
    });
    var out = ['diff --git a/' + path + ' b/' + path];
    if (isNew) out.push('new file mode 100644');
    out.push(isNew ? '--- /dev/null' : '--- a/' + path, '+++ b/' + path);
    ranges.forEach(function (r) {
      var oBefore = 0, nBefore = 0, oc = 0, nc = 0, i;
      for (i = 0; i < r[0]; i++) { if (ops[i].t !== '+') oBefore++; if (ops[i].t !== '-') nBefore++; }
      var body = [];
      for (i = r[0]; i <= r[1]; i++) {
        var o = ops[i]; if (o.t !== '+') oc++; if (o.t !== '-') nc++;
        var s = o.s, nonl = s.slice(-NONL.length) === NONL; if (nonl) s = s.slice(0, -NONL.length);
        body.push(o.t + s); if (nonl) body.push('\\ No newline at end of file');
      }
      out.push('@@ -' + (oc === 0 ? oBefore : oBefore + 1) + ',' + oc + ' +' + (nc === 0 ? nBefore : nBefore + 1) + ',' + nc + ' @@');
      body.forEach(function (l) { out.push(l); });
    });
    return out.join('\n') + '\n';
  }

  /* ------------------------------------------------------------ mechanical generators */
  var HIDDEN_RE = /[\u202A-\u202E\u2066-\u2069\u200B\u200C\u2060-\u2064\u180E\u200E\u200F\u00AD\uFEFF]|[\u{E0000}-\u{E007F}]/gu;

  function nameFor(ruleId, cur, start, lit) {
    if (ruleId === 'S011') return 'NPM_TOKEN';
    var m = /([A-Za-z_][A-Za-z0-9_.-]*)["']?\s*[:=]\s*["'`]?$/.exec(cur.slice(0, start));
    if (m && ruleId !== 'S001') return envName(m[1]);
    if (m && /^[A-Z][A-Z0-9_]+$/.test(m[1])) return m[1];
    switch (ruleId) {
      case 'S001': return 'AWS_ACCESS_KEY_ID';
      case 'S002': return 'GITHUB_TOKEN';
      case 'S003': return /^sk-ant/.test(lit) ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY';
      case 'S004': return /^xox/.test(lit) ? 'SLACK_TOKEN' : /^[sr]k_live/.test(lit) ? 'STRIPE_SECRET_KEY' : /^SG\./.test(lit) ? 'SENDGRID_API_KEY' : 'NPM_TOKEN';
      case 'S006': return /^AIza/.test(lit) ? 'GOOGLE_API_KEY' : /hooks\.slack/.test(lit) ? 'SLACK_WEBHOOK_URL' : 'TELEGRAM_BOT_TOKEN';
      default: return 'SECRET';
    }
  }
  /* which quote (if any) is open at position `at` of a single line; a rough shell/JS tokenizer */
  function quoteState(line, at) {
    var st = '', i, c;
    for (i = 0; i < at; i++) {
      c = line[i];
      if (c === '\\' && st !== "'") { i++; continue; }
      if (st) { if (c === st) st = ''; } else if (c === '"' || c === "'" || c === '`') st = c;
    }
    return st;
  }
  /* returns { after: newLine, how } or null when a safe line edit is not possible */
  function placeholder(path, name, cur, start, end, ruleId) {
    var ext = extOf(path), base = path.split('/').pop().toLowerCase();
    var b = cur[start - 1], a = cur[end], q = (b === '"' || b === "'" || b === '`') && a === b ? b : null;
    if (/^\.env/.test(base)) return null;
    if (ruleId === 'S011') return { after: swap(cur, start, end, '${NPM_TOKEN}'), how: 'reads ${NPM_TOKEN}' };
    if (/^(sh|bash|zsh|ksh)$/.test(ext)) {
      var pre = /^(\s*)(export\s+)?([A-Za-z_][A-Za-z0-9_]*)=["']?$/.exec(cur.slice(0, start)), post = /^["']?\s*(#.*)?$/.test(cur.slice(end));
      if (pre && post) return { after: pre[1] + (pre[2] || '') + pre[3] + '="${' + pre[3] + ':?set ' + pre[3] + ' in your environment}"', how: 'fails with a clear message unless ' + pre[3] + ' is set' };
      var qs = quoteState(cur, start);
      if (qs === "'" || qs === '`') return null;
      if (qs === '"') return { after: swap(cur, start, end, '${' + name + '}'), how: 'reads $' + name };
      return { after: swap(cur, start, end, '"${' + name + '}"'), how: 'reads $' + name };
    }
    if (/^(js|mjs|cjs|ts|tsx|jsx|mts|cts)$/.test(ext)) {
      if (q) return { after: swap(cur, start - 1, end + 1, 'process.env.' + name), how: 'reads process.env.' + name };
      if (quoteState(cur, start) === '`') return { after: swap(cur, start, end, '${process.env.' + name + '}'), how: 'reads process.env.' + name };
      return null;
    }
    if (ext === 'py') {
      return null; // needs "import os" to exist; handled by the caller, which knows the whole file
    }
    if (/^\.github\/workflows\/.+\.ya?ml$/i.test(path)) return { after: swap(cur, start, end, '${{ secrets.' + name + ' }}'), how: 'reads the repository secret ' + name };
    if (/^(ya?ml|json|jsonc|toml|ini|cfg|conf|properties)$/.test(ext)) return { after: swap(cur, start, end, '${' + name + '}'), how: 'uses ${' + name + '} (only works if your tool expands environment variables)' };
    if (/^(md|mdx|txt|rst)$/.test(ext)) return { after: swap(cur, start, end, '<YOUR_' + name + '>'), how: 'documents a placeholder' };
    return null;
  }

  function secretGen(f, file, env) {
    var idx = f.line - 1, cur = file.get(idx), rule = ruleById(f.id);
    if (cur === null || !rule || !rule.re) return null;
    var re = new RegExp(rule.re.source, rule.re.flags.replace('g', '') + 'g'), m, hit = null;
    while ((m = re.exec(cur))) { if (!rule.filter || rule.filter(m, cur)) { hit = m; break; } if (m[0] === '') re.lastIndex++; }
    if (!hit) return null;
    var lit = (f.id === 'S007' || f.id === 'S011') ? hit[1] : hit[0];
    var start = hit.index + hit[0].lastIndexOf(lit), end = start + lit.length;
    if (f.id === 'S006' && /hooks\.slack/.test(lit) && cur.slice(0, start).slice(-8) === 'https://') start -= 8;
    var name = nameFor(f.id, cur, start, cur.slice(start, end)), res;
    if (extOf(f.path) === 'py') {
      var q = (cur[start - 1] === '"' || cur[start - 1] === "'") && cur[end] === cur[start - 1];
      if (q && /^\s*(?:import os\b|from os import|import [\w ,.]*\bos\b)/m.test(file.orig)) res = { after: swap(cur, start - 1, end + 1, 'os.environ["' + name + '"]'), how: 'reads os.environ["' + name + '"]' };
    } else res = placeholder(f.path, name, cur, start, end, f.id);
    if (!res) return null;
    env.secrets.push(cur.slice(start, end));
    file.set(idx, [res.after]);
    return { explain: 'Replaces the committed value with a reference that ' + res.how + '. The old value is still in git history and in every clone, so rotate it first.', needsInput: 'Create ' + name + ' in your environment or secret store.' };
  }

  function keyBlockGen(f, file, env) {
    var idx = f.line - 1, cur = file.get(idx);
    if (cur === null || !/^\s*-----BEGIN [A-Z ]*PRIVATE KEY(?: BLOCK)?-----\s*$/.test(cur)) return null;
    if (!/^(md|mdx|txt|rst)$/.test(extOf(f.path))) return null; // inside code or config a deleted block can break the file, so that stays manual
    if (/\.(pem|key|p12|pfx|ppk|jks|keystore)$/i.test(f.path) || /(^|\/)id_(rsa|dsa|ecdsa|ed25519)$/.test(f.path)) return null;
    var e = -1;
    for (var i = idx; i < Math.min(file.lines.length, idx + 200); i++) { if (/-----END [A-Z ]*PRIVATE KEY(?: BLOCK)?-----/.test(file.lines[i])) { e = i; break; } }
    if (e < 0) return null;
    for (var k = idx; k <= e; k++) { if (file.get(k) === null) return null; }
    for (var j = idx; j <= e; j++) { if (j > idx && j < e) env.secrets.push(file.lines[j].trim()); file.del(j); }
    return { explain: 'Deletes the ' + (e - idx + 1) + '-line private key block. The key is still in git history and in every clone, so treat it as burned and replace it.', needsInput: 'Load the replacement key from a secret store; this edit leaves the file without it.' };
  }

  function curlPipeGen(f, file) {
    var idx = f.line - 1, cur = file.get(idx);
    if (cur === null || !/^(sh|bash|zsh|ksh|md|mdx|txt|rst)$/.test(extOf(f.path))) return null;
    var m = /^(\s*(?:\$\s+)?)(sudo\s+)?(curl|wget)\b([^|]*)\|\s*(sudo\s+)?((?:ba|z|da|k)?sh)\b(.*)$/i.exec(cur);
    if (!m) return null;
    var url = /https?:\/\/[^\s"'|)<>]+/.exec(m[4]);
    if (!url) return null;
    var tail = m[7].trim().replace(/^-s\b\s*/, '').replace(/^--\s*/, '');
    if (!/^[A-Za-z0-9_ ./=:@%+,-]*$/.test(tail)) return null;
    var sudo = (m[2] || m[5]) ? 'sudo ' : '', p = m[1], v = '"$PUSHY_INSTALLER"';
    var dl = /^curl$/i.test(m[3]) ? 'curl -fsSL "' + url[0] + '" -o ' + v : 'wget -q "' + url[0] + '" -O ' + v;
    file.set(idx, [
      p + 'PUSHY_INSTALLER="$(mktemp)"',
      p + dl,
      p + '# Read the file first, then put its SHA-256 below. The check fails until you do.',
      p + 'echo "REPLACE_WITH_SHA256  $PUSHY_INSTALLER" | sha256sum -c -',
      p + sudo + m[6].toLowerCase() + ' ' + v + (tail ? ' ' + tail : '')
    ]);
    return { explain: 'Downloads to a temp file, checks a SHA-256 you fill in, then runs it. It stops until you read the script and paste its checksum, which is the point.', needsInput: 'Read the downloaded script and replace REPLACE_WITH_SHA256 with its real checksum (or switch to a package manager).' };
  }

  function hiddenUnicodeGen(f, file, env) {
    var key = 'P011|' + f.path;
    if (env.whole[key]) return env.whole[key];
    var n = 0;
    for (var i = 0; i < file.cur.length; i++) {
      var s = file.get(i); if (s === null) continue;
      var lead = (i === 0 && s.charCodeAt(0) === 0xFEFF) ? '\uFEFF' : '', body = lead ? s.slice(1) : s;
      var ns = body.replace(HIDDEN_RE, function () { n++; return ''; });
      if (ns !== body) file.set(i, [lead + ns]);
    }
    if (!n) return null;
    return (env.whole[key] = { explain: 'Removes ' + n + ' invisible character' + (n === 1 ? '' : 's') + ' (zero-width, bidi and tag characters) from the file. Open it afterwards: if it is text in a script that needs a joiner (for example Persian or some emoji), restore those by hand.', whole: true });
  }

  function paddingGen(f, file, env) {
    if (!/^run of/.test(f.snippet || '')) return null;
    var key = 'P013|' + f.path;
    if (env.whole[key]) return env.whole[key];
    file.maps.push(function (t) { return t.replace(/(?:\r?\n){200,}/g, function (m) { return /\r\n/.test(m) ? '\r\n\r\n' : '\n\n'; }).replace(/[ \t]{1000,}/g, ' '); });
    return (env.whole[key] = { explain: 'Collapses the padding (hundreds of blank lines or a thousand-plus spaces) so the content after it is visible. Read what was hidden behind it.', whole: true });
  }

  function lineDeleteGen(f, file) {
    var idx = f.line - 1, cur = file.get(idx), e = file.entry;
    if (cur === null || !e || e.kind !== 'instr' || !/^(md|mdx|txt|mdc|rst)$|^$/.test(e.ext) || cur.length > 300) return null;
    var rule = ruleById(f.id), re = new RegExp(rule.re.source, rule.re.flags.replace('g', ''));
    if (!re.test(cur)) return null;
    var fences = 0; for (var q = 0; q < idx; q++) if (/^\s*(```|~~~)/.test(file.lines[q])) fences++;
    if (fences % 2 === 1 || /^\s*(```|~~~)/.test(cur)) return null; // inside a code block it is probably an example, so a person decides
    file.del(idx);
    if (idx > 0 && idx + 1 < file.lines.length && file.lines[idx - 1].trim() === '' && file.lines[idx + 1].trim() === '' && file.get(idx + 1) === file.lines[idx + 1]) file.del(idx + 1);
    return { explain: 'Deletes this line from an instruction file. If it was an intentional example of an attack, move it into a clearly marked test fixture instead.' };
  }

  function htmlCommentGen(f, file) {
    var idx = f.line - 1, cur = file.get(idx);
    if (cur === null) return null;
    var m = /<!--[^\n]*?-->/.exec(cur);
    if (!m) return null;
    var ns = (cur.slice(0, m.index) + cur.slice(m.index + m[0].length)).replace(/\s+$/, '');
    if (/^\s*$/.test(ns)) file.del(idx); else file.set(idx, [ns]);
    return { explain: 'Removes the HTML comment. Readers of rendered Markdown never see it, but the model does. If the text matters, put it in visible prose.' };
  }

  function forcePushGen(f, file) {
    var idx = f.line - 1, cur = file.get(idx);
    if (cur === null || !/^(sh|bash|zsh|ksh|ya?ml)$/.test(extOf(f.path)) || !/^\s*(?:(?:run:\s*|-\s*|\$\s*|sudo\s+|\|\s*)*)git\s+push\b/.test(cur)) return null; // only a line that starts a git push, never prose or a string
    var ns = cur.replace(/(\bgit\s+push\b[^\n]*?)\s(?:-f|--force)(?!-with-lease)\b/, '$1 --force-with-lease');
    if (ns === cur) return null;
    file.set(idx, [ns]);
    return { explain: '--force-with-lease refuses to overwrite commits you have not seen, which plain --force does not.' };
  }

  function httpsGen(f, file) {
    var idx = f.line - 1, cur = file.get(idx), rule = ruleById('N004');
    if (cur === null) return null;
    var re = new RegExp(rule.re.source, 'gi'), n = 0;
    var ns = cur.replace(re, function (m) { n++; return 'https://' + m.slice(7); });
    if (!n) return null;
    file.set(idx, [ns]);
    return { explain: 'Switches the URL to https://. Check that the host really serves HTTPS before you merge; if it does not, the call will fail instead of leaking.', needsInput: 'Confirm the host supports HTTPS.' };
  }

  function writeAllGen(f, file) {
    var idx = f.line - 1, cur = file.get(idx);
    if (cur === null) return null;
    var m = /^(\s*)permissions\s*:\s*write-all\s*(#.*)?$/.exec(cur);
    if (!m) return null;
    file.set(idx, [m[1] + 'permissions:', m[1] + '  contents: read']);
    return { explain: 'Drops the workflow token to read-only. A job that pushes, comments or publishes now needs its own explicit scope (for example contents: write on that job only).', needsInput: 'Add back only the write scopes your jobs actually need.' };
  }

  function installHookGen(f, file) {
    var idx = f.line - 1, cur = file.get(idx);
    if (cur === null) return null;
    var hm = /^\s*"(preinstall|install|postinstall|prepare|prepublish|prepack)"\s*:\s*"(?:[^"\\]|\\.)*"\s*(,?)\s*$/.exec(cur);
    if (!hm) return null;
    if (hm[2] !== ',') { // last entry: the previous kept line must lose its trailing comma
      var j = idx - 1; while (j >= 0 && (file.cur[j].length === 0 || /^\s*$/.test(file.get(j) || ''))) j--;
      var pv = j >= 0 ? file.get(j) : null;
      if (pv === null || !/,\s*$/.test(pv)) return null;
      file.set(j, [pv.replace(/,\s*$/, '')]);
    }
    file.del(idx);
    var chk = file.text(); try { JSON.parse(chk); } catch (e) { return { revert: true }; }
    return { explain: 'Removes the "' + hm[1] + '" hook so nothing runs on npm install. If you need that step, document it as an explicit setup command.', needsInput: 'Check that your build or tests do not depend on this hook.' };
  }

  function indexLineGen(f, file) {
    var idx = f.line - 1, cur = file.get(idx);
    if (cur === null || !/^\s*--(?:extra-)?index-url\b|^\s*--trusted-host\b/i.test(cur)) return null;
    file.del(idx);
    return { explain: 'Removes the extra package index line so installs only use the default index (dependency-confusion defence). Packages that live only on that index will stop resolving.', needsInput: 'If you really need a private index, pin hashes with --require-hashes instead.' };
  }

  var GEN = {
    S001: secretGen, S002: secretGen, S003: secretGen, S004: secretGen, S006: secretGen, S007: secretGen, S011: secretGen, S005: keyBlockGen,
    X001: curlPipeGen, X010: forcePushGen, N004: httpsGen,
    P011: hiddenUnicodeGen, P013: paddingGen, P001: lineDeleteGen, P002: lineDeleteGen, P009: lineDeleteGen, P004: htmlCommentGen,
    A004: installHookGen, A005: indexLineGen, A006: writeAllGen
  };

  /* ------------------------------------------------------------ manual steps (checklists) */
  function manualSteps(id, f, info) {
    var s = [], snip = String(f.snippet || '');
    switch (id) {
      case 'S001': case 'S002': case 'S003': case 'S004': case 'S006': case 'S007': case 'S011':
        s.push('Revoke or rotate the credential at the provider now. Do this first; deleting the line does not un-leak it.');
        s.push('Replace the literal with a reference to an environment variable or secret store, and commit a `.env.example` with fake values.');
        s.push('Check the provider\'s logs for use you do not recognise.'); break;
      case 'S005': s.push('Treat the key as burned: generate a new pair and replace it everywhere it is trusted.'); s.push('Remove the file with `git rm` and add the path to `.gitignore`.'); break;
      case 'S008': s.push('Move any wallet keypair or seed phrase out of the repo. If a real one was committed, move the funds to a fresh wallet.'); s.push('Use a hardware wallet or a scoped signer; reference keys by path outside the repo.'); break;
      case 'S009': s.push('Run `git rm --cached ' + clean(f.path) + '` and add `' + clean(f.path.split('/').pop()) + '` to `.gitignore`.'); s.push('Rotate every value that was inside it; the file is still in history.'); s.push('Commit a `.env.example` with placeholder values.'); break;
      case 'S010': s.push('Run `git rm --cached ' + clean(f.path) + '` and add the path to `.gitignore`.'); s.push('Treat the credential as burned and issue a new one.'); break;
      case 'X002': case 'X003': s.push('Replace `eval`/`exec` with `JSON.parse`, `ast.literal_eval` or a lookup table of allowed actions.'); s.push('Never pass model output, network data or file contents into it.'); break;
      case 'X004': s.push('Pass an argument array (`execFile`, `subprocess.run([...])`) with no shell, and validate inputs against an allow-list.'); s.push('Say in the README why a subprocess is needed.'); break;
      case 'X005': s.push('Remove the command, or limit it to a temp directory you create yourself, and ask the user before it runs.'); break;
      case 'X006': s.push('Decode the blob, read what it does, and commit that as readable code. Delete it if you cannot explain it.'); break;
      case 'X007': s.push('Do not edit shell startup files or schedule jobs from a skill. If a daemon is needed, make it opt-in and documented.'); break;
      case 'X008': s.push('Remove the read, or name the single file needed and ask the user first.'); break;
      case 'X009': s.push('Delete it. If you did not write it, treat the repo as compromised and check who added it.'); break;
      case 'X011': s.push('Write the string out plainly, or load real binary data from a documented file.'); break;
      case 'N001': s.push('Remove the endpoint, or document exactly what is sent there and add a switch to turn it off.'); break;
      case 'N002': s.push('Send only the fields the API needs, never `process.env` or key files, and name the destination in the README.'); break;
      case 'N003': s.push('Use a named host over HTTPS, or explain in the README why a raw IP is required.'); break;
      case 'P003': s.push('Delete the hidden-instruction block. Keep tool and skill text to what the tool does; put policy in your own system prompt.'); break;
      case 'P005': case 'P007': s.push('Remove the instruction. If a file must be read or data sent, name it, keep it local or opt-in, and tell the user.'); break;
      case 'P006': s.push('Vendor the instructions into the repo (pinned to a commit) instead of fetching them at run time.'); break;
      case 'P008': s.push('Describe what the tool does, not when it outranks other tools.'); break;
      case 'P010': s.push('Keep confirmations on for anything that writes, deletes, spends or sends.'); break;
      case 'P001': case 'P002': case 'P009': s.push('Delete the sentence. If it is a security example, move it into a clearly marked test fixture.'); break;
      case 'P004': s.push('Make the text visible in the document or delete the comment.'); break;
      case 'P011': s.push('Strip the invisible characters (`grep -nP "[\\x{200B}-\\x{200F}\\x{202A}-\\x{202E}\\x{2066}-\\x{2069}]" ' + clean(f.path) + '`) and re-read the file.'); break;
      case 'P012': s.push('Decode the blob and replace it with readable text, or move real binary data to a documented file with a checksum.'); break;
      case 'P013': s.push('Remove the padding and read what comes after it (very long lines may be minified code or hidden text).'); break;
      case 'A001': s.push('In the SKILL.md frontmatter list the narrowest tools, for example `allowed-tools: Read, Bash(git status:*)` instead of `Bash` or `*`.'); break;
      case 'A002': s.push('Remove `bypassPermissions`, blanket `allow` rules, `enableAllProjectMcpServers` and `runOn: folderOpen` tasks.'); s.push('Review every hook command; it runs for anyone who opens the project.'); break;
      case 'A003': {
        var pk = /unpinned package `([^`]+)`/.exec(snip);
        if (pk) s.push('Pin `' + clean(pk[1]) + '`: run `npm view ' + clean(pk[1]) + ' version` (or `pip index versions`), then use `' + clean(pk[1]) + '@<that version>` in the config.');
        else s.push('Pin versions (`pkg@1.2.3`, `pkg==1.2.3`), avoid `sh -c`, drop `--privileged` and host mounts, and use https.');
        break;
      }
      case 'A004': s.push('Pin dependencies to exact registry versions (`npm install <pkg>@<version> --save-exact`) and drop git or URL sources.'); s.push('Replace install hooks with a documented setup command.'); break;
      case 'A005': s.push('Pin the git install to a full commit hash (`@<40-char sha>`) or use a released version.'); break;
      case 'A006': s.push('Do not put `${{ github.event.* }}` text inside `run:`. Pass it through `env:` and read `"$VAR"` in the script.'); s.push('Avoid `pull_request_target` together with a checkout of the PR head, and set `permissions: contents: read`.'); break;
      case 'A007': s.push('Add `allowed-tools` to the SKILL.md frontmatter with narrow patterns for the scripts it ships.'); break;
      case 'D001': s.push('Add a README.md: what it does, how to install, how to use, and what permissions or network access it needs.'); break;
      case 'D002': case 'D006': s.push('Expand the README with "Install" and "Usage" sections and the permissions the tool needs.'); break;
      case 'D003': s.push('Pick a license (choosealicense.com) and add it as `LICENSE`. This is your decision, so Rescue does not write one for you.'); break;
      case 'D004': s.push('Add a `SECURITY.md` with a private contact, and enable private vulnerability reporting in the repo settings.'); break;
      case 'D005': s.push('Start SKILL.md with frontmatter: `name` (lowercase-hyphen, up to 64 chars) and `description` (up to 1024 chars).'); break;
      case 'D007': s.push('Add a one-line description in the repository settings (or `gh repo edit <owner>/<repo> --description "..."`).'); break;
      case 'H001': s.push('Ship source and build in CI. If a binary must stay, publish its checksum and say how it is built.'); break;
      case 'H002': s.push('Commit the plain files instead of the archive, or document what is inside.'); break;
      default: if (info && info.rule && info.rule.fix) s.push(info.rule.fix);
    }
    return s;
  }

  /* ------------------------------------------------------------ build */
  function sev(f) { return f.sev || 'info'; }
  function securityMd(owner, repo) {
    return [
      '# Security Policy', '',
      '## Reporting a vulnerability', '',
      'Please report security problems privately through GitHub:',
      'https://github.com/' + owner + '/' + repo + '/security/advisories/new', '',
      'Do not open a public issue with exploit details or secrets.', '',
      '## Supported versions', '',
      'Fixes go to the default branch.', ''
    ].join('\n');
  }

  function build(report, opts) {
    opts = opts || {};
    var E = opts.engine || engine();
    var ctx = report && report.context;
    if (!ctx) throw new Error('Pushy Rescue needs a report made with scan(..., { keepContext: true }).');
    var meta = ctx.meta, entries = {}; ctx.entries.forEach(function (e) { entries[e.path] = e; });
    var env = { secrets: [], whole: {} }, files = {}, newFiles = {}, items = [], manual = {}, signals = [], infos = 0;

    function fileFor(p) {
      if (files[p]) return files[p];
      if (typeof ctx.texts[p] !== 'string') return null;
      var fe = new FileEdit(p, ctx.texts[p]); fe.entry = entries[p]; files[p] = fe; return fe;
    }

    var list = report.findings.slice().sort(function (a, b) { return SEV[sev(b)] - SEV[sev(a)] || (a.path || '').localeCompare(b.path || '') || (a.line || 0) - (b.line || 0); });
    list.forEach(function (f) {
      var rule = ruleById(f.id), url = f.url || null;
      if (SIGNAL[f.id] || f.sev === 'info') { if (SIGNAL[f.id]) signals.push(f); else infos++; return; }
      var done = null, fixNote = '';
      if (f.id === 'D004' && !f.path && meta.scopeRoot && meta.owner && meta.repoName && !newFiles['SECURITY.md'] && !entries['SECURITY.md']) {
        newFiles['SECURITY.md'] = securityMd(meta.owner, meta.repoName);
        items.push({ id: f.id, sev: sev(f), title: f.title, path: 'SECURITY.md', line: null, url: null, mode: 'mechanical', isNew: true, explain: 'Adds a short SECURITY.md that points reporters to GitHub\'s private advisory form for this repo.', needsInput: 'Turn on "Private vulnerability reporting" in Settings, Code security, or the link will not work.', before: [], after: ['# Security Policy', '', '## Reporting a vulnerability', '…'] });
        return;
      }
      var gen = GEN[f.id], fe = f.path ? fileFor(f.path) : null;
      if (gen && fe && f.line && !fe.mixed && f.line <= fe.lines.length) {
        var beforeLine = fe.lines[f.line - 1], snapshot = fe.cur.map(function (c) { return c.slice(); }), mapsN = fe.maps.length, secN = env.secrets.length;
        var r = null;
        try { r = gen(f, fe, env); } catch (err) { r = null; }
        if (r && r.revert) { fe.cur = snapshot; r = null; }
        if (r) done = r; else { fe.cur = snapshot; fe.maps.length = mapsN; env.secrets.length = secN; }
        if (done && !done.whole) {
          var after = []; fe.cur[f.line - 1].forEach(function (x) { after.push(x); });
          if (!after.length && done) after = ['(line removed)'];
          done.before = [beforeLine]; done.after = after;
        }
      } else if (gen && fe && fe.mixed) fixNote = 'Mixed line endings in this file, so Rescue left it alone.';
      else if (gen && !fe && f.path && entries[f.path]) fixNote = 'This file was not fully fetched, so no patch is offered for it.';
      if (done && done.whole) { if (done.pushed) return; done.pushed = true; }
      if (done) {
        items.push({ id: f.id, sev: sev(f), title: f.title, path: f.path, line: f.line, url: url, mode: 'mechanical', explain: done.explain, needsInput: done.needsInput || '', before: done.before || [], after: done.after || [], whole: !!done.whole });
      } else {
        var g = manual[f.id] || (manual[f.id] = { id: f.id, sev: sev(f), title: f.title, why: f.why || (rule && rule.why) || '', steps: manualSteps(f.id, f, { rule: rule }), note: fixNote, rotate: !!ROTATE[f.id], locations: [] });
        if (SEV[sev(f)] > SEV[g.sev]) g.sev = sev(f);
        g.locations.push({ path: f.path, line: f.line, url: url });
      }
    });

    /* assemble edits and the patch */
    var overrides = {}, patchParts = [], patchFiles = [];
    Object.keys(files).sort().forEach(function (p) {
      var nt = files[p].text();
      if (nt !== ctx.texts[p]) { overrides[p] = nt; var d = unifiedDiff(p, ctx.texts[p], nt); if (d) { patchParts.push(d); patchFiles.push(p); } }
    });
    Object.keys(newFiles).sort().forEach(function (p) { overrides[p] = newFiles[p]; patchParts.push(unifiedDiff(p, null, newFiles[p])); patchFiles.push(p); });

    /* re-run the engine on the patched texts (what-if only) */
    var before = E.rescore(ctx, {}), after = patchFiles.length ? E.rescore(ctx, overrides) : before;
    var baselineOk = before.score === report.score && before.findings.length === report.findings.length;
    function cnt(rep) { var c = {}; rep.findings.forEach(function (f) { var k = f.id + '|' + (f.path || ''); c[k] = (c[k] || 0) + 1; }); return c; }
    var cb = cnt(before), ca = cnt(after), introduced = [];
    Object.keys(ca).forEach(function (k) { if ((ca[k] || 0) > (cb[k] || 0)) introduced.push({ id: k.split('|')[0], path: k.split('|').slice(1).join('|') }); });
    items.forEach(function (it) {
      var k = it.id + '|' + (it.path || '');
      it.remaining = ca[k] || 0; it.cleared = it.isNew ? !(ca['D004|'] > 0) : (it.remaining === 0);
      if (it.id === 'D004') it.cleared = !(ca['D004|']);
    });
    items.sort(function (a, b) { return SEV[b.sev] - SEV[a.sev] || (a.path || '').localeCompare(b.path || '') || (a.line || 0) - (b.line || 0); });
    var manualList = Object.keys(manual).map(function (k) { return manual[k]; }).sort(function (a, b) { return SEV[b.sev] - SEV[a.sev] || (a.id < b.id ? -1 : 1); });
    var rotate = []; items.concat(manualList).forEach(function (x) { if (ROTATE[x.id]) rotate.push(x); });

    var res = {
      version: VERSION, repo: (meta.owner || '') + '/' + (meta.repoName || ''), sha: meta.sha, ruleset: report.ruleset,
      score: report.score, band: report.band,
      projected: patchFiles.length ? { score: after.score, band: after.band, findings: after.findings.length, before: before.findings.length, capped: after.capped, caps: after.caps } : null,
      baselineOk: baselineOk, introduced: introduced,
      items: items, manual: manualList, signals: signals, infoCount: infos, rotate: rotate.length > 0, rotateList: rotate,
      patch: patchParts.join(''), patchFiles: patchFiles, overrides: overrides, secrets: env.secrets
    };
    res.display = { patch: redact(res.patch, env.secrets) };
    res.plan = renderPlan(res, report);
    return res;
  }

  function redact(s, secrets) {
    var out = String(s);
    (secrets || []).slice().sort(function (a, b) { return b.length - a.length; }).forEach(function (x) {
      if (x && x.length >= 6) out = out.split(x).join(x.slice(0, 4) + '••••');
    });
    return out;
  }

  /* ------------------------------------------------------------ markdown plan */
  function loc(x) {
    var label = clean(x.path || '(whole repo)', 120) + (x.line ? ':' + x.line : '');
    return x.url && /^https:\/\/github\.com\//.test(x.url) ? '[`' + label + '`](' + x.url + ')' : '`' + label + '`';
  }
  function renderPlan(res, report) {
    var L = [], sec = res.secrets, rd = function (s) { return keepLine(redact(s, sec), 160); };
    var name = clean(res.repo, 120), sha = clean(String(res.sha || '').slice(0, 7));
    L.push('# Rescue plan' + (res.repo && res.repo !== '/' ? ' for ' + name : ''));
    L.push('');
    L.push((sha ? 'Commit `' + sha + '` · ' : '') + 'ruleset `' + clean(res.ruleset.id) + ' ' + clean(res.ruleset.version) + '` · actual Pushy Score **' + res.score + '/100** (unchanged by Rescue).');
    if (res.projected && res.baselineOk) L.push('Projected score if the patch is applied: **' + res.projected.score + '/100**. This is a what-if from re-running the same scan on the patched files. It is not a score. It counts every edit as done, including the ones marked "You still need to", and assumes leaked secrets are rotated.');
    else L.push('No projected score: ' + (res.projected ? 'the re-scan did not reproduce the original result.' : 'nothing here can be patched mechanically.'));
    L.push('');
    L.push('> Suggested edits are generated by rules, not reviewed by a person, and not guaranteed safe. Read every hunk and run your tests. Automated scan, not an audit.');
    if (res.introduced.length) { L.push(''); L.push('**Heads up:** the patch makes the scan flag ' + res.introduced.map(function (x) { return '`' + clean(x.id) + '`' + (x.path ? ' in `' + clean(x.path) + '`' : ''); }).join(', ') + ' where it did not before. Review those hunks.'); }
    var step = 1;
    if (res.rotate) {
      L.push(''); L.push('## ' + (step++) + '. Rotate leaked secrets first');
      L.push('Deleting a secret from the current files does not remove it from git history or from anyone who cloned the repo. Revoke or rotate each credential at its provider before anything else.');
      var seen = {}; res.rotateList.forEach(function (x) { var k = x.id; if (seen[k]) return; seen[k] = 1; L.push('- `' + clean(x.id) + '` ' + flat(x.title)); });
    }
    if (res.patchFiles.length) {
      L.push(''); L.push('## ' + (step++) + '. Apply the patch');
      L.push('Save the `.patch` file in the repo root, then run `git apply --check pushy-rescue.patch && git apply pushy-rescue.patch`, read `git diff`, and commit. It changes ' + res.patchFiles.length + ' file' + (res.patchFiles.length === 1 ? '' : 's') + ': ' + res.patchFiles.map(function (p) { return '`' + clean(p, 100) + '`'; }).join(', ') + '.');
      L.push('The patch file itself contains the old lines, including any secret that was removed. Do not post it publicly.');
      L.push('');
      L.push('| Rule | Where | What changes | Re-scan |');
      L.push('| --- | --- | --- | --- |');
      res.items.forEach(function (it) {
        var re = it.cleared ? 'cleared' : (it.remaining + ' still flagged');
        L.push('| `' + clean(it.id) + '` ' + clean(it.sev) + ' | ' + loc(it) + ' | ' + flat(it.explain, 220).replace(/\|/g, '\\|') + (it.needsInput ? ' **You still need to:** ' + flat(it.needsInput, 160).replace(/\|/g, '\\|') : '') + ' | ' + re + ' |');
      });
      var shown = res.items.filter(function (it) { return it.before.length && !it.whole; }).slice(0, 12);
      if (shown.length) {
        L.push(''); L.push('<details><summary>Line-by-line preview (secrets masked)</summary>'); L.push('');
        shown.forEach(function (it) {
          var body = it.before.map(function (l) { return '- ' + rd(l); }).concat(it.after.map(function (l) { return '+ ' + rd(l); })).join('\n'), fn = fenceFor(body);
          L.push(loc(it)); L.push(fn + 'diff'); L.push(body); L.push(fn); L.push('');
        });
        L.push('</details>');
      }
    }
    if (res.manual.length) {
      L.push(''); L.push('## ' + (step++) + '. Do these by hand');
      res.manual.forEach(function (g) {
        L.push(''); L.push('### `' + clean(g.id) + '` ' + clean(g.sev) + ': ' + flat(g.title));
        if (g.why) L.push(flat(g.why, 300));
        g.steps.forEach(function (s) { L.push('- [ ] ' + flat(s, 400)); });
        if (g.note) L.push('- ' + flat(g.note));
        var ls = g.locations.filter(function (x) { return x.path; }).slice(0, 8);
        if (ls.length) L.push('Where: ' + ls.map(loc).join(', ') + (g.locations.length > ls.length ? ' and ' + (g.locations.length - ls.length) + ' more' : ''));
      });
    }
    if (res.signals.length) {
      L.push(''); L.push('## ' + (step++) + '. Signals a patch cannot change');
      res.signals.forEach(function (f) { L.push('- `' + clean(f.id) + '` ' + flat(f.title) + (f.snippet ? ': ' + clean(f.snippet, 140) : '') + (f.fix ? '. ' + flat(f.fix, 200) : '')); });
    }
    L.push('');
    L.push('_Made with [Pushy Rescue](https://forcepushcoin.github.io/rescue/): free, client-side, rule-based. The score above came from [Pushy Score](https://forcepushcoin.github.io/score/) and was not changed._');
    return L.join('\n') + '\n';
  }

  var api = { VERSION: VERSION, flat: flat, build: build, unifiedDiff: unifiedDiff, FileEdit: FileEdit, redact: redact, renderPlan: renderPlan, manualSteps: manualSteps, clean: clean, GEN: GEN };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.PushyRescue = api;
})(typeof window !== 'undefined' ? window : globalThis);
