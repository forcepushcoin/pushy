'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const watch = require('../action/watch.js');

const FIX = path.join(__dirname, '..', 'fixtures');
const GIT_ENV = Object.assign({}, process.env, { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' });
function git(cwd, ...args) { return cp.execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }

/* A fake "GitHub": bare repos at <base>/<owner>/<repo>.git, cloned through PUSHY_WATCH_BASE_URL (file://). */
function makeRemote(base, name, fixtureDir) {
  const bare = path.join(base, name + '.git');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-work-'));
  fs.mkdirSync(path.dirname(bare), { recursive: true });
  git(work, 'init', '-q', '-b', 'main');
  copyDir(path.join(FIX, fixtureDir), work);
  git(work, 'add', '-A'); git(work, 'commit', '-q', '-m', 'init');
  git(base, 'clone', '-q', '--bare', work, bare);
  return { bare, work, push() { git(work, 'add', '-A'); git(work, 'commit', '-q', '-m', 'update'); git(work, 'push', '-q', bare, 'HEAD:main'); } };
}
function copyDir(src, dst) { fs.mkdirSync(dst, { recursive: true }); for (const e of fs.readdirSync(src, { withFileTypes: true })) { const s = path.join(src, e.name), d = path.join(dst, e.name); e.isDirectory() ? copyDir(s, d) : fs.copyFileSync(s, d); } }

/* In-memory issues API. */
function fakeApi() {
  const st = { issues: [], comments: [], calls: [], next: 1 };
  async function gh(token, method, url, body) {
    st.calls.push(method + ' ' + url.replace('https://api.github.com', ''));
    let m;
    if (method === 'GET' && /\/repos\/[^/]+\/[^/]+$/.test(url)) return { archived: false, fork: false, description: 'x', license: { spdx_id: 'MIT' }, default_branch: 'main', created_at: '2024-01-01T00:00:00Z', pushed_at: '2026-05-01T00:00:00Z' };
    if (method === 'GET' && /\/issues\?/.test(url)) return st.issues.map((i) => Object.assign({}, i)).reverse();
    if (method === 'POST' && /\/issues$/.test(url)) { const i = { number: st.next++, title: body.title, body: body.body, labels: body.labels, state: 'open', html_url: 'https://github.com/me/mine/issues/' + (st.next - 1) }; st.issues.push(i); return i; }
    if (method === 'PATCH' && (m = /\/issues\/(\d+)$/.exec(url))) { const i = st.issues.find((x) => x.number === +m[1]); Object.assign(i, body); return i; }
    if (method === 'POST' && (m = /\/issues\/(\d+)\/comments$/.exec(url))) { st.comments.push({ issue: +m[1], body: body.body }); return { id: st.comments.length }; }
    throw new Error('unexpected ' + method + ' ' + url);
  }
  st.gh = gh; return st;
}

function mkEnv(base, extra) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-ws-'));
  return Object.assign({}, GIT_ENV, { PUSHY_WATCH_BASE_URL: 'file://' + base, GITHUB_REPOSITORY: 'me/mine', GITHUB_WORKSPACE: ws, GITHUB_OUTPUT: path.join(ws, 'out.txt'), GITHUB_RUN_ID: '42', GITHUB_SERVER_URL: 'https://github.com' }, extra || {});
}
function inputs(map) { return (name) => (name in map ? map[name] : ''); }

test('parseRepos: formats, comments, dedupe, refs, errors', () => {
  const r = watch.parseRepos('# my deps\nanthropics/skills\nhttps://github.com/Foo/Bar.git@release/1.x  # note\nfoo/bar@release/1.x, baz/qux\nANTHROPICS/skills\n');
  assert.deepEqual(r.map((x) => x.key), ['anthropics/skills', 'foo/bar@release/1.x', 'baz/qux']);
  assert.equal(r[1].ref, 'release/1.x');
  assert.throws(() => watch.parseRepos('not a repo'), /Not a repository/);
  assert.throws(() => watch.parseRepos('a/b@--upload-pack=x'), /Bad ref/);
  assert.throws(() => watch.parseRepos('a/b@x..y'), /Bad ref/);
  assert.throws(() => watch.parseRepos(Array.from({ length: 26 }, (_, i) => 'o/r' + i).join('\n')), /Too many/);
  assert.deepEqual(watch.parseRepos(''), []);
});

test('readConfig: defaults and validation', () => {
  const c = watch.readConfig(inputs({ repos: 'a/b' }));
  assert.equal(c.dropThreshold, 5); assert.equal(c.alertSeverity, 'critical'); assert.equal(c.alertBelow, null); assert.equal(c.label, 'pushy-watch'); assert.equal(c.dryRun, false);
  assert.throws(() => watch.readConfig(inputs({ repos: 'a/b', 'alert-severity': 'low' })), /alert-severity/);
  assert.throws(() => watch.readConfig(inputs({ repos: 'a/b', 'drop-threshold': 'x' })), /drop-threshold/);
  assert.equal(watch.readConfig(inputs({ repos: 'a/b', 'alert-below': '70', 'dry-run': 'true' })).alertBelow, 70);
});

const cfg = { dropThreshold: 5, alertSeverity: 'critical', alertBelow: null };
const cur = (o) => Object.assign({ status: 'ok', score: 90, findings: [], fp: [] }, o);

test('diffRepo: first sight, drop, small drop, new critical, known critical, below line, error', () => {
  assert.deepEqual(watch.diffRepo(undefined, cur(), cfg), []);
  assert.deepEqual(watch.diffRepo({ score: 90, fp: [] }, cur({ score: 86 }), cfg), []);
  assert.deepEqual(watch.diffRepo({ score: 90, fp: [] }, cur({ score: 85 }), cfg).map((a) => a.type), ['drop']);
  assert.deepEqual(watch.diffRepo({ score: 90, fp: [] }, cur({ score: 95 }), cfg), []);
  const crit = { id: 'S001', sev: 'critical', fp: 'aaaaaaaa', path: 'a', line: 1 }, high = { id: 'X001', sev: 'high', fp: 'bbbbbbbb', path: 'b', line: 1 };
  assert.deepEqual(watch.diffRepo({ score: 90, fp: [] }, cur({ findings: [crit, high] }), cfg).map((a) => a.type), ['new']);
  assert.equal(watch.diffRepo({ score: 90, fp: [] }, cur({ findings: [crit, high] }), cfg)[0].findings.length, 1, 'high ignored at critical threshold');
  assert.equal(watch.diffRepo({ score: 90, fp: [] }, cur({ findings: [crit, high] }), Object.assign({}, cfg, { alertSeverity: 'high' }))[0].findings.length, 2);
  assert.deepEqual(watch.diffRepo({ score: 90, fp: ['aaaaaaaa'] }, cur({ findings: [crit] }), cfg), []);
  const below = Object.assign({}, cfg, { alertBelow: 70, dropThreshold: 50 });
  assert.deepEqual(watch.diffRepo({ score: 75, fp: [] }, cur({ score: 65 }), below).map((a) => a.type), ['below']);
  assert.deepEqual(watch.diffRepo({ score: 60, fp: [] }, cur({ score: 55 }), below), [], 'already under the line: no repeat');
  assert.deepEqual(watch.diffRepo({ score: 90, fp: [] }, { status: 'error', error: 'gone' }, cfg).map((a) => a.type), ['error']);
  assert.deepEqual(watch.diffRepo({ error: 'gone', score: 90, fp: [] }, { status: 'error', error: 'gone' }, cfg), [], 'only the transition alerts');
  assert.deepEqual(watch.diffRepo({ score: 90, fp: [] }, cur({ score: 10, findings: [crit] }), cfg, true), [], 'rebaseline after a ruleset change');
});

test('state round-trips through the issue body; hostile text cannot break out', () => {
  const evil = { key: 'a/b', owner: 'a', repo: 'b', ref: '', status: 'ok', score: 40, band: 'red', sha: 'abc1234def', counts: { critical: 1, high: 0 }, fp: ['deadbeef'], capped: true,
    findings: [{ id: 'S001', sev: 'critical', title: 'AWS access key', path: 'x`\n@octocat [click](javascript:alert(1))|<img>.sh', line: 3, fp: 'deadbeef' }],
    alerts: [{ type: 'new', findings: [{ id: 'S001', sev: 'critical', title: 'AWS access key', path: 'x`\n@octocat [click](javascript:alert(1))|<img>.sh', line: 3, fp: 'deadbeef' }] }] };
  const state = watch.buildState([evil], '1.1.0', Date.parse('2026-11-04T06:00:00Z'));
  const body = watch.renderIssueBody([evil], null, state, { now: Date.parse('2026-11-04T06:00:00Z'), ruleset: '1.1.0', dropThreshold: 5, alertSeverity: 'critical' });
  assert.match(body, /^<!-- pushy-watch -->/);
  assert.deepEqual(watch.decodeState(body).repos['a/b'], { score: 40, band: 'red', sha: 'abc1234def', fp: ['deadbeef'], at: '2026-11-04T06:00:00.000Z' });
  assert.match(body, /Automated scan, not an audit · Pushy needs no token/);
  const alert = watch.renderAlertComment([evil], Date.parse('2026-11-04T06:00:00Z'), 'https://github.com/me/mine/actions/runs/1');
  assert.match(alert, /^<!-- pushy-watch-alert -->/);
  assert.match(alert, /New \*\*critical\*\* finding `S001`: AWS access key/);
  assert.ok(!/\n@octocat/.test(alert) && !alert.includes('snippet'));
  assert.ok(!/\[click\]\(javascript/.test(alert.replace(/`[^`]*`/g, '')), 'path stays inside a code span');
  assert.equal(alert.split('\n').filter((l) => /octocat/.test(l)).length, 1, 'newline in the path cannot start a new line');
  assert.equal(watch.decodeState('no state here'), null);
  assert.equal(watch.decodeState('<!-- pushy-watch-state:@@@ -->'), null);
});

test('cloneRepo: shallow clone from a local remote; missing repo gives a clean error', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-base-'));
  makeRemote(base, 'acme/clean', 'clean');
  const env = mkEnv(base);
  const dest = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pw-d-')), 'repo');
  const got = watch.cloneRepo({ owner: 'acme', repo: 'clean', ref: '' }, dest, { env });
  assert.match(got.sha, /^[0-9a-f]{40}$/);
  assert.ok(fs.existsSync(path.join(dest, 'SKILL.md')));
  assert.throws(() => watch.cloneRepo({ owner: 'acme', repo: 'nope', ref: '' }, path.join(os.tmpdir(), 'pw-x-' + Date.now()), { env }), (e) => e.code === 'CLONE' && /could not clone/.test(e.message));
  assert.throws(() => watch.cloneRepo({ owner: 'acme', repo: 'clean', ref: 'no-such-branch' }, path.join(os.tmpdir(), 'pw-y-' + Date.now()), { env }), (e) => e.code === 'CLONE');
});

test('run: baseline, then a repo turns evil -> alert comment, then quiet; dry-run and failures', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-base-'));
  const good = makeRemote(base, 'acme/good', 'clean');
  makeRemote(base, 'acme/bad', 'evil');
  const api = fakeApi();
  const env = mkEnv(base);
  const common = { repos: 'acme/good\nacme/bad\nacme/missing', 'github-token': 'tok_secret_123', 'issue-label': 'pushy-watch' };
  const exec = (extra, e) => watch.run({ env: e || env, input: inputs(Object.assign({}, common, extra)), gh: api.gh, now: Date.parse('2026-11-04T06:00:00Z') });

  // run 1: baseline
  let out = await exec({});
  assert.equal(out.alerts, 0, 'first run is baseline only');
  assert.equal(api.issues.length, 1); assert.equal(api.comments.length, 0);
  assert.deepEqual(api.issues[0].labels, ['pushy-watch']);
  const byKey = Object.fromEntries(out.results.map((r) => [r.key, r]));
  assert.ok(byKey['acme/good'].score >= 85 && byKey['acme/bad'].score < 45);
  assert.equal(byKey['acme/missing'].status, 'error'); assert.match(byKey['acme/missing'].error, /could not clone/);
  assert.match(api.issues[0].body, /acme\/missing.*could not clone/);
  assert.ok(!JSON.stringify(api.issues[0]).includes('tok_secret_123'), 'token never lands in the issue');
  assert.equal(fs.readFileSync(env.GITHUB_OUTPUT, 'utf8').includes('alerts=0'), true);
  assert.ok(fs.existsSync(path.join(env.GITHUB_WORKSPACE, 'pushy-watch-report.json')));

  // run 2: unchanged -> no alert, issue body updated in place, no new issue
  out = await exec({});
  assert.equal(out.alerts, 0); assert.equal(api.issues.length, 1); assert.equal(api.comments.length, 0);

  // run 3: "good" repo ships an AWS key + curl|bash + prompt override
  fs.copyFileSync(path.join(FIX, 'evil', 'SKILL.md'), path.join(good.work, 'SKILL.md'));
  fs.mkdirSync(path.join(good.work, 'scripts'), { recursive: true });
  fs.copyFileSync(path.join(FIX, 'evil', 'scripts', 'setup.sh'), path.join(good.work, 'scripts', 'setup.sh'));
  good.push();
  const env3 = mkEnv(base);
  out = await exec({}, env3);
  assert.ok(out.alerts >= 2, 'drop + new critical, got ' + out.alerts);
  assert.equal(api.comments.length, 1);
  const c = api.comments[0].body;
  assert.match(c, /acme\/good/); assert.match(c, /Score dropped/); assert.match(c, /New \*\*critical\*\* finding `S001`/);
  assert.ok(!/acme\/bad/.test(c.split('\n').filter((l) => /^\*\*\[/.test(l)).join('')), 'unchanged repo is not in the alert');
  assert.ok(!c.includes('AKIA'), 'no snippet quoted');
  assert.match(api.issues[0].body, /Alerts in the latest run/);
  assert.equal(watch.decodeState(api.issues[0].body).repos['acme/good'].score < 50, true);

  // run 4: same state again -> quiet (baseline moved)
  out = await exec({}, mkEnv(base));
  assert.equal(out.alerts, 0); assert.equal(api.comments.length, 1);

  // closed issue is reopened on a new alert
  api.issues[0].state = 'closed';
  fs.appendFileSync(path.join(good.work, 'README.md'), '\nmore\n');
  fs.writeFileSync(path.join(good.work, '.env'), 'OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz0123456789ABCDEF\n');
  good.push();
  out = await exec({ 'alert-severity': 'high' }, mkEnv(base));
  assert.ok(out.alerts >= 1 && api.issues[0].state === 'open' && api.comments.length === 2, JSON.stringify(out.results.find((r) => r.key === 'acme/good').alerts).slice(0, 300));

  // dry run: scans, reads baseline, writes nothing
  const before = api.calls.length;
  out = await exec({ 'dry-run': 'true', 'drop-threshold': '1' }, mkEnv(base));
  assert.ok(api.calls.slice(before).every((l) => l.startsWith('GET ')), api.calls.slice(before).join('\n'));
  assert.equal(api.comments.length, 2);

  // fail-on-alert sets exit code
  const savedExit = process.exitCode;
  api.issues[0].body = api.issues[0].body.replace(/<!-- pushy-watch-state:[^ ]+ -->/, (m) => { const s = watch.decodeState(api.issues[0].body); s.repos['acme/bad'].score = 99; return watch.encodeState(s); });
  out = await exec({ 'fail-on-alert': 'true' }, mkEnv(base));
  assert.equal(out.exitCode, 1); assert.ok(out.alerts >= 1);
  process.exitCode = savedExit;
});

test('run: ruleset change only re-baselines; missing token and empty list are errors', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-base-'));
  makeRemote(base, 'acme/bad', 'evil');
  const api = fakeApi(), env = mkEnv(base);
  const go = (extra, e) => watch.run({ env: e || env, input: inputs(Object.assign({ repos: 'acme/bad', 'github-token': 't' }, extra)), gh: api.gh, now: 1 });
  await go({});
  const st = watch.decodeState(api.issues[0].body); st.ruleset = '0.9.0'; st.repos['acme/bad'].score = 99; st.repos['acme/bad'].fp = [];
  api.issues[0].body = api.issues[0].body.replace(/<!-- pushy-watch-state:[^ ]+ -->/, watch.encodeState(st));
  const out = await go({}, mkEnv(base));
  assert.equal(out.alerts, 0); assert.match(api.issues[0].body, /ruleset changed/);
  await assert.rejects(go({ 'github-token': '' }, Object.assign(mkEnv(base), { GITHUB_TOKEN: '' })), /needs github-token/);
  await assert.rejects(go({ repos: '' }), /repos is empty/);
});

test('index.js dispatches to watch mode only when repos is set', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'action', 'index.js'), 'utf8');
  assert.match(src, /input\('repos'\)/);
  const yml = fs.readFileSync(path.join(__dirname, '..', 'action.yml'), 'utf8');
  for (const k of ['repos', 'drop-threshold', 'alert-severity', 'alert-below', 'issue-label', 'issue-title', 'dry-run', 'fail-on-alert', 'read-token', 'alerts', 'issue-url']) assert.ok(new RegExp('^  ' + k + ':', 'm').test(yml), k);
});
