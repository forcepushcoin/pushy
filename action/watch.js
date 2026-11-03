'use strict';

/*
 * Pushy watch mode: scan OTHER repositories on a schedule and keep one tracking issue in YOUR repository.
 *
 *   - Each watched repo is shallow-cloned on the runner (depth 30, no hooks, no submodules, nothing executed) and scored with the same
 *     engine as everything else: scanLocal() in score/pushy.js. Nothing is uploaded anywhere.
 *   - The baseline (score + fingerprints of medium-and-up findings per repo) lives in a hidden comment inside the tracking issue,
 *     so the workflow needs only `issues: write`. No commits, no cache, no extra service.
 *   - A new comment is added to the issue only when something changed for the worse (score drop, new serious finding, ...).
 *   - Findings come from other people's files. The issue never quotes a snippet; it shows the rule id, the rule's own title (from the
 *     ruleset), a sanitised file path and a link.
 */

var fs = require('fs');
var os = require('os');
var path = require('path');
var cp = require('child_process');
var crypto = require('crypto');
var pushy = require('../score/pushy.js');
var rules = require('../score/rules.js');
var github = require('./github.js');

var MARKER = '<!-- pushy-watch -->';
var ALERT_MARKER = '<!-- pushy-watch-alert -->';
var STATE_PREFIX = '<!-- pushy-watch-state:';
var STATE_SUFFIX = ' -->';
var FOOTER = 'Automated scan, not an audit · Pushy needs no token';
var MAX_REPOS = 25;
var MAX_FP = 40;
var SEV = { critical: 4, high: 3, medium: 2, low: 1, info: 0 };

/* ------------------------------------------------------------------ inputs */

function boolInput(raw, dflt) {
  var v = String(raw == null || String(raw).trim() === '' ? dflt : raw).trim().toLowerCase();
  return v === 'true' || v === '1' || v === 'yes' || v === 'on';
}

function numInput(name, raw, dflt, min, max) {
  if (raw == null || String(raw).trim() === '') return dflt;
  var n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max) throw new Error(name + ' must be a number from ' + min + ' to ' + max + ', got ' + JSON.stringify(String(raw)));
  return n;
}

