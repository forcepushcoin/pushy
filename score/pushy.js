/*!
 * Pushy Score engine — client-side GitHub repo scanner.
 * Automated scan, not an audit or guarantee. Rules live in rules.js.
 * Works in browsers (GitHub Pages) and Node 18+ (for tests and the GitHub Action).
 * No dependencies, no backend. `scan` fetches a public GitHub repo. `scanLocal` reads a directory on disk.
 * `keepContext: true` makes either one attach `report.context` (file texts) so `rescore(context, overrides)` can re-run the same engine on edited files (used by Pushy Rescue). It never changes a score.
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
    var prose = !core && /\.(md|mdx|rst|txt)$/i.test(path);
    return { core: core, docs: docs, prose: prose, tests: !core && /(^|\/)(tests?|__tests__|spec|fixtures?|testdata)\/|\.(test|spec)\.[a-z]+$/i.test(path) };
  }

  var NEG_PRE = /\b(?:never|don'?t|do\s+not|must\s+not|should\s+not|shouldn'?t|avoid|refuse|reject|beware|unsafe|dangerous|malicious|attacks?|injection|untrusted|not\s+to)\b/i;
  var DISCUSS = /\b(?:e\.g\.|for\s+example|such\s+as|examples?\s+of|phrases?\s+(?:like|such)|patterns?\s+(?:like|such)|looks?\s+like|trained\s+to|red\s+flags?|attack\s+(?:string|pattern|example))\b/i;
  /* Is the match quoted, negated or being discussed (docs about attacks) rather than instructing? */
  function defensiveContext(line, idx, len) {
    var pre = line.slice(Math.max(0, idx - 100), idx);
    var sb = Math.max(pre.lastIndexOf('. '), pre.lastIndexOf('; '), pre.lastIndexOf('! '), pre.lastIndexOf('? '), pre.lastIndexOf(': ')); // negation only counts inside the same sentence
    var sent = sb >= 0 ? pre.slice(sb + 2) : pre;
    if ((pre.match(/"/g) || []).length % 2 === 1 || (pre.match(/`/g) || []).length % 2 === 1 || pre.lastIndexOf('\u201c') > pre.lastIndexOf('\u201d')) return 'quoted';
    if (NEG_PRE.test(sent)) return 'negated';
    if (DISCUSS.test(line.slice(Math.max(0, idx - 100), idx + len + 60))) return 'discussed';
    return null;
  }

  function analyzeFile(file) {
    var out = [], text = file.text, lines = text.split(/\r\n|\n|\r/), fc = fileContext(file.path, file.entry.name);
    function push(rule, hit, extra) {
      var sev = hit.sev || rule.sev, base = sev, note = null;
      if (hit.defensive) { var lv = fc.core ? 1 : 2; for (var k = 0; k < lv; k++) sev = SEV_DOWN[sev]; if (sev !== base) note = hit.defensive + ' / discussion context: severity lowered' + (lv > 1 ? ' two levels' : ' one level'); }
      if (fc.docs && (rule.cat === 'prompt' || rule.cat === 'code') && !hit.noEscapeCtx) { sev = SEV_DOWN[sev]; if (sev !== base) note = 'docs / test / example path: severity lowered one level'; }
      if (fc.prose && !fc.docs && rule.cat === 'code' && /^[XN]/.test(rule.id) && !hit.noEscapeCtx) { var s1 = SEV_DOWN[sev]; if (s1 !== sev) { sev = s1; note = 'code sample in a markdown doc: severity lowered one level'; } }
      if (fc.tests && rule.cat === 'code' && !hit.noEscapeCtx && /^X/.test(rule.id)) { var s2 = SEV_DOWN[sev]; if (s2 !== sev) { sev = s2; note = 'test path: severity lowered two levels'; } }
      out.push({ id: rule.id, cat: rule.cat, sev: sev, baseSev: base, title: rule.title, why: rule.why, fix: rule.fix,
        path: file.path, line: hit.line, snippet: hit.snippet || '', note: note });
    }
    function counts() { return {}; }
    var per = counts();
    function capOK(rule) { per[rule.id] = (per[rule.id] || 0) + 1; if (per[rule.id] > R.LIMITS.maxFindingsPerRulePerFile) { per[rule.id + ':more'] = (per[rule.id + ':more'] || 0) + 1; return false; } return true; }

    var onceCount = {}, onceFirst = {};
    R.lineRules.forEach(function (rule) {
      if (rule.kinds.indexOf(file.kind) < 0) return;
      if (rule.exts && rule.exts.indexOf(file.entry.ext) < 0) return;
      var seen = {};
      if (rule.re) {
        for (var i = 0; i < lines.length; i++) {
          var l = lines[i]; if (!l || l.length < 6) continue;
          var m = rule.re.exec(l);
          if (!m) continue;
          if ((rule.cat === 'code' || rule.cat === 'network' || rule.cat === 'prompt') && (file.kind === 'code' || file.kind === 'config') && /^\s*(?:#|\/\/|\*|\/\*|--)/.test(l)) continue;
          if (rule.oncePerFile && onceCount[rule.id]) { onceCount[rule.id]++; if (onceFirst[rule.id]) onceFirst[rule.id].snippet = onceFirst[rule.id].snippet.replace(/ \(\+\d+ more in this file\)$/, '') + ' (+' + (onceCount[rule.id] - 1) + ' more in this file)'; continue; }
          if (rule.filter && !rule.filter(m, l, { path: file.path })) continue;
          if (!capOK(rule)) continue;
          var ri = m.index, rl = m[0].length;
          if (rule.redact && m[1]) { ri = m.index + m[0].lastIndexOf(m[1]); rl = m[1].length; }
          if (rule.oncePerFile) onceCount[rule.id] = 1;
          push(rule, { line: i + 1, snippet: makeSnippet(l, ri, rl, rule.redact), defensive: (rule.ctx && file.kind === 'instr') ? defensiveContext(l, m.index, m[0].length) : null });
          if (rule.oncePerFile) onceFirst[rule.id] = out[out.length - 1];
        }
      } else if (rule.all) {
        for (var j = 0; j < lines.length; j++) {
          if (!lines[j] || !rule.all[0].test(lines[j])) continue;
          var win = lines.slice(j, j + 1 + (rule.within || 3)).join('\n');
          if (!rule.all[1].test(win)) continue;
          if (rule.filter && !rule.filter(null, lines[j], { win: win, path: file.path })) continue;
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

  /* Shared by the GitHub scan and the local (Action) scan. Same budget, path rules, caps, and score. */
  function prepareEntries(entries) {
    var skillDirs = entries.filter(function (e) { return /(^|\/)SKILL\.md$/i.test(e.path); }).map(function (e) { return e.path.replace(/SKILL\.md$/i, ''); });
    var cands = entries.filter(function (e) { return TEXT_KINDS[e.kind] && e.size > 0; });
    cands.forEach(function (e) { e.prio = priority(e, skillDirs); });
    cands.sort(function (a, b) { return a.prio - b.prio || a.depth - b.depth || (a.path < b.path ? -1 : 1); });
    var picked = [], skipped = [], budgetBytes = 0, L = R.LIMITS;
    cands.forEach(function (e) {
      if (e.size > L.maxFileBytes) skipped.push({ path: e.path, reason: 'too large (' + Math.round(e.size / 1024) + ' KB > ' + (L.maxFileBytes / 1024) + ' KB per-file cap)', counts: true });
      else if (picked.length >= L.maxFiles) skipped.push({ path: e.path, reason: 'over the ' + L.maxFiles + '-file budget', counts: true });
      else if (budgetBytes + e.size > L.maxTotalBytes) skipped.push({ path: e.path, reason: 'over the ' + Math.round(L.maxTotalBytes / 1048576) + ' MB total download budget', counts: true });
      else { picked.push(e); budgetBytes += e.size; }
    });
    var findings = [];
    entries.forEach(function (e) {
      R.pathRules.forEach(function (rule) {
        if (rule.test(e)) findings.push({ id: rule.id, cat: rule.cat, sev: rule.sev, baseSev: rule.sev, title: rule.title, why: rule.why, fix: rule.fix, path: e.path, line: null, snippet: (e.kind === 'binary' || e.kind === 'archive' ? e.size.toLocaleString('en-US') + ' bytes, not analyzed' : ''), note: null });
      });
      if (e.kind === 'binary' || e.kind === 'archive') skipped.push({ path: e.path, reason: e.kind === 'binary' ? 'binary / bytecode (not opened)' : 'archive / document (not opened)', counts: false, binary: true });
    });
    var skippedOther = { image: 0, vendored: 0, lock: 0, minified: 0, license: 0, other: 0 };
    entries.forEach(function (e) { if (skippedOther[e.kind] !== undefined && e.size > 0) skippedOther[e.kind]++; });
    return { skillDirs: skillDirs, picked: picked, skipped: skipped, budgetBytes: budgetBytes, relevantTotal: cands.length, findings: findings, skippedOther: skippedOther };
  }

  function absorbFile(e, text, st) {
    if (text.indexOf('\u0000') >= 0) { st.skipped.push({ path: e.path, reason: 'contains binary data', counts: true }); return; }
    if (text.length > R.LIMITS.maxFileBytes * 2) { st.skipped.push({ path: e.path, reason: 'too large after download', counts: true }); return; }
    var f = { path: e.path, text: text, kind: e.kind, entry: e };
    if (st.texts) st.texts[e.path] = text;
    st.analyzed.push({ path: e.path, bytes: text.length, kind: e.kind, prio: e.prio });
    if (/^readme(\.[a-z]+)?$/i.test(e.name) && e.depth === 0) { st.readmeText = text; st.readmePath = e.path; }
    if (/(^|\/)SKILL\.md$/i.test(e.path)) st.skillFm[e.path] = R.helpers.frontmatter(text);
    var more = analyzeFile(f);
    for (var i = 0; i < more.length; i++) st.findings.push(more[i]);
    if (e.kind === 'code' || e.kind === 'config' || /SKILL\.md$/i.test(e.path)) collectHosts(text, st.hostsAll);
    if (e.kind === 'code') collectHosts(text, st.hostsCode);
  }

  function finishReport(s) {
    var findings = s.findings;
    var hostList = Object.keys(s.hostsAll || {}).sort(function (a, b) { return s.hostsAll[b] - s.hostsAll[a]; });
    var codeHostList = Object.keys(s.hostsCode || {});
    s.analyzed.sort(function (a, b) { return a.prio - b.prio || (a.path < b.path ? -1 : 1); });
    var rctx = { repo: s.repo, commits: s.commits, authors: s.authors, entries: s.entries, readme: s.readmeText, readmePath: s.readmePath, now: s.now,
      hosts: hostList, codeHosts: codeHostList, scopeRoot: s.scopeRoot, skillDirs: s.skillDirs.map(function (d) { return { dir: d, skillPath: d + 'SKILL.md' }; }), skillFm: s.skillFm };
    R.repoRules.forEach(function (rule) {
      var hs = []; try { hs = rule.run(rctx) || []; } catch (e) { hs = []; }
      hs.forEach(function (h) { findings.push({ id: rule.id, cat: rule.cat, sev: h.sev || rule.sev, baseSev: h.sev || rule.sev, title: rule.title, why: rule.why, fix: rule.fix, path: h.path || null, line: h.line || null, snippet: h.snippet || '', note: null }); });
    });
    var seenKey = {}; findings = findings.filter(function (f) { var k = f.id + '|' + f.path + '|' + f.line + '|' + f.snippet; if (seenKey[k]) return false; seenKey[k] = 1; return true; });
    findings.sort(function (a, b) { return SEV_ORDER[b.sev] - SEV_ORDER[a.sev] || (a.cat < b.cat ? -1 : 1) || (a.path || '').localeCompare(b.path || '') || (a.line || 0) - (b.line || 0); });
    var o = s.owner, r = s.repoName, sha = s.sha;
    findings.forEach(function (f) { f.url = (o && r && sha && f.path) ? 'https://github.com/' + o + '/' + r + '/blob/' + sha + '/' + encPath(f.path) + (f.line ? '#L' + f.line : '') : null; });
    var skipped = s.skipped, relevantTotal = s.relevantTotal, truncated = s.truncated;
    var C = R.SCORING.caps, capList = [];
    var skipCount = skipped.filter(function (x) { return x.counts; }).length, ratio = relevantTotal ? skipCount / relevantTotal : 0;
    if (truncated) capList.push({ value: C.treeTruncated, reason: 'GitHub truncated the file tree, so some files were never listed' });
    if (ratio > 0.5) capList.push({ value: C.skippedOver50pct, reason: skipCount + ' of ' + relevantTotal + ' scannable files were NOT analyzed (' + Math.round(ratio * 100) + '%)' });
    else if (ratio > 0.2) capList.push({ value: C.skippedOver20pct, reason: skipCount + ' of ' + relevantTotal + ' scannable files were NOT analyzed (' + Math.round(ratio * 100) + '%)' });
    else if (skipCount > 0) capList.push({ value: C.skippedSome, reason: skipCount + ' scannable file' + (skipCount > 1 ? 's were' : ' was') + ' NOT analyzed' });
    var binCount = skipped.filter(function (x) { return x.binary; }).length;
    if (binCount) capList.push({ value: C.binariesOrArchives, reason: binCount + ' binary / archive file' + (binCount > 1 ? 's' : '') + ' present that this scan cannot open' });
    var core = s.analyzed.filter(function (a) { return !/(^|\/)(README|LICENSE|LICENCE|NOTICE|CONTRIBUTING|CHANGELOG|SECURITY)(\.[a-z]+)?$/i.test(a.path); });
    var nothing = core.length === 0;
    if (nothing) capList.push({ value: C.nothingToScan, reason: 'there was almost nothing to scan (no skills, MCP config, scripts or code were analyzed)' });
    var sc = scoreFindings(findings, capList), band = bandFor(sc.score);
    var perRule = {}, trimmed = {};
    findings = findings.filter(function (f) { var k = f.id; perRule[k] = (perRule[k] || 0) + 1; if (perRule[k] > R.LIMITS.maxFindingsPerRule) { trimmed[k] = perRule[k] - R.LIMITS.maxFindingsPerRule; return false; } return true; });
    if (nothing) band = { key: 'gray', label: 'Nothing to scan here 🤷', line: 'No skill files, MCP config or code were found, so the score only reflects docs and upkeep.' };
    var repo = s.repo || {}, commits = s.commits || [], rate = s.rate || {};
    return {
      ruleset: R.RULESET, scoredAt: s.now, scoreDay: isoDay(s.now),
      repo: { owner: o, name: r, url: repo.html_url, description: repo.description, stars: repo.stargazers_count, fork: repo.fork, archived: repo.archived, license: repo.license && repo.license.spdx_id, pushedAt: repo.pushed_at, createdAt: repo.created_at, defaultBranch: repo.default_branch },
      ref: s.ref, subpath: s.subpath, sha: sha, shortSha: sha ? String(sha).slice(0, 7) : '', commitDate: commits.length ? commits[0].date : null,
      score: sc.score, rawScore: sc.raw, capped: sc.capped, caps: sc.caps, sub: sc.sub, counts: sc.counts, band: band,
      findings: findings,
      coverage: { budget: { files: R.LIMITS.maxFiles, bytes: R.LIMITS.maxTotalBytes, perFile: R.LIMITS.maxFileBytes }, relevantTotal: relevantTotal, analyzed: s.analyzed.length, skippedCounted: skipCount, treeTruncated: truncated, treeNote: s.treeNote, totalFiles: s.entries.length },
      trimmedFindings: trimmed,
      stats: { apiCalls: rate.used || 0, fetchMs: s.fetchMs || 0, filesFetched: s.pickedCount || 0, bytesAnalyzed: s.analyzed.reduce(function (n, a) { return n + a.bytes; }, 0), budgetBytes: s.budgetBytes || 0, netErrors: s.netErrors || 0 },
      analyzed: s.analyzed, skipped: skipped, skippedOther: s.skippedOther,
      hosts: hostList, greenFlags: greenFlags(s.entries, repo, s.scopeRoot),
      rate: { remaining: rate.remaining != null ? rate.remaining : null, limit: rate.limit != null ? rate.limit : null, reset: rate.reset ? rate.reset * 1000 : null, used: rate.used || 0 },
      blindSpots: R.BLIND_SPOTS, disclaimer: 'Automated scan, not an audit or guarantee.'
    };
  }

  /* ---------------------------------------------------------- rescore (what-if) */
  function byteLen(t) {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(t).length;
    if (typeof Buffer !== 'undefined') return Buffer.byteLength(t, 'utf8');
    return unescape(encodeURIComponent(t)).length;
  }
  function buildContext(st, prep, entries, meta) {
    var picked = {}; prep.picked.forEach(function (e) { picked[e.path] = 1; });
    var unreadable = {};
    st.skipped.forEach(function (x) { if (picked[x.path] && x.counts) unreadable[x.path] = x.reason; });
    return {
      entries: entries.map(function (e) { var c = {}; for (var k in e) c[k] = e[k]; delete c.prio; return c; }),
      texts: st.texts, unreadable: unreadable, meta: meta
    };
  }
  /* Re-run the whole engine on the same repo with some files replaced (or added). `overrides` = { path: newText }.
     Returns a normal report. With no overrides it reproduces the original report, so a projected score is comparable. */
  function rescore(ctx, overrides) {
    if (!ctx || !ctx.entries || !ctx.texts) throw PushyError('BAD_INPUT', 'rescore needs the context from scan(..., { keepContext: true }).');
    overrides = overrides || {};
    var m = ctx.meta, prefix = m.subpath ? m.subpath + '/' : '';
    var entries = ctx.entries.map(function (e) { var c = {}; for (var k in e) c[k] = e[k]; return c; });
    var byPath = {}; entries.forEach(function (e) { byPath[e.path] = e; });
    Object.keys(overrides).forEach(function (p) {
      var t = overrides[p]; if (typeof t !== 'string') return;
      var size = byteLen(t);
      if (byPath[p]) byPath[p].size = size;
      else { var e = classify(p, size); e.depth = p.slice(prefix.length).split('/').length - 1; entries.push(e); byPath[p] = e; }
    });
    var prep = prepareEntries(entries);
    var st = { skipped: prep.skipped, findings: prep.findings, analyzed: [], readmeText: '', readmePath: '', skillFm: {}, hostsAll: {}, hostsCode: {} };
    prep.picked.forEach(function (e) {
      var text = Object.prototype.hasOwnProperty.call(overrides, e.path) ? overrides[e.path] : ctx.texts[e.path];
      if (typeof text !== 'string') { st.skipped.push({ path: e.path, reason: ctx.unreadable[e.path] || 'could not be read', counts: true }); return; }
      try { absorbFile(e, text, st); }
      catch (err) { st.skipped.push({ path: e.path, reason: 'analysis error (' + (err && err.message || 'unknown') + ')', counts: true }); }
    });
    return finishReport({
      findings: st.findings, skipped: st.skipped, skippedOther: prep.skippedOther, analyzed: st.analyzed, entries: entries,
      relevantTotal: prep.relevantTotal, truncated: m.truncated, treeNote: m.treeNote, repo: m.repo, commits: m.commits, authors: m.authors,
      readmeText: st.readmeText, readmePath: st.readmePath, hostsAll: st.hostsAll, hostsCode: st.hostsCode, scopeRoot: m.scopeRoot,
      skillDirs: prep.skillDirs, skillFm: st.skillFm, now: m.now, owner: m.owner, repoName: m.repoName, ref: m.ref, subpath: m.subpath, sha: m.sha,
      budgetBytes: prep.budgetBytes, pickedCount: prep.picked.length, fetchMs: 0, netErrors: m.netErrors || 0, rate: { used: 0 }
    });
  }

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

    var prep = prepareEntries(entries);
    var st = { skipped: prep.skipped, findings: prep.findings, analyzed: [], readmeText: '', readmePath: '', skillFm: {}, hostsAll: {}, hostsCode: {}, texts: opts.keepContext ? {} : null };
    var picked = prep.picked, budgetBytes = prep.budgetBytes, L = R.LIMITS;

    // fetch bodies (pool) + analyze as they arrive, yielding to the UI
    log('Reading ' + picked.length + ' file' + (picked.length === 1 ? '' : 's') + ' (' + Math.round(budgetBytes / 1024) + ' KB, pinned to ' + sha.slice(0, 7) + ')…');
    var done = 0, netErrors = 0;
    var t0 = now0();
    function now0() { return (typeof performance !== 'undefined' ? performance.now() : Date.now()); }
    var abortAll = false;
    async function fetchText(e) {
      var urls = ['https://cdn.jsdelivr.net/gh/' + o + '/' + r + '@' + sha + '/' + encPath(e.path), 'https://raw.githubusercontent.com/' + o + '/' + r + '/' + sha + '/' + encPath(e.path)];
      var why = [];
      for (var u = 0; u < urls.length; u++) {
        var host = u === 0 ? 'jsDelivr' : 'raw.githubusercontent';
        for (var attempt = 0; attempt < 3; attempt++) {
          var ctl = typeof AbortController !== 'undefined' ? new AbortController() : null, to = ctl && setTimeout(function () { ctl.abort(); }, 25000);
          try {
            var res = await ff(urls[u], ctl ? { signal: ctl.signal } : {});
            if (to) clearTimeout(to);
            if (res.ok) return await res.text();
            if (res.status === 404 || res.status === 403 || res.status === 413 || res.status === 451) { why.push(host + ' ' + res.status); break; } // not retryable here: fall through to next source
            why.push(host + ' HTTP ' + res.status);
          } catch (err) { if (to) clearTimeout(to); why.push(host + (err && err.name === 'AbortError' ? ' timeout' : ' network error')); }
          await sleep(300 * Math.pow(2, attempt) + Math.random() * 150); // 300, 600, 1200 ms backoff
        }
      }
      var last = why.slice(-2).join(', ');
      throw new Error(last || 'failed');
    }
    function handle(e, text) { absorbFile(e, text, st); }
    var queue = picked.slice(), bytesDone = 0;
    async function worker() {
      while (queue.length && !abortAll) {
        var e = queue.shift(), text = null;
        try { text = await fetchText(e); }
        catch (err) { st.skipped.push({ path: e.path, reason: 'could not be downloaded (' + err.message + ')', counts: true }); netErrors++; }
        if (text !== null) { try { handle(e, text); } catch (err) { st.skipped.push({ path: e.path, reason: 'analysis error (' + (err && err.message || 'unknown') + ')', counts: true }); } bytesDone += e.size; }
        done++; if (opts.onFile) opts.onFile(done, picked.length, e.path, bytesDone, budgetBytes);
        if (done % 8 === 0) await sleep(0); // let the UI paint
      }
    }
    var workers = []; for (var w = 0; w < L.fetchConcurrency; w++) workers.push(worker());
    await Promise.all(workers);
    var fetchMs = Math.round(now0() - t0);
    log('Running ' + (R.lineRules.length + R.specialRules.length + R.fileRules.length + R.pathRules.length + R.repoRules.length) + ' rules…');
    await sleep(0);
    var rep = finishReport({
      findings: st.findings, skipped: st.skipped, skippedOther: prep.skippedOther, analyzed: st.analyzed, entries: entries,
      relevantTotal: prep.relevantTotal, truncated: truncated, treeNote: treeNote, repo: repo, commits: commits, authors: authors,
      readmeText: st.readmeText, readmePath: st.readmePath, hostsAll: st.hostsAll, hostsCode: st.hostsCode, scopeRoot: scopeRoot,
      skillDirs: prep.skillDirs, skillFm: st.skillFm, now: now, owner: o, repoName: r, ref: ref, subpath: subpath, sha: sha,
      budgetBytes: budgetBytes, pickedCount: picked.length, fetchMs: fetchMs, netErrors: netErrors, rate: api.rate
    });
    if (opts.keepContext) rep.context = buildContext(st, prep, entries, { repo: repo, commits: commits, authors: authors, now: now, owner: o, repoName: r, ref: ref, subpath: subpath, sha: sha, scopeRoot: scopeRoot, truncated: truncated, treeNote: treeNote, netErrors: netErrors });
    return rep;
  }

  function scanLocal(rootDir, opts) {
    opts = opts || {};
    if (typeof require !== 'function') throw PushyError('LOCAL', 'A local scan runs in Node. The browser scanner uses scan().');
    var fs = require('fs'), pathMod = require('path'), cp = require('child_process');
    var root = pathMod.resolve(String(rootDir || '.'));
    var dirStat; try { dirStat = fs.statSync(root); } catch (e) { throw PushyError('BAD_INPUT', 'No such directory: ' + rootDir); }
    if (!dirStat.isDirectory()) throw PushyError('BAD_INPUT', 'path is not a directory: ' + rootDir);
    var files = [];
    (function walk(dir) {
      var ents = fs.readdirSync(dir, { withFileTypes: true });
      for (var i = 0; i < ents.length; i++) {
        var ent = ents[i];
        if (ent.isSymbolicLink()) continue;
        var abs = pathMod.join(dir, ent.name);
        var rel = pathMod.relative(root, abs).split(pathMod.sep).join('/');
        if (ent.isDirectory()) {
          if (ent.name === '.git') continue;
          if (R.FILES.skipDirs.test(rel + '/')) continue;
          walk(abs);
        } else if (ent.isFile()) {
          var size = 0; try { size = fs.statSync(abs).size; } catch (e2) { size = 0; }
          files.push({ path: rel, size: size });
        }
      }
    })(root);
    var entries = files.map(function (f) { var e = classify(f.path, f.size); e.depth = f.path.split('/').length - 1; return e; });
    if (!entries.length) throw PushyError('EMPTY', 'No files found in that folder.');
    var prep = prepareEntries(entries);
    var st = { skipped: prep.skipped, findings: prep.findings, analyzed: [], readmeText: '', readmePath: '', skillFm: {}, hostsAll: {}, hostsCode: {}, texts: opts.keepContext ? {} : null };
    prep.picked.forEach(function (e) {
      var text = null;
      try { text = fs.readFileSync(pathMod.join(root, e.path), 'utf8'); }
      catch (err) { st.skipped.push({ path: e.path, reason: 'could not be read (' + err.message + ')', counts: true }); return; }
      try { absorbFile(e, text, st); }
      catch (err2) { st.skipped.push({ path: e.path, reason: 'analysis error (' + (err2 && err2.message || 'unknown') + ')', counts: true }); }
    });
    var now = opts.now || Date.now();
    var eventRepo = null;
    if (!opts.repo && process.env.GITHUB_EVENT_PATH) {
      try { eventRepo = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')).repository || null; } catch (e3) { eventRepo = null; }
    }
    var repo = opts.repo || eventRepo || {};
    var commits = Array.isArray(opts.commits) ? opts.commits : null;
    if (!commits) {
      commits = [];
      try {
        var top = cp.execFileSync('git', ['-C', root, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
        if (pathMod.resolve(top) === root) {
          var logOut = cp.execFileSync('git', ['-C', root, 'log', '-n', '30', '--format=%H%x09%aI%x09%an'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
          commits = logOut.split('\n').filter(Boolean).map(function (line) { var p = line.split('\t'); return { sha: p[0], date: p[1], author: p[2] || '?' }; });
        }
      } catch (e4) { commits = []; }
    }
    var authors = []; commits.forEach(function (c) { if (authors.indexOf(c.author) < 0) authors.push(c.author); });
    var owner = opts.owner || (repo.owner && (repo.owner.login || repo.owner.name)) || '';
    var repoName = opts.repoName || repo.name || '';
    var sha = opts.sha || (!opts.repo && process.env.GITHUB_SHA) || (commits[0] && commits[0].sha) || '';
    var ref = opts.ref || repo.default_branch || '';
    var rep = finishReport({
      findings: st.findings, skipped: st.skipped, skippedOther: prep.skippedOther, analyzed: st.analyzed, entries: entries,
      relevantTotal: prep.relevantTotal, truncated: false, treeNote: 'local checkout', repo: repo, commits: commits, authors: authors,
      readmeText: st.readmeText, readmePath: st.readmePath, hostsAll: st.hostsAll, hostsCode: st.hostsCode, scopeRoot: true,
      skillDirs: prep.skillDirs, skillFm: st.skillFm, now: now, owner: owner, repoName: repoName, ref: ref, subpath: '', sha: sha,
      budgetBytes: prep.budgetBytes, pickedCount: prep.picked.length, fetchMs: 0, netErrors: 0, rate: { used: 0 }
    });
    if (opts.keepContext) rep.context = buildContext(st, prep, entries, { repo: repo, commits: commits, authors: authors, now: now, owner: owner, repoName: repoName, ref: ref, subpath: '', sha: sha, scopeRoot: true, truncated: false, treeNote: 'local checkout', netErrors: 0 });
    return rep;
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

  var api = { parseInput: parseInput, scan: scan, scanLocal: scanLocal, rescore: rescore, analyzeFile: analyzeFile, classify: classify, scoreFindings: scoreFindings, bandFor: bandFor, badgeSVG: badgeSVG, badgeMarkdown: badgeMarkdown, PushyError: PushyError, SEV_ORDER: SEV_ORDER, BAND_COLORS: BAND_COLORS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.Pushy = api;
})(typeof window !== 'undefined' ? window : globalThis);
