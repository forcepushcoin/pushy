'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const pushy = require('../score/pushy.js');
const comment = require('../action/comment.js');
const github = require('../action/github.js');
const action = require('../action/index.js');

const META = {
  now: Date.parse('2026-06-01T00:00:00Z'),
  owner: 'fixture',
  repoName: 'skills',
  sha: '0123456789abcdef0123456789abcdef01234567',
  ref: 'main',
  repo: {
    description: 'Fixture skill',
    archived: false,
    fork: false,
    license: { spdx_id: 'MIT' },
    created_at: '2024-01-01T00:00:00Z',
    pushed_at: '2026-05-20T00:00:00Z',
    html_url: 'https://github.com/fixture/skills',
    default_branch: 'main',
    stargazers_count: 3
  },
  commits: [
    { sha: '0123456789abcdef0123456789abcdef01234567', date: '2026-05-20T00:00:00Z', author: 'ada' },
    { sha: 'fedcba9876543210fedcba9876543210fedcba98', date: '2026-04-02T00:00:00Z', author: 'grace' }
  ]
};

function scan(dir) {
  return pushy.scanLocal(path.join(__dirname, '..', 'fixtures', dir), META);
}

test('clean skill scores green', () => {
  const report = scan('clean');
  assert.equal(report.ruleset.version, '1.1.0');
  assert.ok(report.score >= 85, 'score ' + report.score + ' findings ' + report.findings.map((f) => f.id + ':' + f.sev).join(','));
  assert.equal(report.band.key, 'green');
  assert.equal(report.counts.critical, 0);
  assert.equal(report.counts.high, 0);
  assert.ok(report.coverage.analyzed >= 1);
  assert.equal(report.stats.apiCalls, 0);
});

test('evil skill scores red', () => {
  const report = scan('evil');
  const ids = report.findings.map((f) => f.id);
  assert.ok(ids.includes('S001'), ids.join(','));
  assert.ok(ids.includes('X001'), ids.join(','));
  assert.ok(ids.includes('P001'), ids.join(','));
  assert.ok(ids.includes('P011'), ids.join(','));
  assert.ok(report.score < 45, 'score ' + report.score);
  assert.equal(report.band.key, 'red');
  assert.ok(report.capped);
  const key = report.findings.find((f) => f.id === 'S001');
  assert.match(key.snippet, /AKIA/);
  assert.doesNotMatch(key.snippet, /AKIA0123456789ABCDEF/);
});

test('evil comment marks new files and keeps the disclaimer', () => {
  const report = scan('evil');
  const body = comment.renderComment(report, {
    owner: 'fixture',
    repo: 'skills',
    sha: META.sha,
    changed: ['scripts/setup.sh']
  });
  assert.match(body, /<!-- pushy-score -->/);
  assert.match(body, /Automated scan, not an audit · Pushy needs no token/);
  assert.match(body, new RegExp(report.score + '/100'));
  assert.match(body, /Do NOT force push this/);
  assert.match(body, /S001/);
  assert.match(body, /X001/);
  assert.match(body, /P001/);
  assert.match(body, /P011/);
  assert.match(body, /scripts\/setup\.sh:2/);
  assert.match(body, new RegExp('blob/' + META.sha + '/scripts/setup.sh#L2'));
  assert.match(body, /critical 🆕/);
  assert.match(body, /Secrets/);
  assert.match(body, /Code & network/);
  const summary = comment.renderSummary(report);
  assert.match(summary, /Pushy Score/);
  assert.match(summary, /Automated scan, not an audit · Pushy needs no token/);
});

test('sticky comment is found by the hidden marker', () => {
  const hit = github.findSticky([
    { id: 1, body: 'hello' },
    { id: 2, body: '<!-- pushy-score -->\n## 🐹 10/100' },
    { id: 3, body: 'other' }
  ]);
  assert.equal(hit.id, 2);
  assert.equal(github.findSticky([{ id: 4, body: 'nope' }]), null);
});

test('fail-under is empty by default and strict when set', () => {
  assert.equal(action.shouldFail(10, '').fail, false);
  assert.equal(action.shouldFail(10, '   ').fail, false);
  assert.equal(action.shouldFail(70, '70').fail, false);
  assert.equal(action.shouldFail(69, '70').fail, true);
  assert.ok(action.shouldFail(10, 'nope').error);
  assert.equal(action.wantsComment('true'), true);
  assert.equal(action.wantsComment('false'), false);
  assert.equal(action.wantsComment(''), true);
});