/* "owner/repo", "owner/repo@branch-or-tag", full github.com URLs. One per line or comma separated. "#" starts a comment. */
function parseRepos(text) {
  var out = [], seen = {};
  String(text || '').split(/\r?\n/).forEach(function (line) {
    line = line.replace(/(^|\s)#.*$/, '').trim();
    if (!line) return;
    line.split(/[,\s]+/).filter(Boolean).forEach(function (tok) {
      var ref = '';
      var at = tok.lastIndexOf('@');
      if (at > 0 && tok.indexOf('/') > -1 && at > tok.indexOf('/')) { ref = tok.slice(at + 1); tok = tok.slice(0, at); }
      var m = /^(?:https?:\/\/)?(?:www\.)?(?:github\.com\/)?([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?\/?$/.exec(tok);
      if (!m || m[2] === '.' || m[2] === '..') throw new Error('Not a repository: ' + JSON.stringify(tok.slice(0, 80)) + '. Use owner/repo or owner/repo@branch.');
      if (ref && (!/^[A-Za-z0-9._\/-]{1,100}$/.test(ref) || ref[0] === '-' || ref.indexOf('..') > -1)) throw new Error('Bad ref ' + JSON.stringify(ref.slice(0, 80)) + ' for ' + m[1] + '/' + m[2] + '. Use a branch or tag name.');
      var key = (m[1] + '/' + m[2]).toLowerCase() + (ref ? '@' + ref : '');
      if (seen[key]) return;
      seen[key] = true;
      out.push({ owner: m[1], repo: m[2], ref: ref, key: key });
    });
  });
  if (out.length > MAX_REPOS) throw new Error('Too many repositories (' + out.length + '). Watch mode accepts up to ' + MAX_REPOS + ' per run. Split them across two workflows.');
  return out;
}

function readConfig(input) {
  var sev = String(input('alert-severity') || 'critical').trim().toLowerCase();
  if (['critical', 'high', 'medium'].indexOf(sev) < 0) throw new Error('alert-severity must be critical, high or medium, got ' + JSON.stringify(sev));
  var below = String(input('alert-below') || '').trim();
  return {
    repos: parseRepos(input('repos')),
    dropThreshold: numInput('drop-threshold', input('drop-threshold'), 5, 1, 100),
    alertSeverity: sev,
    alertBelow: below === '' ? null : numInput('alert-below', below, null, 1, 100),
    label: String(input('issue-label') || 'pushy-watch').trim().slice(0, 50) || 'pushy-watch',
    title: String(input('issue-title') || 'Pushy watchlist').trim().slice(0, 120) || 'Pushy watchlist',
    dryRun: boolInput(input('dry-run'), 'false'),
    failOnAlert: boolInput(input('fail-on-alert'), 'false'),
    readToken: String(input('read-token') || '').trim(),
    githubToken: String(input('github-token') || '').trim()
  };
}

/* ------------------------------------------------------------------ text safety */

function plain(s, max) {
  s = String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, ' ').replace(/\s+/g, ' ').trim();
  return max && s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function codeSpan(s, max) { // safe inside `...`: no backticks, no control chars
  return '`' + plain(s, max || 100).replace(/`/g, "'") + '`';
}

function cell(s) { return plain(s).replace(/\|/g, '\\|').replace(/</g, '&lt;'); }

function scrub(s, secrets) {
  s = String(s == null ? '' : s);
  (secrets || []).forEach(function (x) { if (x && x.length > 5) s = s.split(x).join('***'); });
  return s;
}

function blobUrl(owner, repo, sha, p, line) {
  if (!sha || !p) return null;
  return 'https://github.com/' + owner + '/' + repo + '/blob/' + encodeURIComponent(sha) + '/' + String(p).split('/').map(encodeURIComponent).join('/') + (line ? '#L' + line : '');
}

/* ------------------------------------------------------------------ fetch + scan one repo */

function cleanEnv(base, extra) {
  var env = {};
  Object.keys(base || {}).forEach(function (k) { env[k] = base[k]; });
  env.GIT_TERMINAL_PROMPT = '0';
  env.GIT_LFS_SKIP_SMUDGE = '1';
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_CONFIG_GLOBAL = os.platform() === 'win32' ? 'NUL' : '/dev/null';
  Object.keys(extra || {}).forEach(function (k) { env[k] = extra[k]; });
  return env;
}

/* Shallow clone. The token (only if the user supplied `read-token`) goes through git's env config, never argv or the URL. */
function cloneRepo(spec, dest, opts) {
  opts = opts || {};
  var baseEnv = opts.env || process.env;
  var base = baseEnv.PUSHY_WATCH_BASE_URL || 'https://github.com/'; // PUSHY_WATCH_BASE_URL exists only so the tests can clone local bare repos
  if (base.slice(-1) !== '/') base += '/';
  var url = base + spec.owner + '/' + spec.repo + '.git';
  var extra = {};
  if (opts.token && /^https:\/\/github\.com\//.test(url)) {
    extra.GIT_CONFIG_COUNT = '1';
    extra.GIT_CONFIG_KEY_0 = 'http.https://github.com/.extraheader';
    extra.GIT_CONFIG_VALUE_0 = 'AUTHORIZATION: basic ' + Buffer.from('x-access-token:' + opts.token).toString('base64');
  }
  var args = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.symlinks=false', '-c', 'core.fsmonitor=false', '-c', 'advice.detachedHead=false',
    'clone', '--quiet', '--depth', '30', '--no-tags', '--single-branch', '--no-recurse-submodules'];
  if (spec.ref) args.push('--branch', spec.ref);
  args.push('--', url, dest);
  try {
    cp.execFileSync('git', args, { env: cleanEnv(baseEnv, extra), stdio: ['ignore', 'ignore', 'pipe'], timeout: opts.timeoutMs || 180000, maxBuffer: 1 << 20 });
  } catch (e) {
    var err = String((e && e.stderr) || (e && e.message) || 'clone failed').split('\n').filter(Boolean)[0] || 'clone failed';
    err = plain(scrub(err, [opts.token]), 160);
    var out = new Error(/not found|could not read|Authentication|403|404|repository/i.test(err) ? 'could not clone (not found, private, or no access)' : 'could not clone (' + err + ')');
    out.code = 'CLONE';
    throw out;
  }
  var sha = '';
  try { sha = cp.execFileSync('git', ['-C', dest, 'rev-parse', 'HEAD'], { encoding: 'utf8', env: cleanEnv(baseEnv), stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch (e2) { sha = ''; }
  return { dir: dest, sha: sha };
}

function fingerprint(f) {
  return crypto.createHash('sha1').update(f.id + '|' + f.path).digest('hex').slice(0, 8);
}

function slimReport(spec, report, meta) {
  var findings = (report.findings || []).map(function (f) {
    return { id: String(f.id), sev: f.sev, title: f.title, path: f.path || '', line: f.line || 0, fp: fingerprint({ id: String(f.id), path: f.path || '' }) };
  });
  var sorted = findings.filter(function (f) { return SEV[f.sev] >= SEV.medium; }).sort(function (a, b) { return SEV[b.sev] - SEV[a.sev] || (a.fp < b.fp ? -1 : 1); });
  var fps = []; sorted.forEach(function (f) { if (fps.indexOf(f.fp) < 0 && fps.length < MAX_FP) fps.push(f.fp); });
  return {
    key: spec.key, owner: spec.owner, repo: spec.repo, ref: spec.ref || (meta && meta.default_branch) || '', status: 'ok',
    score: report.score, band: report.band && report.band.key, bandLabel: report.band && report.band.label, capped: !!report.capped,
    sha: report.sha || '', counts: report.counts || {}, analyzed: report.coverage && report.coverage.analyzed, relevant: report.coverage && report.coverage.relevantTotal,
    archived: !!(meta && meta.archived), findings: sorted.slice(0, 60), fp: fps, alerts: []
  };
}

function scanOne(spec, cfg, deps, env) {
  var api = deps.gh || github.gh, token = cfg.readToken || cfg.githubToken;
  var tmp = fs.mkdtempSync(path.join(env.RUNNER_TEMP || os.tmpdir(), 'pushy-watch-'));
  var dest = path.join(tmp, 'repo');
  return Promise.resolve()
    .then(function () { // metadata for the repo rules (archived, fork, license, ...). Failure is fine: the scan still runs.
      if (!token) return null;
      return api(token, 'GET', 'https://api.github.com/repos/' + spec.owner + '/' + spec.repo).catch(function () { return null; });
    })
    .then(function (meta) {
      var cloned = (deps.clone || cloneRepo)(spec, dest, { token: cfg.readToken || '', env: env });
      var report = pushy.scanLocal(cloned.dir, {
        owner: spec.owner, repoName: spec.repo, sha: cloned.sha, ref: spec.ref || (meta && meta.default_branch) || '',
        repo: meta || {}, now: deps.now
      });
      return slimReport(spec, report, meta);
    })
    .catch(function (e) {
      var msg = e && e.code === 'EMPTY' ? 'nothing to scan (no files)' : plain(scrub(e && e.message || 'scan failed', [token]), 160);
      return { key: spec.key, owner: spec.owner, repo: spec.repo, ref: spec.ref, status: 'error', error: msg, alerts: [], findings: [], fp: [] };
    })
    .then(function (res) { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* best effort */ } return res; });
}

/* ------------------------------------------------------------------ baseline + diff */

function encodeState(state) { return STATE_PREFIX + Buffer.from(JSON.stringify(state)).toString('base64') + STATE_SUFFIX; }

function decodeState(body) {
  var s = String(body || ''), i = s.indexOf(STATE_PREFIX);
  if (i < 0) return null;
  var j = s.indexOf(STATE_SUFFIX, i + STATE_PREFIX.length);
  if (j < 0) return null;
  try {
    var st = JSON.parse(Buffer.from(s.slice(i + STATE_PREFIX.length, j), 'base64').toString('utf8'));
    return st && typeof st === 'object' && st.repos && typeof st.repos === 'object' ? st : null;
  } catch (e) { return null; }
}

function buildState(results, rulesetVersion, now) {
  var st = { v: 1, ruleset: rulesetVersion, at: new Date(now).toISOString(), repos: {} };
  results.forEach(function (r) {
    if (r.status === 'ok') st.repos[r.key] = { score: r.score, band: r.band, sha: r.sha, fp: r.fp, at: st.at };
    else st.repos[r.key] = { error: r.error, at: st.at, prev: null };
  });
  return st;
}

/* Keep the last good baseline for a repo that failed this time, so a flaky clone does not wipe it. */
function mergeBaselines(next, prevState, results) {
  results.forEach(function (r) {
    if (r.status !== 'ok' && prevState && prevState.repos && prevState.repos[r.key] && prevState.repos[r.key].score != null) {
      var p = prevState.repos[r.key];
      next.repos[r.key] = { score: p.score, band: p.band, sha: p.sha, fp: p.fp, at: p.at, error: r.error, failedAt: next.at };
    }
  });
  return next;
}

/* Returns alert objects for one repo. prev is state.repos[key] or undefined. */
function diffRepo(prev, cur, cfg, rebaseline) {
  var alerts = [];
  if (cur.status !== 'ok') {
    if (prev && prev.score != null && !prev.error) alerts.push({ type: 'error', message: cur.error });
    return alerts;
  }
  if (!prev || prev.score == null || rebaseline) return alerts; // first sight (or ruleset changed): baseline only
  var drop = prev.score - cur.score;
  if (drop >= cfg.dropThreshold) alerts.push({ type: 'drop', from: prev.score, to: cur.score, delta: -drop });
  if (cfg.alertBelow != null && cur.score < cfg.alertBelow && prev.score >= cfg.alertBelow) alerts.push({ type: 'below', from: prev.score, to: cur.score, threshold: cfg.alertBelow });
  var known = {}; (prev.fp || []).forEach(function (h) { known[h] = true; });
  var seen = {}, fresh = [];
  cur.findings.forEach(function (f) {
    if (SEV[f.sev] >= SEV[cfg.alertSeverity] && !known[f.fp] && !seen[f.fp]) { seen[f.fp] = true; fresh.push(f); }
  });
  if (fresh.length) alerts.push({ type: 'new', findings: fresh });
  return alerts;
}

/* ------------------------------------------------------------------ rendering */

function delta(prev, cur) {
  if (cur.status !== 'ok') return '–';
  if (!prev || prev.score == null) return 'new';
  var d = cur.score - prev.score;
  return d === 0 ? '=' : (d > 0 ? '▲ +' + d : '▼ −' + Math.abs(d));
}

function rowFor(r, prev) {
  var name = '[' + r.owner + '/' + r.repo + '](https://github.com/' + r.owner + '/' + r.repo + ')' + (r.ref ? ' `@' + plain(r.ref, 40).replace(/`/g, "'") + '`' : '');
  if (r.status !== 'ok') return '| ' + name + ' | – | – | – | – | ⚠️ ' + cell(r.error) + ' |';
  var c = r.counts || {};
  return '| ' + name + ' | **' + r.score + '**/100 ' + bandDot(r.band) + ' | ' + delta(prev, r) + ' | ' + (c.critical || 0) + ' | ' + (c.high || 0) + ' | ' + (r.archived ? 'archived · ' : '') + '`' + String(r.sha || '').slice(0, 7) + '`' + (r.capped ? ' · capped' : '') + ' |';
}

function bandDot(key) { return { green: '🟢', yellow: '🟡', orange: '🟠', red: '🔴' }[key] || '⚪'; }

function renderTable(results, prevState) {
  var lines = ['| Repo | Score | Change | Critical | High | Commit / note |', '| --- | --- | --- | --- | --- | --- |'];
  results.forEach(function (r) { lines.push(rowFor(r, prevState && prevState.repos && prevState.repos[r.key])); });
  return lines.join('\n');
}

function describeAlert(r, a) {
  if (a.type === 'drop') return '- Score dropped **' + a.from + ' → ' + a.to + '** (−' + (a.from - a.to) + ').';
  if (a.type === 'below') return '- Score fell below your alert line of **' + a.threshold + '**: ' + a.from + ' → ' + a.to + '.';
  if (a.type === 'error') return '- Could not be scanned this time: ' + cell(a.message) + '. The last good baseline is kept.';
  return null;
}

function renderAlertComment(results, now, runUrl) {
  var hit = results.filter(function (r) { return r.alerts && r.alerts.length; });
  var lines = [ALERT_MARKER, '### ⚠️ Pushy watch: ' + hit.length + (hit.length === 1 ? ' repo needs' : ' repos need') + ' a look · ' + new Date(now).toISOString().slice(0, 10), ''];
  hit.forEach(function (r) {
    lines.push('**[' + r.owner + '/' + r.repo + '](https://github.com/' + r.owner + '/' + r.repo + ')**' + (r.status === 'ok' ? ' at `' + String(r.sha || '').slice(0, 7) + '` now scores **' + r.score + '/100**' : ''));
    r.alerts.forEach(function (a) {
      var d = describeAlert(r, a);
      if (d) lines.push(d);
      if (a.type === 'new') {
        a.findings.slice(0, 10).forEach(function (f) {
          var u = blobUrl(r.owner, r.repo, r.sha, f.path, f.line);
          var where = f.path ? (u ? '[' + codeSpan(f.path + (f.line ? ':' + f.line : ''), 90) + '](' + u + ')' : codeSpan(f.path, 90)) : 'repository';
          lines.push('- New **' + f.sev + '** finding `' + f.id + '`: ' + cell(f.title) + ' · ' + where);
        });
        if (a.findings.length > 10) lines.push('- … and ' + (a.findings.length - 10) + ' more. Scan the repo with [Pushy Score](https://forcepushcoin.github.io/score/) for the full list.');
      }
    });
    lines.push('');
  });
  lines.push('Read the repo before you update or install anything from it. A score change means a rule fired or stopped firing, not that someone is malicious.');
  lines.push('');
  lines.push(FOOTER + (runUrl ? ' · [run](' + runUrl + ')' : ''));
  return lines.join('\n');
}

function renderIssueBody(results, prevState, state, opts) {
  opts = opts || {};
  var when = new Date(opts.now).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  var lines = [MARKER, '# 🐹 Pushy watchlist', '',
    'Last run **' + when + '** · ruleset `v' + opts.ruleset + '` · ' + results.length + ' repositor' + (results.length === 1 ? 'y' : 'ies') + (opts.runUrl ? ' · [workflow run](' + opts.runUrl + ')' : ''), '',
    renderTable(results, prevState), ''];
  var anyAlert = results.some(function (r) { return r.alerts && r.alerts.length; });
  lines.push(anyAlert ? '**⚠️ Alerts in the latest run: see the newest comment below.**' : '✅ No alerts in the latest run.');
  if (opts.rebaselined) lines.push('', 'The ruleset changed since the last run, so this run only refreshed the baseline (no alerts).');
  lines.push('', '<details><summary>How this works</summary>', '',
    'A scheduled workflow in this repository shallow-clones each watched repo on the runner, scores it with the Pushy ruleset and compares it with the baseline stored in the hidden comment at the bottom of this issue. It comments here only when a score drops, a new serious finding appears, or a repo stops being scannable. Nothing is uploaded to Pushy. Do not edit the hidden comment: it is the baseline.', '',
    'Alert settings: score drop ≥ ' + opts.dropThreshold + ' points · new finding at **' + opts.alertSeverity + '** or worse' + (opts.alertBelow != null ? ' · score under ' + opts.alertBelow : '') + '.', '', '</details>', '', FOOTER, '', encodeState(state));
  return lines.join('\n');
}

/* ------------------------------------------------------------------ issue sync */

async function findIssue(api, token, ownerRepo, label) {
  var url = 'https://api.github.com/repos/' + ownerRepo + '/issues?state=all&sort=created&direction=desc&per_page=30&labels=' + encodeURIComponent(label);
  var list = await api(token, 'GET', url);
  var arr = Array.isArray(list) ? list : [];
  for (var i = 0; i < arr.length; i++) if (!arr[i].pull_request && typeof arr[i].body === 'string' && arr[i].body.indexOf(MARKER) > -1) return arr[i];
  return null;
}

/* ------------------------------------------------------------------ main */

function setOutput(env, name, value) {
  var file = env.GITHUB_OUTPUT, text = String(value == null ? '' : value).replace(/\r?\n/g, '');
  if (file) fs.appendFileSync(file, name + '=' + text + '\n'); else console.log('output ' + name + '=' + text);
}

async function run(deps) {
  deps = deps || {};
  var env = deps.env || process.env;
  var input = deps.input || function (name) { var k = 'INPUT_' + String(name).toUpperCase(); return Object.prototype.hasOwnProperty.call(env, k) ? env[k] : ''; };
  var api = deps.gh || github.gh;
  var now = deps.now || Date.now();
  var cfg = readConfig(input);
  var ownerRepo = env.GITHUB_REPOSITORY || '';
  var token = cfg.githubToken || env.GITHUB_TOKEN || '';
  var runUrl = env.GITHUB_SERVER_URL && ownerRepo && env.GITHUB_RUN_ID ? env.GITHUB_SERVER_URL + '/' + ownerRepo + '/actions/runs/' + env.GITHUB_RUN_ID : '';
  var out = { exitCode: 0, alerts: 0, results: [], issueUrl: '' };

  if (!cfg.repos.length) throw new Error('repos is empty. List the repositories to watch, one owner/repo per line.');
  if (!cfg.dryRun && (!token || !ownerRepo)) throw new Error('Watch mode needs github-token and GITHUB_REPOSITORY to keep its tracking issue. Add `permissions: issues: write`, or set dry-run: true.');

  console.log('🐹 Pushy watch: ' + cfg.repos.length + ' repositor' + (cfg.repos.length === 1 ? 'y' : 'ies') + (cfg.dryRun ? ' (dry run: no issue changes)' : ''));
  var results = [];
  for (var i = 0; i < cfg.repos.length; i++) {
    var r = await scanOne(cfg.repos[i], cfg, deps, env);
    console.log('  ' + r.key + ': ' + (r.status === 'ok' ? r.score + '/100 ' + r.band : 'ERROR ' + r.error));
    results.push(r);
  }

  // previous baseline
  var issue = null, prevState = null;
  if (token && ownerRepo) {
    try { issue = await findIssue(api, token, ownerRepo, cfg.label); prevState = issue ? decodeState(issue.body) : null; }
    catch (e) {
      if (!cfg.dryRun) throw new Error('Could not read the tracking issue: ' + plain(scrub(e.message, [token]), 200) + '. Does the workflow have `permissions: issues: write`?');
      console.log('Dry run: could not read the tracking issue, so there is no baseline (' + plain(scrub(e.message, [token]), 120) + ').');
    }
  }
  var rulesetVersion = (rules.RULESET && rules.RULESET.version) || '';
  var rebaseline = !!(prevState && prevState.ruleset && rulesetVersion && prevState.ruleset !== rulesetVersion);

  results.forEach(function (r) { r.alerts = diffRepo(prevState && prevState.repos && prevState.repos[r.key], r, cfg, rebaseline); });
  var nAlerts = results.reduce(function (n, r) { return n + r.alerts.length; }, 0);
  out.alerts = nAlerts; out.results = results;

  var state = mergeBaselines(buildState(results, rulesetVersion, now), prevState, results);
  var body = renderIssueBody(results, prevState, state, { now: now, ruleset: rulesetVersion, runUrl: runUrl, dropThreshold: cfg.dropThreshold, alertSeverity: cfg.alertSeverity, alertBelow: cfg.alertBelow, rebaselined: rebaseline });
  var alertBody = nAlerts ? renderAlertComment(results, now, runUrl) : '';
  out.issueBody = body; out.alertBody = alertBody;

  var workspace = env.GITHUB_WORKSPACE || process.cwd();
  var reportPath = path.join(workspace, 'pushy-watch-report.json');
  fs.writeFileSync(reportPath, JSON.stringify({ ruleset: rulesetVersion, at: new Date(now).toISOString(), alerts: nAlerts, repos: results }, null, 2));
  if (env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY, '## 🐹 Pushy watchlist\n\n' + renderTable(results, prevState) + '\n\n' + (nAlerts ? '⚠️ ' + nAlerts + ' alert(s). ' : '✅ No alerts. ') + FOOTER + '\n');

  if (cfg.dryRun) {
    console.log('Dry run: would ' + (issue ? 'update issue #' + issue.number : 'create the tracking issue') + (nAlerts ? ' and add an alert comment' : '') + '.');
    if (nAlerts) console.log(alertBody);
  } else {
    var base = 'https://api.github.com/repos/' + ownerRepo + '/issues';
    if (!issue) {
      issue = await api(token, 'POST', base, { title: cfg.title, body: body, labels: [cfg.label] });
      console.log('Created tracking issue #' + issue.number + ' (first run: baseline only).');
    } else {
      var patch = { body: body };
      if (nAlerts && issue.state === 'closed') patch.state = 'open';
      issue = await api(token, 'PATCH', base + '/' + issue.number, patch) || issue;
    }
    if (nAlerts) await api(token, 'POST', base + '/' + issue.number + '/comments', { body: alertBody });
    out.issueUrl = issue.html_url || '';
    console.log((nAlerts ? nAlerts + ' alert(s) posted on ' : 'No alerts. Updated ') + (issue.html_url || 'issue #' + issue.number));
  }

  setOutput(env, 'alerts', nAlerts);
  setOutput(env, 'report-path', reportPath);
  setOutput(env, 'issue-url', out.issueUrl);
  if (nAlerts && cfg.failOnAlert) { console.error('::error::Pushy watch raised ' + nAlerts + ' alert(s) and fail-on-alert is true.'); out.exitCode = 1; }
  if (out.exitCode) process.exitCode = out.exitCode;
  return out;
}

module.exports = {
  run: run, parseRepos: parseRepos, readConfig: readConfig, diffRepo: diffRepo, cloneRepo: cloneRepo, scanOne: scanOne, slimReport: slimReport,
  encodeState: encodeState, decodeState: decodeState, buildState: buildState, mergeBaselines: mergeBaselines,
  renderIssueBody: renderIssueBody, renderAlertComment: renderAlertComment, renderTable: renderTable, fingerprint: fingerprint,
  MARKER: MARKER, ALERT_MARKER: ALERT_MARKER, MAX_REPOS: MAX_REPOS
};
