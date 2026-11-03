/*!
 * Pushy Score engine — client-side GitHub repo scanner.
 * Automated scan, not an audit or guarantee. Rules live in rules.js.
 * Works in browsers (GitHub Pages) and Node 18+ (for tests). No dependencies, no backend.
 */
(function (root) {
  'use strict';
  var R = root.PUSHY_RULES || (typeof require === 'function' ? require('./rules.js') : null);
  if (!R) throw new Error('rules.js must be loaded before pushy.js');

  var SEV_ORDER = { critical: 4, high: 3, medium: 2, low: 1, info: 0 };
  var SEV_DOWN = { critical: 'high', high: 'medium', medium: 'low', low: 'low', info: 'info' };

  function PushyError(code, message, extra) {
    var e = new Error(message); e.name = 'PushyError'; e.code = code;
    if (extra) for (var k in extra) e[k] = extra[k];
    return e;
  }

  /* ---------------------------------------------------------- input parsing */
  function parseInput(str) {
    if (!str) return null;
    var s = String(str).trim().replace(/^<|>$/g, '');
    s = s.replace(/^git@github\.com:/i, 'github.com/').replace(/^(?:https?:\/\/)?(?:www\.)?github\.com\//i, '');
    s = s.replace(/[?#].*$/, '').replace(/\/+$/, '').replace(/\.git$/i, '');
    var parts = s.split('/').filter(Boolean);
    if (parts.length < 2) return null;
    var owner = parts[0], repo = parts[1];
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(owner) || !/^[A-Za-z0-9._-]{1,100}$/.test(repo) || repo === '.' || repo === '..') return null;
    var out = { owner: owner, repo: repo, refSegments: [], subpath: '' };
    if ((parts[2] === 'tree' || parts[2] === 'blob') && parts.length > 3) {
      var rest = parts.slice(3).map(decodeURIComponent);
      out.refSegments = rest; // resolved later (branch names may contain slashes)
      out.isBlob = parts[2] === 'blob';
    }
    return out;
  }

  /* ---------------------------------------------------------- GitHub API */
  function makeApi(opts) {
    var f = opts.fetch || root.fetch.bind(root), token = opts.token;
    var rate = { limit: null, remaining: null, reset: null, used: 0 };
    async function gh(path) {
      var headers = { 'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
      if (token) headers['Authorization'] = 'Bearer ' + token;
      var res;
      try { res = await f('https://api.github.com' + path, { headers: headers }); }
      catch (e) { throw PushyError('NETWORK', 'Could not reach api.github.com. Check your connection (or an ad-blocker) and try again.'); }
      var lim = res.headers.get('x-ratelimit-limit'), rem = res.headers.get('x-ratelimit-remaining'), rst = res.headers.get('x-ratelimit-reset');
      if (lim) rate.limit = +lim; if (rem) rate.remaining = +rem; if (rst) rate.reset = +rst; rate.used++;
      if (res.ok) return res.json();
      var body = {}; try { body = await res.json(); } catch (e) {}
      var msg = (body && body.message) || '';
      if ((res.status === 403 || res.status === 429) && (rate.remaining === 0 || /rate limit|abuse|secondary/i.test(msg)))
        throw PushyError('RATE_LIMIT', 'GitHub\'s anonymous API limit (60 requests/hour per IP) is used up.', { reset: rate.reset ? rate.reset * 1000 : null, retryAfter: +res.headers.get('retry-after') || null });
      if (res.status === 404) throw PushyError('NOT_FOUND', 'No public repository found there. It may be private, renamed, or misspelled.');
      if (res.status === 409) throw PushyError('EMPTY', 'That repository is empty, so there is nothing to scan.');
      if (res.status === 451) throw PushyError('UNAVAILABLE', 'GitHub says this repository is unavailable for legal reasons.');
      if (res.status === 401) throw PushyError('BAD_TOKEN', 'GitHub rejected that token. Clear it or paste a fresh one.');
      throw PushyError('HTTP', 'GitHub returned ' + res.status + (msg ? ' (' + msg + ')' : '') + '.');
    }
    return { gh: gh, rate: rate };
  }

  /* ---------------------------------------------------------- classification */
  var CORE_INSTR = /(^|\/)(SKILL\.md|AGENTS\.md|CLAUDE\.md|GEMINI\.md|\.cursorrules|\.windsurfrules|\.clinerules|copilot-instructions\.md|[^/]+\.prompt\.md|[^/]+\.mdc)$/i;
  var MANIFEST = /(^|\/)(\.?mcp[^/]*\.json|server\.json|manifest\.json|claude_desktop_config\.json|smithery\.ya?ml|\.claude-plugin\/[^/]+\.json|\.claude\/settings(\.local)?\.json|\.vscode\/tasks\.json|\.cursor\/(mcp|hooks)\.json)$/i;

  function classify(path, size) {
    var name = path.split('/').pop(), dot = name.lastIndexOf('.');
    var ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : (dot === 0 ? name.slice(1).toLowerCase() : '');
    var F = R.FILES, kind = 'other';
    if (F.skipDirs.test(path)) kind = 'vendored';
    else if (F.lockFiles.test(path)) kind = 'lock';
    else if (/\.min\.(js|css)$|\.map$/i.test(name)) kind = 'minified';
    else if (F.licenseName.test(name)) kind = 'license';
    else if (dot > 0 && F.binaryExt.indexOf(ext) >= 0) kind = 'binary';
    else if (dot > 0 && F.archiveExt.indexOf(ext) >= 0) kind = 'archive';
    else if (dot > 0 && F.imageExt.indexOf(ext) >= 0) kind = 'image';
    else if (/^(Dockerfile|Makefile|Containerfile|Justfile)$/i.test(name)) kind = 'code';
    else if (/^\.(cursorrules|windsurfrules|clinerules)$/i.test(name) || CORE_INSTR.test(path)) kind = 'instr';
    else if (/^\.env(\.|$)/i.test(name)) kind = 'config';
    else if (dot > 0 && F.instrExt.indexOf(ext) >= 0) kind = 'instr';
    else if (dot > 0 && F.codeExt.indexOf(ext) >= 0) kind = 'code';
    else if (dot > 0 && F.configExt.indexOf(ext) >= 0) kind = 'config';
    else if (/^(README|LICENSE|LICENCE|NOTICE|COPYING|SECURITY|CONTRIBUTING|CHANGELOG)$/i.test(name)) kind = 'instr';
    return { path: path, name: name, ext: ext, kind: kind, size: size || 0 };
  }
  var TEXT_KINDS = { instr: 1, code: 1, config: 1 };

  function priority(e, skillDirs) {
    var p = e.path, n = e.name;
    if (/(^|\/)SKILL\.md$/i.test(p) || CORE_INSTR.test(p) || MANIFEST.test(p) || /(^|\/)\.cursor\/rules\//i.test(p)) return 0;
    for (var i = 0; i < skillDirs.length; i++) if (p.indexOf(skillDirs[i]) === 0 && skillDirs[i] !== '') return e.kind === 'code' ? 1 : 2;
    if (/^(package\.json|pyproject\.toml|requirements[^/]*\.txt|Dockerfile|README(\.[a-z]+)?)$/i.test(n) && e.depth <= 1) return 1;
    if (/^(sh|bash|ps1|bat|cmd|zsh)$/.test(e.ext)) return 1;
    if (/(^|\/)\.env(\.|$)/.test(p)) return 1;
    if (/(^|\/)(prompts?|commands?|agents?|hooks?|rules)\//i.test(p) && /^(md|txt|prompt|json|ya?ml)$/.test(e.ext)) return 2;
    if (/(^|\/)\.github\/workflows\//i.test(p) || /^SECURITY\.md$/i.test(n)) return 2;
    if (/^(index|main|server|app|cli|__main__|mcp|tools?)\.(py|js|mjs|ts|tsx)$/i.test(n) || /(^|\/)(src|lib|server)\//i.test(p) && e.kind === 'code' && e.depth <= 2) return 2;
    if (e.kind === 'code') return 3;
    if (e.kind === 'instr' && e.depth <= 2) return 3;
    if (e.kind === 'config') return 3;
    return 4;
  }

  /* ---------------------------------------------------------- helpers */
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function encPath(p) { return p.split('/').map(encodeURIComponent).join('/'); }
  function isoDay(d) { return new Date(d).toISOString().slice(0, 10); }
  function makeSnippet(line, idx, len, redact) {
    var s = line;
    if (redact && idx >= 0) { var m = s.substr(idx, len); s = s.slice(0, idx) + m.slice(0, 4) + '••••••(' + m.length + ' chars)' + s.slice(idx + len); idx = idx; }
    s = s.replace(/\t/g, ' ');
    var max = 200;
    if (s.length > max) { var st = Math.max(0, (idx || 0) - 60); s = (st > 0 ? '…' : '') + s.slice(st, st + max) + '…'; }
    return s.trim();
  }
  var BENIGN_HOSTS = /(^|\.)(w3\.org|json-schema\.org|schemastore\.org|example\.(com|org|net)|localhost|shields\.io|creativecommons\.org|opensource\.org|apache\.org|gnu\.org|xmlsoft\.org|ietf\.org|mozilla\.org|wikipedia\.org|iana\.org|tc39\.es|ecma-international\.org|purl\.org|openxmlformats\.org|microsoft\.com\/office)$/i;
  function collectHosts(text, into) {
    var re = /\bhttps?:\/\/([A-Za-z0-9][A-Za-z0-9.-]*\.[A-Za-z]{2,})(?::\d+)?/g, m;
    while ((m = re.exec(text))) { var h = m[1].toLowerCase(); if (!BENIGN_HOSTS.test(h)) into[h] = (into[h] || 0) + 1; }
  }

  /* ---------------------------------------------------------- analysis */
  function fileContext(path, name) {
    var core = CORE_INSTR.test(path);
    var docs = !core && (R.FILES.exampleDirs.test(path) || /^(readme|changelog|contributing|code_of_conduct)/i.test(name));
    return { core: core, docs: docs, tests: !core && /(^|\/)(tests?|__tests__|spec|fixtures?|testdata)\/|\.(test|spec)\.[a-z]+$/i.test(path) };
  }

  function analyzeFile(file) {
    var out = [], text = file.text, lines = text.split(/\r\n|\n|\r/), fc = fileContext(file.path, file.entry.name);
    function push(rule, hit, extra) {
      var sev = hit.sev || rule.sev, base = sev, note = null;
      if (fc.docs && (rule.cat === 'prompt' || rule.cat === 'code') && !hit.noEscapeCtx) { sev = SEV_DOWN[sev]; if (sev !== base) note = 'docs / test / example path: severity lowered one level'; }
      if (fc.tests && rule.cat === 'code' && !hit.noEscapeCtx && /^X/.test(rule.id)) { var s2 = SEV_DOWN[sev]; if (s2 !== sev) { sev = s2; note = 'test path: severity lowered two levels'; } }
      out.push({ id: rule.id, cat: rule.cat, sev: sev, baseSev: base, title: rule.title, why: rule.why, fix: rule.fix,
        path: file.path, line: hit.line, snippet: hit.snippet || '', note: note });
    }
    function counts() { return {}; }
    var per = counts();
    function capOK(rule) { per[rule.id] = (per[rule.id] || 0) + 1; if (per[rule.id] > R.LIMITS.maxFindingsPerRulePerFile) { per[rule.id + ':more'] = (per[rule.id + ':more'] || 0) + 1; return false; } return true; }

    R.lineRules.forEach(function (rule) {
      if (rule.kinds.indexOf(file.kind) < 0) return;
      if (rule.exts && rule.exts.indexOf(file.entry.ext) < 0) return;
      var seen = {};
      if (rule.re) {
        for (var i = 0; i < lines.length; i++) {
          var l = lines[i]; if (!l || l.length < 6) continue;
          var m = rule.re.exec(l);
          if (!m) continue;
          if ((rule.cat === 'code' || rule.cat === 'network') && (file.kind === 'code' || file.kind === 'config') && /^\s*(?:#|\/\/|\*|\/\*|--)/.test(l)) continue;
          if (rule.filter && !rule.filter(m, l, { path: file.path })) continue;
          if (!capOK(rule)) continue;
          var ri = m.index, rl = m[0].length;
          if (rule.redact && m[1]) { ri = m.index + m[0].lastIndexOf(m[1]); rl = m[1].length; }
          push(rule, { line: i + 1, snippet: makeSnippet(l, ri, rl, rule.redact) });
        }
      } else if (rule.all) {
        for (var j = 0; j < lines.length; j++) {
          if (!lines[j] || !rule.all[0].test(lines[j])) continue;
          var win = lines.slice(j, j + 1 + (rule.within || 3)).join('\n');
          if (!rule.all[1].test(win)) continue;
          if (rule.all[0].test(lines[j]) && /^\s*(?:#|\/\/|\*|<!--)/.test(lines[j]) && file.kind === 'code') continue;
          if (seen[j]) continue; for (var q = j; q <= j + 2; q++) seen[q] = 1;
          if (!capOK(rule)) continue;
          push(rule, { line: j + 1, snippet: makeSnippet(lines[j], 0, 0, false) });
        }
      }
    });
    R.specialRules.forEach(function (rule) {
      if (rule.kinds.indexOf(file.kind) < 0) return;
      var hits = []; try { hits = rule.run(file) || []; } catch (e) { hits = []; }
      hits.forEach(function (h) { if (capOK(rule)) push(rule, h); });
    });
    R.fileRules.forEach(function (rule) {
      var ok = false; try { ok = rule.match(file.path, file.text); } catch (e) {}
      if (!ok) return;
      var hits = []; try { hits = rule.run(file, {}) || []; } catch (e) { hits = []; }
      hits.forEach(function (h) { push(rule, h); });
    });
    return out;
  }

  /* ---------------------------------------------------------- scoring */
  function scoreFindings(findings, caps) {
    var S = R.SCORING, sub = {}, byRule = {};
    Object.keys(R.CATEGORIES).forEach(function (c) { sub[c] = { score: 100, penalty: 0, count: 0, counts: { critical: 0, high: 0, medium: 0, low: 0, info: 0 } }; });
    findings.forEach(function (f) { var k = f.cat + '|' + f.id; (byRule[k] = byRule[k] || []).push(f); sub[f.cat].count++; sub[f.cat].counts[f.sev]++; });
    Object.keys(byRule).forEach(function (k) {
      var fs = byRule[k].slice().sort(function (a, b) { return SEV_ORDER[b.sev] - SEV_ORDER[a.sev]; });
      var maxBase = S.penalty[fs[0].sev], total = 0;
      fs.forEach(function (f, i) { total += S.penalty[f.sev] * S.repeat[Math.min(i, S.repeat.length - 1)]; });
      total = Math.min(total, maxBase * S.maxRuleMultiplier);
      sub[fs[0].cat].penalty += total;
    });
    var raw = 0;
    Object.keys(sub).forEach(function (c) { sub[c].score = Math.max(0, Math.round(100 - sub[c].penalty)); raw += sub[c].score * S.weights[c]; });
    raw = Math.round(raw);
    var counts = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
    findings.forEach(function (f) { counts[f.sev]++; });
    var applied = [], score = raw;
    function cap(value, reason) { if (value < score) { score = value; } applied.push({ value: value, reason: reason }); }
    if (counts.critical) cap(S.caps.anyCritical, counts.critical + ' critical finding' + (counts.critical > 1 ? 's' : '') + ' (a critical hit caps the score at ' + S.caps.anyCritical + ')');
    if (counts.high >= 3) cap(S.caps.threeOrMoreHigh, counts.high + ' high-severity findings (3+ caps the score at ' + S.caps.threeOrMoreHigh + ')');
    else if (counts.high >= 1) cap(S.caps.anyHigh, 'a high-severity finding (caps the score at ' + S.caps.anyHigh + ')');
    (caps || []).forEach(function (c) { cap(c.value, c.reason); });
    applied.sort(function (a, b) { return a.value - b.value; });
    return { raw: raw, score: Math.max(0, Math.min(100, score)), capped: score < raw, caps: applied, sub: sub, counts: counts };
  }
  function bandFor(score) { var b = R.SCORING.bands; for (var i = 0; i < b.length; i++) if (score >= b[i].min) return b[i]; return b[b.length - 1]; }

  /* ---------------------------------------------------------- main scan */
  async function scan(input, opts) {
    opts = opts || {};
    var log = opts.onProgress || function () {};
    var now = opts.now || Date.now();
    var api = makeApi(opts), gh = api.gh, ff = opts.fetch || root.fetch.bind(root);
    var parsed = typeof input === 'string' ? parseInput(input) : input;
    if (!parsed) throw PushyError('BAD_INPUT', 'That does not look like a GitHub repo. Try https://github.com/owner/repo or owner/repo.');
    var o = parsed.owner, r = parsed.repo, base = '/repos/' + encodeURIComponent(o) + '/' + encodeURIComponent(r);

    log('Fetching repo metadata…');
    var repo = await gh(base);
    o = (repo.owner && repo.owner.login) || parsed.owner; r = repo.name || parsed.repo; base = '/repos/' + o + '/' + r;
    if (repo.private) throw PushyError('NOT_FOUND', 'That repository is private. Pushy only scans public repos.');

    // resolve ref + subpath
    var ref = repo.default_branch, subpath = '', commitsRaw = null, segs = parsed.refSegments || [];
    if (segs.length) {
      var tryMax = Math.min(segs.length, 4), ok = false;
      for (var k = 1; k <= tryMax && !ok; k++) {
        var cand = segs.slice(0, k).join('/');
        try { commitsRaw = await gh(base + '/commits?sha=' + encodeURIComponent(cand) + '&per_page=30'); ref = cand; subpath = segs.slice(k).join('/'); ok = true; }
        catch (e) { if (e.code !== 'NOT_FOUND' && e.code !== 'HTTP') throw e; }
      }
      if (!ok) throw PushyError('NOT_FOUND', 'Could not find that branch or tag in the URL. Try the plain repo URL.');
      if (parsed.isBlob && subpath) subpath = subpath.split('/').slice(0, -1).join('/');
    }
    log('Reading latest commits on ' + ref + '…');
    if (!commitsRaw) commitsRaw = await gh(base + '/commits?sha=' + encodeURIComponent(ref) + '&per_page=30');
    if (!commitsRaw.length) throw PushyError('EMPTY', 'That repository has no commits to scan.');
    var head = commitsRaw[0], sha = head.sha;
    var commits = commitsRaw.map(function (c) { return { sha: c.sha, date: (c.commit.committer && c.commit.committer.date) || (c.commit.author && c.commit.author.date), author: (c.author && c.author.login) || (c.commit.author && c.commit.author.name) || '?' }; });
    var authors = []; commits.forEach(function (c) { if (authors.indexOf(c.author) < 0) authors.push(c.author); });

    log('Listing files at ' + sha.slice(0, 7) + '…');
    var treeRes = await gh(base + '/git/trees/' + sha + '?recursive=1');
    var tree = treeRes.tree || [], truncated = !!treeRes.truncated, treeNote = '';
    if (truncated && subpath) {
      log('Tree truncated — walking down to ' + subpath + '…');
      try {
        var cur = head.commit.tree.sha, segs2 = subpath.split('/');
        for (var si = 0; si < segs2.length; si++) {
          var lvl = await gh(base + '/git/trees/' + cur);
          var hit = (lvl.tree || []).filter(function (t) { return t.type === 'tree' && t.path === segs2[si]; })[0];
          if (!hit) throw new Error('missing');
          cur = hit.sha;
        }
        var sub = await gh(base + '/git/trees/' + cur + '?recursive=1');
        tree = (sub.tree || []).map(function (t) { return { path: subpath + '/' + t.path, type: t.type, size: t.size, sha: t.sha }; });
        truncated = !!sub.truncated; treeNote = 'sub-folder tree fetched separately';
      } catch (e) { if (e.code === 'RATE_LIMIT') throw e; treeNote = 'could not narrow to sub-folder'; }
    }

    // entries
    var prefix = subpath ? subpath + '/' : '';
    var entries = [];
    tree.forEach(function (t) {
      if (t.type !== 'blob') return;
      if (prefix && t.path.indexOf(prefix) !== 0) return;
      var e = classify(t.path, t.size); e.depth = t.path.slice(prefix.length).split('/').length - 1; e.sha = t.sha; entries.push(e);
    });
    if (!entries.length) throw PushyError('EMPTY', subpath ? 'No files found in that folder.' : 'No files found in that repository.');
    var scopeRoot = !subpath;

    // choose files
    var skillDirs = entries.filter(function (e) { return /(^|\/)SKILL\.md$/i.test(e.path); }).map(function (e) { return e.path.replace(/SKILL\.md$/i, ''); });
    var cands = entries.filter(function (e) { return TEXT_KINDS[e.kind] && e.size > 0; });
    cands.forEach(function (e) { e.prio = priority(e, skillDirs); });
    cands.sort(function (a, b) { return a.prio - b.prio || a.depth - b.depth || (a.path < b.path ? -1 : 1); });
    var picked = [], skipped = [];
    cands.forEach(function (e) {
      if (e.size > R.LIMITS.maxFileBytes) skipped.push({ path: e.path, reason: 'too large (' + Math.round(e.size / 1024) + ' KB > ' + (R.LIMITS.maxFileBytes / 1024) + ' KB)', counts: true });
      else if (picked.length >= R.LIMITS.maxFiles) skipped.push({ path: e.path, reason: 'over the ' + R.LIMITS.maxFiles + '-file limit', counts: true });
      else picked.push(e);
    });
    var relevantTotal = cands.length;

    // path rules + non-fetched kinds
    var findings = [];
    entries.forEach(function (e) {
      R.pathRules.forEach(function (rule) {
        if (rule.test(e)) findings.push({ id: rule.id, cat: rule.cat, sev: rule.sev, baseSev: rule.sev, title: rule.title, why: rule.why, fix: rule.fix, path: e.path, line: null, snippet: (e.kind === 'binary' || e.kind === 'archive' ? e.size.toLocaleString('en-US') + ' bytes, not analyzed' : ''), note: null });
      });
      if (e.kind === 'binary' || e.kind === 'archive') skipped.push({ path: e.path, reason: e.kind === 'binary' ? 'binary / bytecode (not opened)' : 'archive / document (not opened)', counts: false, binary: true });
    });
    var skippedOther = { image: 0, vendored: 0, lock: 0, minified: 0, license: 0, other: 0 };
    entries.forEach(function (e) { if (skippedOther[e.kind] !== undefined && e.size > 0) skippedOther[e.kind]++; });

    // fetch bodies
    log('Reading ' + picked.length + ' file' + (picked.length === 1 ? '' : 's') + ' (pinned to ' + sha.slice(0, 7) + ')…');
    var analyzed = [], hostsAll = {}, hostsCode = {}, done = 0;
    async function fetchText(e) {
      var urls = ['https://cdn.jsdelivr.net/gh/' + o + '/' + r + '@' + sha + '/' + encPath(e.path), 'https://raw.githubusercontent.com/' + o + '/' + r + '/' + sha + '/' + encPath(e.path)];
      var lastErr = null;
      for (var u = 0; u < urls.length; u++) {
        for (var attempt = 0; attempt < 2; attempt++) {
          var ctl = typeof AbortController !== 'undefined' ? new AbortController() : null, to = ctl && setTimeout(function () { ctl.abort(); }, 20000);
          try {
            var res = await ff(urls[u], ctl ? { signal: ctl.signal } : {});
            if (to) clearTimeout(to);
            if (res.ok) return await res.text();
            lastErr = 'HTTP ' + res.status;
            if (res.status === 404) break;
          } catch (err) { if (to) clearTimeout(to); lastErr = 'network error'; }
          await sleep(250);
        }
      }
      throw new Error(lastErr || 'failed');
    }
    var queue = picked.slice(), results = {};
    async function worker() {
      while (queue.length) {
        var e = queue.shift();
        try { results[e.path] = { text: await fetchText(e), entry: e }; }
        catch (err) { results[e.path] = { error: err.message, entry: e }; }
        done++; if (opts.onFile) opts.onFile(done, picked.length, e.path);
      }
    }
    var workers = []; for (var w = 0; w < R.LIMITS.fetchConcurrency; w++) workers.push(worker());
    await Promise.all(workers);

    log('Running ' + (R.lineRules.length + R.specialRules.length + R.fileRules.length + R.pathRules.length + R.repoRules.length) + ' rules…');
    var readmeText = '', readmePath = '', skillFm = {};
    picked.forEach(function (e) {
      var res = results[e.path];
      if (!res || res.error) { skipped.push({ path: e.path, reason: 'could not be downloaded (' + (res ? res.error : 'unknown') + ')', counts: true }); return; }
      var text = res.text;
      if (text.indexOf('\u0000') >= 0) { skipped.push({ path: e.path, reason: 'contains binary data', counts: true }); return; }
      if (text.length > R.LIMITS.maxFileBytes * 2) { skipped.push({ path: e.path, reason: 'too large after download', counts: true }); return; }
      var f = { path: e.path, text: text, kind: e.kind, entry: e };
      analyzed.push({ path: e.path, bytes: text.length, kind: e.kind, prio: e.prio });
      if (/^readme(\.[a-z]+)?$/i.test(e.name) && e.depth === 0) { readmeText = text; readmePath = e.path; }
      if (/(^|\/)SKILL\.md$/i.test(e.path)) skillFm[e.path] = R.helpers.frontmatter(text);
      findings = findings.concat(analyzeFile(f));
      if (e.kind === 'code' || e.kind === 'config' || /SKILL\.md$/i.test(e.path)) collectHosts(text, hostsAll);
      if (e.kind === 'code') collectHosts(text, hostsCode);
    });
    var hostList = Object.keys(hostsAll).sort(function (a, b) { return hostsAll[b] - hostsAll[a]; });
    var codeHostList = Object.keys(hostsCode);

    // repo-level rules
    var rctx = { repo: repo, commits: commits, authors: authors, entries: entries, readme: readmeText, readmePath: readmePath, now: now,
      hosts: hostList, codeHosts: codeHostList, scopeRoot: scopeRoot, skillDirs: skillDirs.map(function (d) { return { dir: d, skillPath: d + 'SKILL.md' }; }), skillFm: skillFm };
    R.repoRules.forEach(function (rule) {
      var hs = []; try { hs = rule.run(rctx) || []; } catch (e) { hs = []; }
      hs.forEach(function (h) { findings.push({ id: rule.id, cat: rule.cat, sev: h.sev || rule.sev, baseSev: h.sev || rule.sev, title: rule.title, why: rule.why, fix: rule.fix, path: h.path || null, line: h.line || null, snippet: h.snippet || '', note: null }); });
    });

    // dedupe + sort
    var seenKey = {}; findings = findings.filter(function (f) { var k = f.id + '|' + f.path + '|' + f.line + '|' + f.snippet; if (seenKey[k]) return false; seenKey[k] = 1; return true; });
    findings.sort(function (a, b) { return SEV_ORDER[b.sev] - SEV_ORDER[a.sev] || (a.cat < b.cat ? -1 : 1) || (a.path || '') .localeCompare(b.path || '') || (a.line || 0) - (b.line || 0); });
    findings.forEach(function (f) { f.url = f.path ? 'https://github.com/' + o + '/' + r + '/blob/' + sha + '/' + encPath(f.path) + (f.line ? '#L' + f.line : '') : null; });

    // coverage caps
    var C = R.SCORING.caps, capList = [];
    var skipCount = skipped.filter(function (s) { return s.counts; }).length, ratio = relevantTotal ? skipCount / relevantTotal : 0;
    if (truncated) capList.push({ value: C.treeTruncated, reason: 'GitHub truncated the file tree, so some files were never listed' });
    if (ratio > 0.5) capList.push({ value: C.skippedOver50pct, reason: skipCount + ' of ' + relevantTotal + ' scannable files were NOT analyzed (' + Math.round(ratio * 100) + '%)' });
    else if (ratio > 0.2) capList.push({ value: C.skippedOver20pct, reason: skipCount + ' of ' + relevantTotal + ' scannable files were NOT analyzed (' + Math.round(ratio * 100) + '%)' });
    else if (skipCount > 0) capList.push({ value: C.skippedSome, reason: skipCount + ' scannable file' + (skipCount > 1 ? 's were' : ' was') + ' NOT analyzed' });
    var binCount = skipped.filter(function (s) { return s.binary; }).length;
    if (binCount) capList.push({ value: C.binariesOrArchives, reason: binCount + ' binary / archive file' + (binCount > 1 ? 's' : '') + ' present that this scan cannot open' });
    var core = analyzed.filter(function (a) { return !/(^|\/)(README|LICENSE|LICENCE|NOTICE|CONTRIBUTING|CHANGELOG|SECURITY)(\.[a-z]+)?$/i.test(a.path); });
    var nothing = core.length === 0;
    if (nothing) capList.push({ value: C.nothingToScan, reason: 'there was almost nothing to scan (no skills, MCP config, scripts or code were analyzed)' });

    var sc = scoreFindings(findings, capList), band = bandFor(sc.score);
    if (nothing) band = { key: 'gray', label: 'Nothing to scan here 🤷', line: 'No skill files, MCP config or code were found, so the score only reflects docs and upkeep.' };

    return {
      ruleset: R.RULESET, scoredAt: now, scoreDay: isoDay(now),
      repo: { owner: o, name: r, url: repo.html_url, description: repo.description, stars: repo.stargazers_count, fork: repo.fork, archived: repo.archived, license: repo.license && repo.license.spdx_id, pushedAt: repo.pushed_at, createdAt: repo.created_at, defaultBranch: repo.default_branch },
      ref: ref, subpath: subpath, sha: sha, shortSha: sha.slice(0, 7), commitDate: commits[0].date,
      score: sc.score, rawScore: sc.raw, capped: sc.capped, caps: sc.caps, sub: sc.sub, counts: sc.counts, band: band,
      findings: findings,
      coverage: { relevantTotal: relevantTotal, analyzed: analyzed.length, skippedCounted: skipCount, treeTruncated: truncated, treeNote: treeNote, totalFiles: entries.length },
      analyzed: analyzed, skipped: skipped, skippedOther: skippedOther,
      hosts: hostList, greenFlags: greenFlags(entries, repo, scopeRoot),
      rate: { remaining: api.rate.remaining, limit: api.rate.limit, reset: api.rate.reset ? api.rate.reset * 1000 : null, used: api.rate.used },
      blindSpots: R.BLIND_SPOTS, disclaimer: 'Automated scan, not an audit or guarantee.'
    };
  }

  function greenFlags(entries, repo, scopeRoot) {
    var g = [], has = function (re, d) { return entries.some(function (e) { return re.test(e.name) && e.depth <= (d == null ? 1 : d); }); };
    if ((repo.license && repo.license.spdx_id && repo.license.spdx_id !== 'NOASSERTION') || has(/^licen[sc]e/i)) g.push('Has a license');
    if (has(/^security\.md$/i)) g.push('Has a SECURITY.md');
    if (entries.some(function (e) { return /(^|\/)\.github\/workflows\/.+\.ya?ml$/.test(e.path); })) g.push('Has CI workflows');
    if (entries.some(function (e) { return R.FILES.lockFiles.test(e.path); })) g.push('Commits a lockfile (reproducible installs)');
    if (entries.some(function (e) { return /(^|\/)(tests?|__tests__|spec)\//i.test(e.path); })) g.push('Has tests');
    if (entries.some(function (e) { return /(^|\/)(dependabot|renovate)\.(ya?ml|json)$/i.test(e.path); })) g.push('Automated dependency updates');
    if (entries.some(function (e) { return /^(\.github\/)?CODEOWNERS$/.test(e.path); })) g.push('Has CODEOWNERS');
    return g;
  }

  /* ---------------------------------------------------------- badge */
  var BAND_COLORS = { green: '#2fbf71', yellow: '#e6b422', orange: '#f08a24', red: '#e02424', gray: '#7c8aa8' };
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function plainLabel(label) { return label.replace(/[^\x20-\x7E]/g, '').replace(/\s+/g, ' ').trim(); }
  function badgeSVG(rep) {
    var col = BAND_COLORS[rep.band.key] || BAND_COLORS.gray, label = plainLabel(rep.band.label);
    var repoName = rep.repo.owner + '/' + rep.repo.name + (rep.subpath ? '/' + rep.subpath : '');
    if (repoName.length > 34) repoName = repoName.slice(0, 33) + '…';
    var a11y = 'Pushy Score ' + rep.score + '/100, ' + label + ', commit ' + rep.shortSha + ', ' + rep.scoreDay + ', ruleset v' + rep.ruleset.version + '. Automated scan, not an audit or guarantee.';
    return '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="76" viewBox="0 0 400 76" role="img" aria-label="' + esc(a11y) + '">' +
      '<title>' + esc(a11y) + '</title>' +
      '<defs><clipPath id="c"><rect width="400" height="76" rx="12"/></clipPath></defs>' +
      '<g clip-path="url(#c)">' +
      '<rect width="400" height="76" fill="#0b1a3a"/>' +
      '<rect width="104" height="76" fill="' + col + '"/>' +
      '<rect x="104" width="3" height="76" fill="#e02424"/>' +
      '</g><rect x="1" y="1" width="398" height="74" rx="11" fill="none" stroke="#22366b" stroke-width="2"/>' +
      '<g font-family="ui-monospace,SFMono-Regular,Menlo,Consolas,monospace" fill="#fff">' +
      '<text x="52" y="21" font-size="10" text-anchor="middle" fill="#0b1a3a" font-weight="700" letter-spacing="1">PUSHY SCORE</text>' +
      '<text x="52" y="53" font-size="32" text-anchor="middle" fill="#0b1a3a" font-weight="800">' + rep.score + '</text>' +
      '<text x="52" y="67" font-size="10" text-anchor="middle" fill="#0b1a3a" font-weight="700">/ 100</text>' +
      '<text x="120" y="22" font-size="14" font-weight="700">' + esc(label) + '</text>' +
      '<text x="120" y="39" font-size="10.5" fill="#9db0d8">' + esc(repoName) + '</text>' +
      '<text x="120" y="54" font-size="10.5" fill="#6ee7a0">commit ' + esc(rep.shortSha) + ' · ' + esc(rep.scoreDay) + '</text>' +
      '<text x="120" y="68" font-size="9.5" fill="#9db0d8">ruleset v' + esc(rep.ruleset.version) + ' · automated scan, not an audit</text>' +
      '</g></svg>';
  }
  function badgeMarkdown(rep, siteUrl, file) {
    file = file || 'pushy-score.svg';
    var img = '![Pushy Score ' + rep.score + '/100 (commit ' + rep.shortSha + ', ' + rep.scoreDay + ')](' + file + ')';
    return siteUrl ? '[' + img + '](' + siteUrl + ')' : img;
  }

  var api = { parseInput: parseInput, scan: scan, analyzeFile: analyzeFile, classify: classify, scoreFindings: scoreFindings, bandFor: bandFor, badgeSVG: badgeSVG, badgeMarkdown: badgeMarkdown, PushyError: PushyError, SEV_ORDER: SEV_ORDER, BAND_COLORS: BAND_COLORS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.Pushy = api;
})(typeof window !== 'undefined' ? window : globalThis);
