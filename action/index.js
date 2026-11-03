'use strict';

var fs = require('fs');
var path = require('path');
var cp = require('child_process');
var pushy = require('../score/pushy.js');
var comment = require('./comment.js');
var github = require('./github.js');

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

async function run() {
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

  var summary = comment.renderSummary(report);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  console.log(report.band.label + ' — ' + report.score + '/100');

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
        var body = comment.renderComment(report, { owner: owner, repo: repo, sha: sha, changed: changed });
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

module.exports = { run: run, shouldFail: shouldFail, wantsComment: wantsComment, input: input };
