'use strict';

var fs = require('fs');
var path = require('path');
var cp = require('child_process');
var pushy = require('../score/pushy.js');
var comment = require('./comment.js');
var github = require('./github.js');
var deepScan = require('./deep.js');

function input(name) {
  var key = 'INPUT_' + String(name).toUpperCase();
  if (Object.prototype.hasOwnProperty.call(process.env, key)) return process.env[key];
  return '';
}

function workspace() {
  return process.env.GITHUB_WORKSPACE || process.cwd();
}

function readEvent() {
  if (!process.env.GITHUB_EVENT_PATH) return {};
  try { return JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')); }
  catch (e) { return {}; }
}

function setOutput(name, value) {
  var file = process.env.GITHUB_OUTPUT;
  var text = String(value == null ? '' : value);
  if (file) fs.appendFileSync(file, name + '=' + text.replace(/\r?\n/g, '') + '\n');
  else console.log('output ' + name + '=' + text);
}

function shouldFail(score, raw) {
  if (raw == null || String(raw).trim() === '') return { fail: false };
  var n = Number(raw);
  if (!Number.isFinite(n)) return { error: 'fail-under must be a number, got ' + JSON.stringify(String(raw)) };
  return { fail: score < n, threshold: n };
}

function wantsComment(raw) {
  var v = String(raw == null ? 'true' : raw).trim().toLowerCase();
  return v !== 'false' && v !== '0' && v !== 'no' && v !== 'off';
}

function changedFiles(root) {
  if (process.env.GITHUB_EVENT_NAME !== 'pull_request') return null;
  var base = process.env.GITHUB_BASE_REF;
  if (!base) return null;
  try {
    cp.execFileSync('git', ['fetch', '--no-tags', '--depth', '1', 'origin', base], { cwd: root, stdio: 'ignore' });
    var out = cp.execFileSync('git', ['diff', '--name-only', 'origin/' + base + '...HEAD'], { cwd: root, encoding: 'utf8' });
    return out.split('\n').map(function (s) { return s.trim(); }).filter(Boolean);
  } catch (e) {
    console.log('Could not list pull request files from git (' + (e && e.message ? e.message.split('\n')[0] : 'diff failed') + '). The comment will not mark new files.');
    return null;
  }
}

function reportFile(root) {
  return path.join(root, 'pushy-report.json');
}

/*
 * Optional AI Deep Scan (docs/DEEP_SCAN.md). Advisory only: it never changes the score or the report above,
 * never fails the job, and writes its own file. Returns the result to render, or null when it is off.
 */
var deepDeps = {}; // tests inject sleep here

async function runDeep(report, scanPath, root, event) {
  var opts = deepScan.parseOptions(function (n) { return input(n); }, process.env, event);
  if (!opts.enabled) {
    setOutput('deep-status', 'off');
    return null;
  }
  if (opts.error) {
    console.error('::warning::Deep Scan not run: ' + deepScan.logSafe(opts.error, ''));
    setOutput('deep-status', 'error');
    return { skipped: 'Deep Scan not run: ' + opts.error, reviewed: [], notReviewed: [], verdicts: [], findings: [], errors: [], requests: {}, status: 'skipped' };
  }
  if (opts.skip) {
    console.log('::notice::' + deepScan.logSafe(opts.skip, ''));
    setOutput('deep-status', 'skipped');
    return { skipped: opts.skip, reviewed: [], notReviewed: [], verdicts: [], findings: [], errors: [], requests: {}, status: 'skipped' };
  }
  var cfg = opts.config;
  cfg.key.split(/\r?\n/).forEach(function (part) { if (part.trim()) console.log('::add-mask::' + part.trim()); });
  console.log('Deep Scan: ' + cfg.provider + ' / ' + deepScan.logSafe(cfg.model, cfg.key) + ' at ' + cfg.host + ' (AI opinion, automated, not an audit)');
  var deep;
  try {
    deep = await deepScan.run(report, scanPath, cfg, deepDeps);
  } catch (e) {
    console.log('::warning::Deep Scan failed: ' + deepScan.logSafe(e && e.message, cfg.key));
    setOutput('deep-status', 'failed');
    return { skipped: 'Deep Scan failed before any request finished. The basic scan is unaffected.', reviewed: [], notReviewed: [], verdicts: [], findings: [], errors: [], requests: {}, status: 'failed' };
  }
  var outPath = path.join(root, 'pushy-deep-report.json');
  fs.writeFileSync(outPath, JSON.stringify(deep, null, 2));
  setOutput('deep-status', deep.status);
  setOutput('deep-report-path', outPath);
  deep.errors.forEach(function (m) { console.log('::warning::Deep Scan ' + deepScan.logSafe(m, cfg.key)); });
  console.log('Deep Scan ' + deep.status + ': read ' + deep.reviewed.length + ' file(s), did not read ' + deep.notReviewed.length + ', ' + deep.findings.length + ' new AI finding(s). Score unchanged.');
  return deep;
}

async function run() {
  if (String(input('repos')).trim()) return require('./watch.js').run(); // watch mode: scan other repos, keep a tracking issue (docs/WATCH.md)
  var root = workspace();
  var rel = input('path') || '.';
  var scanPath = path.resolve(root, rel);
  var event = readEvent();
  var repoEnv = process.env.GITHUB_REPOSITORY || '';
  var slash = repoEnv.indexOf('/');
  var owner = slash === -1 ? '' : repoEnv.slice(0, slash);
  var repo = slash === -1 ? '' : repoEnv.slice(slash + 1);
  var sha = (event.pull_request && event.pull_request.head && event.pull_request.head.sha) || process.env.GITHUB_SHA || '';
  var ref = (event.pull_request && event.pull_request.head && event.pull_request.head.ref) || process.env.GITHUB_REF_NAME || '';

  console.log('🐹 Pushy scanning ' + scanPath);
  var report = pushy.scanLocal(scanPath, { owner: owner, repoName: repo, sha: sha, ref: ref });
  var outPath = reportFile(root);
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  setOutput('score', report.score);
  setOutput('band', report.band && report.band.key);
  setOutput('report-path', outPath);

  console.log(report.band.label + ' — ' + report.score + '/100');

  var deep = await runDeep(report, scanPath, root, event);
  var summary = comment.renderSummary(report, deep);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);

  var exitCode = 0;
  if (wantsComment(input('comment') || 'true')) {
    if (process.env.GITHUB_EVENT_NAME === 'pull_request' && event.pull_request) {
      var token = input('github-token') || process.env.GITHUB_TOKEN || '';
      if (!token) {
        console.error('::error::github-token is empty, so Pushy cannot post the pull request comment.');
        exitCode = 1;
      } else if (!owner || !repo) {
        console.error('::error::GITHUB_REPOSITORY is missing.');
        exitCode = 1;
      } else {
        var changed = null;
        try { changed = await github.listPullFiles(token, owner, repo, event.pull_request.number); }
        catch (e0) { changed = changedFiles(root); }
        var body = comment.renderComment(report, { owner: owner, repo: repo, sha: sha, changed: changed, deep: deep });
        try {
          var saved = await github.upsertComment(token, owner, repo, event.pull_request.number, body);
          console.log('Updated pull request comment ' + (saved && saved.html_url ? saved.html_url : '#' + event.pull_request.number));
        } catch (e) {
          console.error('::error::' + e.message);
          exitCode = 1;
        }
      }
    } else {
      console.log('No pull request on this event. Skipping the comment.');
    }
  }

  var gate = shouldFail(report.score, input('fail-under'));
  if (gate.error) {
    console.error('::error::' + gate.error);
    exitCode = 1;
  } else if (gate.fail) {
    console.error('::error::Pushy score ' + report.score + ' is below fail-under ' + gate.threshold + '.');
    exitCode = 1;
  }
  if (exitCode) process.exitCode = exitCode;
}

if (require.main === module) {
  run().catch(function (err) {
    console.error('::error::' + (err && err.stack ? err.stack : err));
    process.exitCode = 1;
  });
}

module.exports = { deepDeps: deepDeps, run: run, shouldFail: shouldFail, wantsComment: wantsComment, input: input };
